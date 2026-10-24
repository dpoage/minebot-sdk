// What a finished run leaves behind: the `program_finished` event the supervisor pushes as it
// records the run's end — the run's seq, the call's name, the first line of the thrown error's
// message, a preview of the result — and the record of the last KEPT_RUNS finished runs, served by
// get_run (the supervisor's own GET /runs) after the caller detached. All over the real supervisor
// and bot host on a fake player (fixtures/host/fake-body.ts), the body's API on real HTTP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { type FakeBody, GRACE_MS, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

const runOf = (answer: { status: number; body: unknown }) => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

const run = (body: FakeBody, code: string, timeoutMs?: number) => body.request("POST", "/run", { code, timeoutMs });

/** The data of the last `program_finished`, with its durationMs replaced by a placeholder. */
function finishOf(body: FakeBody): Record<string, unknown> {
  const event = body.eventsOf("program_finished").at(-1);
  assert.ok(event, "no program_finished event");
  assert.equal(typeof event.data.durationMs, "number");
  return { ...event.data, durationMs: "<ms>" };
}

/** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
async function running(body: FakeBody): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
  assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
  await sleep(150);
}

async function using(options: Parameters<typeof startFakeBody>[0], test: (body: FakeBody) => Promise<void>): Promise<void> {
  const body = await startFakeBody(options);
  try {
    await test(body);
  } finally {
    await body.close();
  }
}

describe("a run's program_finished event", () => {
  it("carries the run's seq and, for a run that returned something, its result as JSON", async () => {
    await using({}, async (body) => {
      runOf(await run(body, "export default { a: 1 };"));
      assert.deepEqual(finishOf(body), { status: "ok", durationMs: "<ms>", run: 1, result: '{"a":1}' });
      // A run that returned nothing carries no result field.
      runOf(await run(body, "export const unused = 1;"));
      assert.deepEqual(finishOf(body), { status: "ok", durationMs: "<ms>", run: 2 });
    });
  });

  it("carries the first line of a thrown error's message, not of its formatted error", async () => {
    await using({}, async (body) => {
      const answer = runOf(await run(body, "throw new Error('boom');"));
      assert.match(answer.error ?? "", /^Error: boom\n/, "the run's answer carries the formatted error");
      assert.deepEqual(finishOf(body), { status: "error", durationMs: "<ms>", run: 1, error: "boom" });
    });
  });

  it("carries the parser's message for a run that does not parse, whose formatted error opens with the source location", async () => {
    await using({}, async (body) => {
      const answer = runOf(await run(body, "export default (;"));
      assert.equal(answer.status, "error");
      assert.match(String(answer.error), new RegExp(`^${RegExp.escape(path.join(body.routinesDir, ".run.ts"))}`), "the formatted error opens with the source location");
      const parserLine = /^SyntaxError: (.*)$/m.exec(String(answer.error))![1]!;
      assert.ok(parserLine.length > 0);
      assert.deepEqual(finishOf(body), { status: "error", durationMs: "<ms>", run: 1, error: parserLine });
    });
  });

  it("carries no error and no result for a run its timeout or a stop aborted", async () => {
    await using({}, async (body) => {
      const sleeper = "export default async (ctx: { sleep(ms: number): Promise<void> }) => { await ctx.sleep(30_000); };";
      runOf(await run(body, sleeper, 200));
      assert.deepEqual(finishOf(body), { status: "timeout", durationMs: "<ms>", run: 1 });
      const stopped = body.request("POST", "/run", { code: sleeper, timeoutMs: 60_000 });
      await running(body);
      assert.deepEqual(await body.host.stop(), { stopped: true });
      runOf(await stopped);
      assert.deepEqual(finishOf(body), { status: "stopped", durationMs: "<ms>", run: 2 });
    });
  });

  it("cuts the error line and the result preview to 200 characters, a cut marked with a trailing ellipsis", async () => {
    await using({}, async (body) => {
      runOf(await run(body, "export default (() => 'y'.repeat(300))();"));
      const { result } = finishOf(body);
      if (typeof result !== "string") assert.fail("the result preview is a string");
      assert.equal(result.length, 201, "the preview is 200 characters plus the ellipsis");
      assert.ok(result.endsWith("…"));
      runOf(await run(body, "throw new Error('x'.repeat(300));"));
      const { error } = finishOf(body);
      if (typeof error !== "string") assert.fail("the error preview is a string");
      assert.equal(error.length, 201);
      assert.ok(error.endsWith("…"));
    });
  });

  it("names the call a run was, on the live path and on the path whose host died mid-run", { timeout: 30_000 }, async () => {
    await using({}, async (body) => {
      body.writeRoutines({ adder: "export default async (_ctx: unknown, args: { a: number; b: number }) => ({ sum: args.a + args.b });\n" });
      await body.ok("POST", "/bind", { kind: "action", name: "adder", routine: "adder" });
      runOf(await body.request("POST", "/call", { name: "adder", args: { a: 2, b: 40 } }));
      assert.deepEqual(finishOf(body), { status: "ok", durationMs: "<ms>", run: 1, call: "adder", result: '{"sum":42}' });

      body.writeRoutines({ blocker: "export default (): never => {\n  for (;;) {}\n};\n" });
      await body.ok("POST", "/bind", { kind: "action", name: "blocker", routine: "blocker" });
      const since = body.events.since(0, 1000).next;
      const killed = body.request("POST", "/call", { name: "blocker", timeoutMs: 200 });
      assert.equal(runOf(await killed).status, "timeout");
      await body.waitFor("connected", since);
      assert.deepEqual(finishOf(body), { status: "timeout", durationMs: "<ms>", run: 2, call: "blocker", error: restartedError(hungCause(GRACE_MS)) });
    });
  });
});

describe("get_run keeps a finished run's record", () => {
  const ADDER = "export default async (_ctx: unknown, args: { a: number }) => ({ got: args.a });\n";

  /** A body with one action bound, whose runs interleave a reflex's registration and firing. */
  async function interleaved(): Promise<FakeBody> {
    const body = await startFakeBody();
    body.writeRoutines({
      adder: ADDER,
      echo: "export default () => 'hi';\n",
      chatter: "export default (ctx: { bot: { emit(event: string, ...args: unknown[]): void } }) => ctx.bot.emit('chat', 'alice', 'go');\n",
    });
    await body.ok("POST", "/bind", { kind: "action", name: "adder", routine: "adder" });
    await body.ok("POST", "/bind", { kind: "reflex", name: "listener", routine: "echo", on: ["chat"], cooldownMs: 0 });
    return body;
  }

  it("is the run's history line without its code, over HTTP and by the tool's route, with or without a seq", async () => {
    const body = await interleaved();
    try {
      runOf(await body.request("POST", "/call", { name: "adder", args: { a: 7 } }));
      runOf(await body.request("POST", "/run", { code: "export default (_ctx: unknown, args: { b: number }) => args.b;", args: { b: 5 } }));
      // The registration (seq 1) and the firing (seq 2) the chatter's chat event fires interleave with the runs.
      runOf(await run(body, "export default (ctx: { bot: { emit(event: string, ...args: unknown[]): void } }) => ctx.bot.emit('chat', 'alice', 'go');"));
      await body.waitFor("reflex_finished");
      runOf(await body.request("POST", "/call", { name: "adder", args: { a: 9 } }));

      const lines = body.history();
      assert.deepEqual(
        lines.map((line) => [line.seq, line.code !== "", line.status]),
        [
          [1, false, "registered"],
          [2, false, "ok"],
          [3, true, "ok"],
          [4, true, "ok"],
          [5, false, "ok"],
          [6, false, "ok"],
        ],
        `seqs interleave registrations, firings, and runs: ${JSON.stringify(lines)}`,
      );
      const bySeq = (seq: number) => {
        const { code: _, ...record } = lines.find((line) => line.seq === seq)!;
        return record;
      };
      // The call's record keeps its call and args; the run's its args; the firing is not kept.
      assert.deepEqual(body.host.keptRun(2), bySeq(2));
      assert.deepEqual(body.host.keptRun(4), bySeq(4));
      const overHttp = await body.http("GET", "/runs/6");
      assert.deepEqual(overHttp, { status: 200, body: bySeq(6) });
      assert.deepEqual(await body.http("GET", "/runs"), { status: 200, body: bySeq(6) }, "no seq is the most recent finished run");
      assert.deepEqual(body.host.keptRun(2).call, { name: "adder", routine: "adder", args: { a: 7 } });
      // A seq that is not a kept foreground run — a registration's, a firing's, one never taken — names the kept seqs.
      const kept = "2, 3, 4, 6";
      for (const seq of [1, 5, 9]) {
        assert.deepEqual(await body.http("GET", `/runs/${seq}`), { status: 404, body: { error: `run ${seq} is not a kept run; kept: ${kept}` } });
      }
    } finally {
      await body.close();
    }
  });

  it("numbers and keeps runs on a body started without a history file", async () => {
    await using({ history: false }, async (body) => {
      runOf(await run(body, "export default 1;"));
      runOf(await run(body, "export default 2;"));
      assert.deepEqual(body.history(), [], "no history file was written");
      assert.deepEqual(finishOf(body), { status: "ok", durationMs: "<ms>", run: 2, result: "2" });
      const record = body.host.keptRun(1);
      assert.deepEqual({ ...record, startedAt: "<t>", durationMs: "<ms>" }, { seq: 1, startedAt: "<t>", status: "ok", durationMs: "<ms>", result: 1, logs: "" });
      assert.equal(record.logs, "");
    });
  });

  it("keeps the last 20 finished runs, evicting the oldest", async () => {
    await using({}, async (body) => {
      for (let i = 1; i <= 22; i++) assert.equal(runOf(await run(body, `export default ${i};`)).result, i);
      assert.equal(body.host.keptRun(undefined).seq, 22);
      assert.equal(body.host.keptRun(3).seq, 3);
      const kept = Array.from({ length: 20 }, (_, i) => i + 3).join(", ");
      for (const seq of [1, 2]) assert.throws(() => body.host.keptRun(seq), { message: `run ${seq} is not a kept run; kept: ${kept}` });
      assert.deepEqual(await body.http("GET", "/runs/3"), { status: 200, body: body.host.keptRun(3) });
    });
  });

  it("answers a request without the body's token with 401", async () => {
    await using({}, async (body) => {
      const response = await fetch(`${body.url}/runs`);
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    });
  });
});

