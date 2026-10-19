import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
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
