import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import { BusyError, ProgramRunner } from "../src/program/runner.ts";

function makeRunner(globals: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  let aborts = 0;
  const runner = new ProgramRunner({
    globals: () => globals,
    events: () => emitter,
    onAbort: () => aborts++,
  });
  return { runner, emitter, aborts: () => aborts };
}

// Program code runs synchronously up to its first await, so its timers exist as soon as run() returns a promise.
describe("ProgramRunner", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval"] }));
  afterEach(() => mock.timers.reset());

  it("returns the program value and its logs", async () => {
    const { runner } = makeRunner({ answer: 41 });
    const run = await runner.run(`log("hi", { a: 1 }); console.log("there"); return answer + 1;`);
    assert.equal(run.status, "ok");
    assert.equal(run.result, 42);
    assert.equal(run.logs, "hi { a: 1 }\nthere");
  });

  it("reports a thrown error with the program's own line number", async () => {
    const { runner } = makeRunner();
    const run = await runner.run(`const a = 1;\nthrow new Error("boom");`);
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /^Error: boom/);
    assert.match(run.error ?? "", /program\.js:2/);
  });

  it("reports a syntax error instead of throwing", async () => {
    const { runner } = makeRunner();
    const run = await runner.run(`return (;`);
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /SyntaxError/);
  });

  it("times out a hung program, rejects its sleep, halts the body, and frees the runner", async () => {
    const { runner, aborts } = makeRunner();
    const pending = runner.run(`globalThis.reached = false; await sleep(10_000); globalThis.reached = true;`, 50);
    mock.timers.tick(50);
    assert.equal((await pending).status, "timeout");
    assert.equal(aborts(), 1);
    assert.equal(runner.running, null);
    mock.timers.tick(10_000);
    assert.equal((await runner.run(`return globalThis.reached;`)).result, false);
  });

  it("stop() aborts the running program with status stopped", async () => {
    const { runner } = makeRunner();
    const pending = runner.run(`while (!signal.aborted) await sleep(5);`);
    assert.equal(runner.stop(), true);
    assert.equal((await pending).status, "stopped");
    assert.equal(runner.stop(), false);
  });

  it("rejects a second program while one runs", async () => {
    const { runner } = makeRunner();
    const pending = runner.run(`await sleep(30);`);
    await assert.rejects(runner.run(`return 1;`), BusyError);
    mock.timers.tick(30);
    assert.equal((await pending).status, "ok");
  });

  it("does not stay busy when globals cannot be resolved", async () => {
    let connected = false;
    const runner = new ProgramRunner({
      globals: () => {
        if (!connected) throw new Error("not connected");
        return {};
      },
    });
    await assert.rejects(runner.run(`return 1;`), /not connected/);
    connected = true;
    assert.equal((await runner.run(`return 1;`)).result, 1);
  });

  it("keeps globalThis state between programs", async () => {
    const { runner } = makeRunner();
    await runner.run(`globalThis.count = 1; globalThis.inc = () => ++globalThis.count;`);
    assert.equal((await runner.run(`return inc();`)).result, 2);
  });

  it("clears program timers and event subscriptions when the program ends", async () => {
    const { runner, emitter } = makeRunner();
    const pending = runner.run(`
      globalThis.ticks = 0; globalThis.heard = 0;
      setInterval(() => globalThis.ticks++, 5);
      on("ping", () => globalThis.heard++);
      await sleep(30);
    `);
    mock.timers.tick(30);
    assert.equal((await pending).status, "ok");
    assert.equal(emitter.listenerCount("ping"), 0);
    emitter.emit("ping");
    const before = (await runner.run(`return globalThis.ticks;`)).result;
    assert.ok(typeof before === "number" && before > 0);
    mock.timers.tick(30);
    assert.deepEqual((await runner.run(`return [globalThis.ticks, globalThis.heard];`)).result, [before, 0]);
  });

  it("returns an inspected string for values that are not JSON-safe", async () => {
    const { runner } = makeRunner();
    const run = await runner.run(`const a = { name: "loop" }; a.self = a; return a;`);
    assert.equal(typeof run.result, "string");
    assert.match(String(run.result), /\[Circular \*1\]/);
  });

  it("truncates logs beyond the byte cap", async () => {
    const runner = new ProgramRunner({ globals: () => ({}), maxLogBytes: 20 });
    const run = await runner.run(`for (let i = 0; i < 10; i++) log("0123456789");`);
    assert.equal(run.logs, "0123456789\n[logs truncated at 20 bytes]");
  });
});

