// A run is type-checked before the body evaluates it (RoutineLoader.run with the run's context): a source with a
// refusing diagnostic is never evaluated and ends the run with the diagnostics; a check that cannot answer is
// skipped with one log line, and the run goes on as it would without a check; a run that is aborted is never
// evaluated. The witness sets a marker on `globalThis` at the top level: it is set exactly when the module ran.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { RoutineLoader } from "../src/host/routines/loader.ts";
import { closeRunCheck } from "../src/host/typecheck.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

declare global {
  // The witness marker: the run's top level sets it, so it is set exactly when the module was evaluated.
  var __cw1: number | undefined;
}

const scratch = mkdtempSync(path.join(tmpdir(), "minebot-run-check-"));
after(async () => {
  // The warm checker's compiler child would otherwise keep this process alive.
  await closeRunCheck();
  removeScratch();
  rmSync(scratch, { recursive: true, force: true });
});

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

const MARKER = "export default () => (globalThis as unknown as { __cw1?: number }).__cw1 ?? null;\n";
const WITNESS = "globalThis.__cw1 = 1;\nexport default async (ctx) => {\n  await ctx.sleep(1);\n  ctx.bot.selectItem(null);\n};\n";
const HEADER = "the run did not start: the type check found 1 error(s) in your code. Fix them and run again, or put // @ts-nocheck as the first line to run it unchecked.";

describe("a run whose source has a refusing diagnostic", () => {
  it("is not evaluated, and ends with the diagnostics at their line and column in the source", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      const refused = runOf(await body.request("POST", "/run", { code: WITNESS }));
      assert.equal(refused.status, "error");
      const lines = (refused.error ?? "").split("\n");
      assert.ok(lines[0]!.endsWith(HEADER), refused.error ?? "");
      assert.match(lines[1]!, /^ {2}line 4:11 Property 'selectItem' does not exist on type/);
      assert.equal(lines[2], '    bot.selectItem does not exist: use bot.equip(item, "hand")', refused.error ?? "");
      assert.equal(lines.length, 3, refused.error ?? "");
      // The refused module was not evaluated, and the marker is not the bypass's either.
      assert.equal(runOf(await body.request("POST", "/run", { code: MARKER })).result, null);
      // The bypass the refusal names runs the same source, and then the marker is set.
      const unchecked = runOf(await body.request("POST", "/run", { code: `// @ts-nocheck\n${WITNESS}` }));
      assert.equal(unchecked.status, "error");
      assert.match(unchecked.error ?? "", /selectItem is not a function/);
      assert.equal(runOf(await body.request("POST", "/run", { code: MARKER })).result, 1);
    } finally {
      await body.close();
    }
  });

  // P6.2: the read runs, and its run result carries the did-you-mean line.
  it("runs a missing-member read and carries its did-you-mean line in the run's log", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      const result = runOf(
        await body.request("POST", "/run", { code: "export default async (ctx) => {\n  const e = ctx.bot.entity;\n  return e.valid;\n};\n" }),
      );
      assert.equal(result.status, "ok", result.error ?? "");
      assert.match(result.logs, /line 3:12 Property 'valid' does not exist on type 'Entity'\. Did you mean 'isValid'\?/, result.logs);
    } finally {
      await body.close();
    }
  });

  it("lists the first five errors and counts the rest", { timeout: 120_000 }, async () => {
    const calls = Array.from({ length: 8 }, (_, i) => `  f${i}();`).join("\n");
    const body = await startFakeBody({});
    try {
      const refused = runOf(await body.request("POST", "/run", { code: `export default async (ctx) => {\n${calls}\n};\n` }));
      assert.equal(refused.status, "error");
      const lines = (refused.error ?? "").split("\n");
      assert.match(lines[0]!, /the type check found 8 error\(s\) in your code/);
      assert.deepEqual(
        lines.slice(1, 6).map((line) => /^ {2}line (\d+):(\d+) Cannot find name '(f\d)'/.exec(line)?.slice(1)),
        [
          ["2", "3", "f0"],
          ["3", "3", "f1"],
          ["4", "3", "f2"],
          ["5", "3", "f3"],
          ["6", "3", "f4"],
        ],
        refused.error ?? "",
      );
      assert.equal(lines.length, 7, refused.error ?? "");
      assert.equal(lines.at(-1), "  and 3 more");
    } finally {
      await body.close();
    }
  });

  it("is refused with the library's own modules in view", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      body.writeRoutines({ helper: "export const double = (n: number): number => n * 2;\n" });
      const fine = runOf(await body.request("POST", "/run", { code: "import { double } from './helper.ts';\nexport default () => double(4);\n" }));
      assert.equal(fine.result, 8, fine.error ?? "");
      const refused = runOf(await body.request("POST", "/run", { code: "import { double } from './helper.ts';\nexport default () => double(4, 5);\n" }));
      assert.equal(refused.status, "error");
      assert.match(refused.error ?? "", /line 2:\d+ Expected 1 arguments, but got 2/);
    } finally {
      await body.close();
    }
  });
});