describe("a finished run is kept before its finish is said", () => {
  it("answers get_run, called from the event's own wake-up, with the run's record", async () => {
    await using({}, async (body) => {
      // The listener runs inside the event log's push: if the finish were said before the run was kept, this is where it shows.
      const seen: unknown[] = [];
      const stop = body.events.subscribe((event) => {
        if (event.type !== "program_finished" || typeof event.data.run !== "number") return;
        try {
          seen.push(body.host.keptRun(event.data.run));
        } catch (err) {
          seen.push(err);
        }
      });
      try {
        runOf(await run(body, "export default { kept: true };"));
      } finally {
        stop();
      }
      const record = seen[0];
      assert.ok(!(record instanceof Error), `get_run from the event's wake-up failed: ${String(record)}`);
      const line = body.history().at(-1)!;
      const { code: _, ...expected } = line;
      assert.deepEqual(record, expected);
      assert.deepEqual(finishOf(body), { status: "ok", durationMs: "<ms>", run: line.seq, result: '{"kept":true}' }, "the event names the seq of the record it precedes");
    });
  });
});

describe("minebot runs prints a finished run's record", () => {
  /** One `minebot` command against the body's HTTP API; its exit code, stdout, and stderr. */
  function cli(body: FakeBody, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const child = spawn(process.execPath, [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
      env: { ...process.env, MINEBOT_URL: body.url, MINEBOT_TOKEN: body.token },
    });
    const done = Promise.withResolvers<{ code: number; out: string; err: string }>();
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => done.resolve({ code: code ?? -1, out, err }));
    return done.promise;
  }

  it("renders the run the seq names, and the most recent without one", { timeout: 30_000 }, async () => {
    await using({}, async (body) => {
      const ok = runOf(await run(body, "export default async (ctx: { log(...a: unknown[]): void }) => { ctx.log('working'); return 42; };"));
      const failed = runOf(await run(body, "throw new Error('nope');"));
      const [okSeq, errorSeq] = [body.host.keptRun(1).seq, body.host.keptRun(2).seq];

      const good = await cli(body, "runs", String(okSeq));
      assert.equal(good.code, 0, good.err);
      assert.equal(good.out, `status: ok (${ok.durationMs} ms)\n\nlogs:\nworking\n\nresult:\n42\n`);

      const bad = await cli(body, "runs", String(errorSeq));
      assert.equal(bad.code, 2, bad.err);
      assert.match(bad.out, /^status: error \(\d+ ms\)\n\nerror:\nError: nope\n/, "the record's error is the run's own, whole formatted error");

      const latest = await cli(body, "runs");
      assert.equal(latest.code, 2, latest.err);
      assert.match(latest.out, /^status: error /, "no seq is the most recent finished run");

      const refused = await cli(body, "runs", String(okSeq + 100));
      assert.equal(refused.code, 1, refused.err);
      assert.match(refused.err, /is not a kept run; kept: /);
    });
  });
});
