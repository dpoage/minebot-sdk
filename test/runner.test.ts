import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import { BusyError, ProgramRunner } from "../src/program/runner.ts";

const RUNNER_URL = pathToFileURL(path.join(import.meta.dirname, "..", "src", "program", "runner.ts")).href;

function makeRunner() {
  const emitter = new EventEmitter();
  let aborts = 0;
  const runner = new ProgramRunner({
    events: () => emitter,
    halt: () => aborts++,
  });
  return { runner, emitter, aborts: () => aborts };
}

describe("ProgramRunner", () => {
  it("truncates logs beyond the byte cap", async () => {
    const runner = new ProgramRunner({ maxLogBytes: 20 });
    const run = await runner.call(async ({ log }) => { for (let i = 0; i < 10; i++) log("0123456789"); }, { sourceDir: "/nonexistent/routines" });
    assert.equal(run.logs, "0123456789\n[logs truncated at 20 bytes]");
  });
});

// A run is one entry at a time with abort, timeout, grace, and hung: a routine call, a module run, and a reflex firing all go through `call`.
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

  it("rejects a call while another call runs", async () => {
    const { runner } = makeRunner();
    const first = runner.call(async ({ sleep }) => sleep(30), { sourceDir });
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    mock.timers.tick(30);
    assert.equal((await first).status, "ok");

    const second = runner.call(async ({ sleep }) => sleep(30), { sourceDir });
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    mock.timers.tick(30);
    assert.equal((await second).status, "ok");
    assert.equal((await runner.call(async () => 1, { sourceDir })).result, 1);
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

// An aborted program gets a grace to settle; one that does not ends the run as hung, and the host is restarted.
describe("restart: ProgramRunner.call after an abort", () => {
  const GRACE_MS = 80;
  const HUNG_ERROR = restartedError(hungCause(GRACE_MS));
  const sourceDir = "/nonexistent/routines";
  const hungRunner = () => new ProgramRunner({ graceMs: GRACE_MS });

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
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    assert.equal((await pending).hung, true);
    assert.equal((await runner.call(async () => 1, { sourceDir })).result, 1);
  });

  it("reports a call that times out and never settles as hung with status timeout", async () => {
    const runner = hungRunner();
    const run = await runner.call(() => new Promise(() => {}), { timeoutMs: 30, sourceDir });
    assert.equal(run.status, "timeout");
    assert.equal(run.hung, true);
    assert.equal(run.error, HUNG_ERROR);
  });

  it("stays busy until the grace has passed, then accepts the next run right after a stop (no 409)", async () => {
    const runner = hungRunner();
    const pending = runner.call(() => new Promise(() => {}), { sourceDir });
    runner.stop();
    await assert.rejects(runner.call(async () => 1, { sourceDir }), BusyError);
    await pending;
    assert.equal((await runner.call(async () => 1, { sourceDir })).result, 1);

    const settling = runner.call(async ({ signal, sleep }) => {
      while (!signal.aborted) await sleep(5);
    }, { sourceDir });
    runner.stop();
    await settling;
    assert.equal((await runner.call(async () => 2, { sourceDir })).result, 2);
  });
});

// During a run, console output is the run's log as well as what it was: the previous methods keep writing, and are put back when the runner is free.
describe("ProgramRunner.call and the console", () => {
  const sourceDir = "/nonexistent/routines";
  const METHODS = ["log", "info", "warn", "error", "debug"] as const;
  /** Replaces each console method with a recorder for the test, and puts the real ones back. */
  function recording() {
    const real = METHODS.map((method) => [method, console[method]] as const);
    const written: string[] = [];
    for (const method of METHODS) console[method] = (...args: unknown[]) => void written.push(`${method}:${args.join(" ")}`);
    const recorders = METHODS.map((method) => console[method]);
    return {
      written,
      recorders,
      restore() {
        for (const [method, write] of real) console[method] = write;
      },
    };
  }

  it("appends what console.log, info, warn, error, and debug write to the run's log, and still writes it where it went", async () => {
    const seen = recording();
    try {
      const run = await new ProgramRunner().call(async () => {
        console.log("a", 1);
        console.info("b");
        console.warn("c");
        console.error("d");
        console.debug("e");
      }, { sourceDir });
      assert.equal(run.logs, "a 1\nb\nc\nd\ne");
      assert.deepEqual(seen.written, ["log:a 1", "info:b", "warn:c", "error:d", "debug:e"]);
    } finally {
      seen.restore();
    }
  });

  it("keeps the order of ctx.log and console output in one log", async () => {
    const seen = recording();
    try {
      const run = await new ProgramRunner().call(async ({ log }) => {
        log("one");
        console.log("two");
        log("three");
      }, { sourceDir });
      assert.equal(run.logs, "one\ntwo\nthree");
    } finally {
      seen.restore();
    }
  });

  it("writes between runs where it wrote before, and puts the previous methods back when the run ends, whatever its status", async () => {
    const seen = recording();
    try {
      const runner = new ProgramRunner({ graceMs: 40 });
      console.log("before");
      assert.deepEqual(METHODS.map((method) => console[method]), seen.recorders, "a method was replaced while no run executes");
      await runner.call(async () => {
        console.log("during");
        assert.notEqual(console.log, seen.recorders[0], "no run's tee is installed while it executes");
      }, { sourceDir });
      assert.deepEqual(METHODS.map((method) => console[method]), seen.recorders, "ok: the previous methods are not back");
      await runner.call(async () => {
        throw new Error("boom");
      }, { sourceDir });
      assert.deepEqual(METHODS.map((method) => console[method]), seen.recorders, "error: the previous methods are not back");
      const stopped = runner.call(async ({ sleep }) => sleep(60_000), { sourceDir });
      runner.stop();
      await stopped;
      assert.deepEqual(METHODS.map((method) => console[method]), seen.recorders, "stopped: the previous methods are not back");
      const hung = runner.call(() => new Promise(() => {}), { sourceDir });
      runner.stop();
      assert.equal((await hung).hung, true);
      assert.deepEqual(METHODS.map((method) => console[method]), seen.recorders, "hung: the previous methods are not back");
      console.log("after");
      assert.deepEqual(seen.written, ["log:before", "log:during", "log:after"]);
      // What a later run logs is its own.
      const next = await runner.call(async () => void console.log("next"), { sourceDir });
      assert.equal(next.logs, "next");
    } finally {
      seen.restore();
    }
  });

  it("appends the output of a program that logs in its grace after the abort, and not after the run has ended", async () => {
    const seen = recording();
    try {
      const runner = new ProgramRunner({ graceMs: 60 });
      const pending = runner.call(async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        console.log("in the grace");
        await new Promise(() => {});
      }, { sourceDir });
      await Promise.resolve();
      runner.stop();
      const run = await pending;
      assert.equal(run.hung, true);
      assert.equal(run.logs, "in the grace");
      console.log("after the run");
      assert.deepEqual(seen.written, ["log:in the grace", "log:after the run"]);
    } finally {
      seen.restore();
    }
  });

  it("reaches the process's stderr from a run, and the run's log, and only stderr when no run executes", () => {
    const script = `
      import { ProgramRunner } from ${JSON.stringify(RUNNER_URL)};
      console.error("idle before");
      const run = await new ProgramRunner().call(async () => { console.error("during"); console.warn("warned"); }, { sourceDir: "/" });
      console.error("idle after");
      process.stdout.write(JSON.stringify(run.logs));
    `;
    const child = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", "--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, JSON.stringify("during\nwarned"));
    assert.equal(child.stderr, "idle before\nduring\nwarned\nidle after\n");
  });
});
