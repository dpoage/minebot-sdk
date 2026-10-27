// mb-znn.3c: a run that spanned player deaths says how many (`diedDuringRun`), on both run paths (a module run or call, and a
// reflex's firing), and keeps saying so in the history line and the kept run; a run with no death has no such field.
// formatRun prints it as one line. Deaths are the fake player's `death` event, which the real Connection counts.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { formatRun } from "../src/client/render.ts";
import { removeScratch, startFakeBody, type FakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

/** A run that dies `times` times and returns. */
const dies = (times: number) => `export default (ctx) => { for (let i = 0; i < ${times}; i++) ctx.bot.emit('death'); return 'done'; };\n`;

async function withBody(test: (body: FakeBody) => Promise<void>): Promise<void> {
  const body = await startFakeBody();
  try {
    await test(body);
  } finally {
    await body.close();
  }
}

/** A run's answer, which must be 200. */
function answered(answer: { status: number; body: unknown }): Record<string, unknown> {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.ok(typeof answer.body === "object" && answer.body !== null);
  return { ...answer.body };
}

describe("diedDuringRun", { timeout: 60_000 }, () => {
  it("is the number of deaths the run spanned, and absent for a run without one", async () => {
    await withBody(async (body) => {
      assert.equal("diedDuringRun" in answered(await body.request("POST", "/run", { code: "export default 1;" })), false);
      assert.equal(answered(await body.request("POST", "/run", { code: dies(1) })).diedDuringRun, 1);
      assert.equal(answered(await body.request("POST", "/run", { code: dies(3) })).diedDuringRun, 3);
      // A death before the run does not count against it, and neither do the earlier runs'.
      const after = answered(await body.request("POST", "/run", { code: "export default 1;" }));
      assert.equal("diedDuringRun" in after, false);
    });
  });

  it("counts a death in a run that threw, and one in a run that was stopped", async () => {
    await withBody(async (body) => {
      const threw = answered(await body.request("POST", "/run", { code: "export default (ctx) => { ctx.bot.emit('death'); throw new Error('boom'); };" }));
      assert.deepEqual([threw.status, threw.diedDuringRun], ["error", 1]);
      const slow = body.request("POST", "/run", { code: "export default async (ctx) => { ctx.bot.emit('death'); await ctx.sleep(30_000); };" });
      // Its death is the proof that its code runs; the run holds the slot until it is stopped.
      await body.waitFor("death", body.eventsOf("death").at(-1)?.seq ?? 0);
      assert.equal((await body.http("POST", "/stop")).status, 200);
      const stopped = answered(await slow);
      assert.deepEqual([stopped.status, stopped.diedDuringRun], ["stopped", 1]);
    });
  });

  it("is on a call's answer", async () => {
    await withBody(async (body) => {
      body.writeRoutines({ mortal: dies(2), safe: "export default () => 1;\n" });
      for (const name of ["mortal", "safe"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
      assert.equal(answered(await body.request("POST", "/call", { name: "mortal" })).diedDuringRun, 2);
      assert.equal("diedDuringRun" in answered(await body.request("POST", "/call", { name: "safe" })), false);
    });
  });

  it("is on a reflex's firing: its history line carries the count, and a firing without a death has none", async () => {
    await withBody(async (body) => {
      body.writeRoutines({ mortal: dies(2), safe: "export default () => 1;\n" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "mortal-rfx", routine: "mortal", on: ["chat"], cooldownMs: 0 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "safe-rfx", routine: "safe", on: ["whisper"], cooldownMs: 0 });
      body.events.push("chat", { from: "ana", message: "go" });
      const first = await body.waitFor("reflex_finished");
      body.events.push("whisper", { from: "ana", message: "go" });
      await body.waitFor("reflex_finished", first.seq);
      const line = (name: string) => body.history().find((entry) => entry.trigger === name && entry.status !== "registered");
      assert.equal(line("mortal-rfx")?.diedDuringRun, 2);
      assert.ok(line("safe-rfx"), "the safe firing has no history line");
      assert.equal("diedDuringRun" in line("safe-rfx")!, false);
    });
  });

  it("survives the history line and the kept run that get_run serves", async () => {
    await withBody(async (body) => {
      const run = answered(await body.request("POST", "/run", { code: dies(2) }));
      assert.equal(run.diedDuringRun, 2);
      const written = body.history().filter((entry) => entry.status === "ok");
      assert.equal(written.at(-1)?.diedDuringRun, 2);
      const kept = await body.http("GET", "/runs");
      assert.equal(kept.status, 200);
      assert.ok(typeof kept.body === "object" && kept.body !== null && "diedDuringRun" in kept.body);
      assert.equal(kept.body.diedDuringRun, 2);
    });
  });
});

describe("formatRun", () => {
  const base = { status: "ok" as const, logs: "", durationMs: 12 };

  it("prints one line for a death, singular", () => {
    assert.equal(formatRun({ ...base, diedDuringRun: 1 }), "status: ok (12 ms)\ndied during this run (1 time); observe shows the last death");
  });

  it("prints the count for several", () => {
    assert.equal(formatRun({ ...base, diedDuringRun: 3 }), "status: ok (12 ms)\ndied during this run (3 times); observe shows the last death");
  });

  it("prints nothing for a run without a death, and keeps the line next to the status when there are logs, an error, and a result", () => {
    assert.equal(formatRun(base), "status: ok (12 ms)");
    const text = formatRun({ ...base, status: "error", logs: "hello", error: "boom", result: 7, diedDuringRun: 2 });
    assert.equal(text.split("\n")[1], "died during this run (2 times); observe shows the last death");
    assert.match(text, /logs:\nhello[\s\S]*error:\nboom[\s\S]*result:\n7/);
  });

  it("prints a kept run's death line after its name", () => {
    const text = formatRun({ ...base, seq: 4, startedAt: "2026-10-27T00:00:00Z", diedDuringRun: 1 });
    assert.equal(text, "run 4: status: ok (12 ms)\ndied during this run (1 time); observe shows the last death");
  });
});