describe("RoutineLoader.run with a context", () => {
  const library = () => mkdtempSync(path.join(scratch, "library-"));
  const context = () => {
    const logged: unknown[][] = [];
    const controller = new AbortController();
    return { logged, controller, ctx: { signal: controller.signal, log: (...args: unknown[]) => void logged.push(args) } };
  };

  it("does not evaluate a source once the context's signal is aborted, before or during the check", { timeout: 120_000 }, async () => {
    const loader = new RoutineLoader(library());
    const before = context();
    before.controller.abort(new Error("stop"));
    await assert.rejects(loader.run("globalThis.__cw1 = 1;\nexport default 1;\n", before.ctx), /stop/);
    const during = context();
    const running = loader.run("globalThis.__cw1 = 1;\nexport default 1;\n", during.ctx);
    setImmediate(() => during.controller.abort(new Error("stop during")));
    await assert.rejects(running, /stop during/);
    assert.equal(globalThis.__cw1, undefined, "an aborted run was evaluated");
    assert.deepEqual([...before.logged, ...during.logged], [], "an abort is not a skip");
  });

  it("evaluates a source that passes the check, with nothing logged", { timeout: 120_000 }, async () => {
    const loader = new RoutineLoader(library());
    const { ctx, logged } = context();
    const namespace = (await loader.run("globalThis.__cw1 = 2;\nexport default async (ctx) => ctx.bot.health;\n", ctx)) as { default: unknown };
    assert.equal(typeof namespace.default, "function");
    assert.equal(globalThis.__cw1, 2);
    assert.deepEqual(logged, []);
  });

  it("evaluates a source unchecked when there is no context", async () => {
    const loader = new RoutineLoader(library());
    await loader.run("globalThis.__cw1 = 3;\nexport default async (ctx) => ctx.bot.selectItem(null);\n");
    assert.equal(globalThis.__cw1, 3);
  });

  it("logs one `type check skipped` line and evaluates as it would without a check when typescript cannot be resolved", { timeout: 120_000 }, async () => {
    const hide = new URL("./fixtures/routines/hide-typescript.cjs", import.meta.url).pathname;
    const script = `import { RoutineLoader } from ${JSON.stringify(new URL("../src/host/routines/loader.ts", import.meta.url).href)};
const logged = [];
const ctx = { signal: new AbortController().signal, log: (...args) => logged.push(args) };
await new RoutineLoader(${JSON.stringify(library())}).run("globalThis.__cw1 = 4;\\nexport default async (ctx) => ctx.bot.selectItem(null);\\n", ctx);
console.log(JSON.stringify({ logged, marker: globalThis.__cw1 }));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=minebot-sdk:source", "--require", hide, "--input-type=module", "--eval", script]);
    const answer = JSON.parse(stdout) as { logged: unknown[][]; marker: number };
    assert.equal(answer.logged.length, 1, stdout);
    assert.match(String(answer.logged[0]![0]), /^type check skipped: typescript is not installed/);
    assert.equal(answer.marker, 4);
  });
});