// An aborted program gets a grace to settle; one that does not ends the run as hung, and the host is restarted.
describe("restart: ProgramRunner after an abort", () => {
  const GRACE_MS = 80;
  const HUNG_ERROR = restartedError(hungCause(GRACE_MS));
  const hungRunner = () => new ProgramRunner({ globals: () => ({}), graceMs: GRACE_MS });

  it("returns a program that settles within the grace exactly as before, without the hung flag", async () => {
    const runner = hungRunner();
    const pending = runner.run(`try { await sleep(60_000); } catch { await sleep(0).catch(() => {}); }`);
    runner.stop();
    const run = await pending;
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "stopped", result: undefined, error: undefined, logs: "", durationMs: 0 });
    assert.ok(!("hung" in run));
    assert.equal(runner.running, null);
  });

  it("returns what a program that settles in its grace had logged when it was aborted, as before", async () => {
    const runner = hungRunner();
    const pending = runner.run(`log("working"); try { await sleep(60_000); } catch (err) { log("cleaning up"); }`);
    runner.stop();
    const run = await pending;
    assert.equal(run.status, "stopped");
    assert.equal(run.logs, "working");
    assert.ok(!("hung" in run));
  });

  it("reports a program that never settles as hung after the grace, with the logs it wrote and the abort's status", async () => {
    const runner = hungRunner();
    const pending = runner.run(`log("before"); await new Promise(() => {});`);
    const t0 = performance.now();
    runner.stop();
    const run = await pending;
    const took = performance.now() - t0;
    assert.ok(took >= GRACE_MS - 10 && took < GRACE_MS + 1000, `the run ended after ${took} ms`);
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "stopped", result: undefined, error: HUNG_ERROR, logs: "before", durationMs: 0, hung: true });
    assert.equal(runner.running, null, "the runner is free once the run has ended");
  });

  it("reports a timed-out program that never settles as hung with status timeout", async () => {
    const runner = hungRunner();
    const run = await runner.run(`for (;;) await new Promise((resolve) => setTimeout(resolve, 5));`, 30);
    assert.equal(run.status, "timeout");
    assert.equal(run.hung, true);
    assert.equal(run.error, HUNG_ERROR);
  });

  it("treats a program waiting on a raw timer as hung: the timer is cleared at the abort", async () => {
    const runner = hungRunner();
    const pending = runner.run(`await new Promise((resolve) => setTimeout(resolve, 60_000));`);
    runner.stop();
    assert.equal((await pending).hung, true);
  });

  it("stays busy until the grace has passed, then accepts the next run right after a stop (no 409)", async () => {
    const runner = hungRunner();
    const pending = runner.run(`await new Promise(() => {});`);
    runner.stop();
    await assert.rejects(runner.run(`return 1;`), BusyError);
    await pending;
    assert.equal((await runner.run(`return 1;`)).result, 1);

    const settling = runner.run(`while (!signal.aborted) await sleep(5);`);
    runner.stop();
    await settling;
    assert.equal((await runner.run(`return 2;`)).result, 2);
  });
});

