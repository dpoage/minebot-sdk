// The body's run slot (mb-9h3), through the real bot host over a fake player (see
// fixtures/host/fake-body.ts: the real supervisor HostProcess, Body, Triggers, RunReporter, and
// runner): a call that arrives while another run holds the slot, its preemption's grace included,
// is answered 409 at once, however late the supervisor's history would write its start, and the
// reflex that preempted the run starts before any request that arrived after the preemption.
// The timings are real on purpose: the race is between the host's clock and the supervisor's history write.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult } from "../src/protocol/index.ts";
import { removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

// Loaded after the fake body, which sets MINEBOT_RUNTIME_DIR before anything reaches the discovery module; the history is
// the same module instance the fake body's supervisor builds its history from.
const { ProgramHistory } = await import("../src/body/history.ts");
const { BusyError } = await import("../src/program/runner.ts");

after(removeScratch);

/** How late the supervisor's history writes the start of a call of `b`, as a slow disk or a loaded supervisor makes it. */
let lateMs = 0;
const begin = ProgramHistory.prototype.begin;
ProgramHistory.prototype.begin = async function (this: InstanceType<typeof ProgramHistory>, code, extra) {
  if (lateMs > 0 && (extra as { call?: { name?: string } } | undefined)?.call?.name === "b") await sleep(lateMs);
  return begin.call(this, code, extra);
};

/** Catches its preemption's abort, settles `settleMs` later (inside the grace), and returns "a". */
const preempted = (settleMs: number) =>
  `export default async (ctx) => {\n  try {\n    await ctx.sleep(60_000);\n  } catch {}\n  await new Promise((resolve) => setTimeout(resolve, ${settleMs}));\n  return "a";\n};\n`;

describe("a call that arrives while a preempted run is in its grace", () => {
  // `settleMs`: how long after its abort `a` settles; `postMs`: how long after the reflex's event `b` is posted; `lateMs`: how late b's start would be written.
  const legs = [
    { settleMs: 300, postMs: 100, lateMs: 0 },
    { settleMs: 60, postMs: 20, lateMs: 80 },
    { settleMs: 300, postMs: 100, lateMs: 400 },
  ];
  for (const leg of legs) {
    it(`is answered 409 and never runs ahead of the preempting reflex (a settles ${leg.settleMs} ms after its abort, b posted ${leg.postMs} ms after the event, its start ${leg.lateMs} ms late)`, { timeout: 30_000 }, async () => {
      const body = await startFakeBody();
      try {
        body.writeRoutines({ a: preempted(leg.settleMs), b: 'export default () => "b";\n', flee: 'export default () => "flee";\n' });
        for (const name of ["a", "b"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
        await body.ok("POST", "/bind", { kind: "reflex", name: "flee", routine: "flee", on: ["chat"], preempt: true, cooldownMs: 0 });
        lateMs = leg.lateMs;

        const a = body.request("POST", "/call", { name: "a" });
        const deadline = Date.now() + 10_000;
        while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
        assert.ok(body.host.openRuns > 0, "a did not start");
        await sleep(100);
        body.events.push("chat", { from: "ana", message: "run" });
        await sleep(leg.postMs);
        const b = await body.request("POST", "/call", { name: "b" });
        assert.deepEqual(b, { status: 409, body: { error: new BusyError().message } });

        assert.equal(((await a).body as RunResult).status, "stopped");
        const finished = await body.waitFor("reflex_finished");
        assert.deepEqual({ name: finished.data.name, status: finished.data.status }, { name: "flee", status: "ok" });
        assert.deepEqual(body.eventsOf("reflex_fired").map((event) => event.data.preempted), [true]);
        // The order of the runs as the history has it: the preempted run, then the reflex; the refused call never reached it.
        const runs = body.history().filter((line) => line.status !== "registered");
        assert.deepEqual(
          runs.map((line) => [(line.call as { name?: string } | undefined)?.name ?? line.trigger, line.status]),
          [
            ["a", "stopped"],
            ["flee", "ok"],
          ],
        );

        // Once the reflex's run has ended, the slot is free: the same call runs.
        assert.equal(((await body.ok("POST", "/call", { name: "b" })) as RunResult).result, "b");
      } finally {
        lateMs = 0;
        await body.close();
      }
    });
  }
});