// A routine call is a run: it shares the lifecycle of `run(code)` (one entry at a time, abort, timeout, grace, hung).
describe("ProgramRunner.call", () => {
  const sourceDir = "/nonexistent/routines";
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval"] }));
  afterEach(() => mock.timers.reset());

  it("returns the function's value as JSON, its logs through the scope, and its duration", async () => {
    const { runner } = makeRunner();
    const run = await runner.call(
      async (scope) => {
        scope.log("hi", { a: 1 });
        return { big: 5n, gone: undefined, n: 1 };
      },
      { sourceDir },
    );
    assert.equal(typeof run.durationMs, "number");
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "ok", result: { big: "5", n: 1 }, error: undefined, logs: "hi { a: 1 }", durationMs: 0 });
    assert.equal(runner.running, null);
  });

  it("returns an inspected string for values that are not JSON-safe", async () => {
    const { runner } = makeRunner();
    const run = await runner.call(async () => {
      const a: Record<string, unknown> = { name: "loop" };
      a.self = a;
      return a;
    }, { sourceDir });
    assert.match(String(run.result), /\[Circular \*1\]/);
  });

  it("reports a thrown error as status error with its message, also when the function throws before returning a promise", async () => {
    const { runner } = makeRunner();
    const run = await runner.call(async () => {
      throw new Error("boom");
    }, { sourceDir });
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /^Error: boom/);
    const sync = await runner.call(() => {
      throw new Error("sync boom");
    }, { sourceDir });
    assert.equal(sync.status, "error");
    assert.match(sync.error ?? "", /^Error: sync boom/);
    assert.equal(runner.running, null);
  });

  it("rejects a call while a program runs and a program while a call runs", async () => {
    const { runner } = makeRunner();
    const program = runner.run(`await sleep(30);`);
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    mock.timers.tick(30);
    assert.equal((await program).status, "ok");

    const call = runner.call(async ({ sleep }) => sleep(30), { sourceDir });
    await assert.rejects(runner.run(`return 1;`), BusyError);
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    mock.timers.tick(30);
    assert.equal((await call).status, "ok");
    assert.equal((await runner.run(`return 1;`)).result, 1);
  });

  it("times out a call, rejects its sleep, halts the body, and frees the runner", async () => {
    const { runner, aborts } = makeRunner();
    const pending = runner.call(async ({ sleep }) => sleep(10_000), { timeoutMs: 50, sourceDir });
    mock.timers.tick(50);
    assert.equal((await pending).status, "timeout");
    assert.equal(aborts(), 1);
    assert.equal(runner.running, null);
  });

  it("stop() aborts a call with status stopped", async () => {
    const { runner } = makeRunner();
    const pending = runner.call(async ({ sleep, signal }) => {
      while (!signal.aborted) await sleep(5);
    }, { sourceDir });
    assert.equal(runner.stop(), true);
    assert.equal((await pending).status, "stopped");
    assert.equal(runner.stop(), false);
  });

  it("subscribes through the scope's on and removes the subscription when the call ends", async () => {
    const { runner, emitter } = makeRunner();
    let heard = 0;
    const pending = runner.call(async ({ on, sleep }) => {
      on("ping", () => heard++);
      await sleep(30);
    }, { sourceDir });
    emitter.emit("ping");
    mock.timers.tick(30);
    assert.equal((await pending).status, "ok");
    emitter.emit("ping");
    assert.equal(heard, 1);
    assert.equal(emitter.listenerCount("ping"), 0);
  });
});

describe("restart: ProgramRunner.call after an abort", () => {
  const GRACE_MS = 80;
  const HUNG_ERROR = restartedError(hungCause(GRACE_MS));
  const sourceDir = "/nonexistent/routines";
  const hungRunner = () => new ProgramRunner({ globals: () => ({}), graceMs: GRACE_MS });

  it("returns a call that settles within the grace as stopped, without the hung flag", async () => {
    const runner = hungRunner();
    const pending = runner.call(async ({ log, sleep }) => {
      log("working");
      try {
        await sleep(60_000);
      } catch {
        await sleep(0).catch(() => {});
      }
    }, { sourceDir });
    runner.stop();
    const run = await pending;
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "stopped", result: undefined, error: undefined, logs: "working", durationMs: 0 });
    assert.ok(!("hung" in run));
  });

  it("reports a call that never settles as hung after the grace, with its logs and the abort's status", async () => {
    const runner = hungRunner();
    const pending = runner.call(async ({ log }) => {
      log("before");
      await new Promise(() => {});
    }, { sourceDir });
    const t0 = performance.now();
    runner.stop();
    const run = await pending;
    const took = performance.now() - t0;
    assert.ok(took >= GRACE_MS - 10 && took < GRACE_MS + 1000, `the run ended after ${took} ms`);
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "stopped", result: undefined, error: HUNG_ERROR, logs: "before", durationMs: 0, hung: true });
    assert.equal(runner.running, null);
  });

  it("keeps a timed-out call that never settles busy for the grace, then reports it hung with status timeout", async () => {
    const runner = hungRunner();
    const pending = runner.call(() => new Promise(() => {}), { timeoutMs: 30, sourceDir });
    runner.stop();
    await assert.rejects(runner.run(`return 1;`), BusyError);
    assert.equal((await pending).hung, true);
    assert.equal((await runner.run(`return 1;`)).result, 1);
  });

  it("reports a call that times out and never settles as hung with status timeout", async () => {
    const runner = hungRunner();
    const run = await runner.call(() => new Promise(() => {}), { timeoutMs: 30, sourceDir });
    assert.equal(run.status, "timeout");
    assert.equal(run.hung, true);
    assert.equal(run.error, HUNG_ERROR);
  });
});
