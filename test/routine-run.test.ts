import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { RoutineLoader } from "../src/host/routines/loader.ts";
import { ProgramRunner } from "../src/program/runner.ts";
import type { ProgramScope } from "../src/program/scope.ts";
import { invokeRoutine } from "../src/routine/invoke.ts";
import type { RoutineContext } from "../src/routine/public.ts";

const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "routine-run-")));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;
function library(files: Record<string, string>): string {
  const dir = path.join(SCRATCH, `t${counter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
  return dir;
}

const contextOf = (scope: ProgramScope): RoutineContext => ({
  ...scope,
  bot: {} as Bot, // routines under test never touch the bot
  notes: { list: () => [], get: () => undefined, set: (key, text) => ({ key, text, updated: "" }), delete: () => false },
  status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
});

/** Runs routine `name` of `loader`'s library as the body does: one call of the runner. */
function runRoutine(loader: RoutineLoader, name: string, args: unknown = {}) {
  const runner = new ProgramRunner({ globals: () => ({}) });
  return runner.call(async (scope) => invokeRoutine(await loader.load(name), name, contextOf(scope), args), { sourceDir: loader.dir });
}

// Type stripping blanks the types instead of removing lines, so the lines below are the lines the frames report.
const HELPER = ["export function explode(): never {", '  throw new Error("boom");', "}", ""].join("\n");
const ACTION = [
  "import { explode } from './helper.ts';",
  "interface Shape {",
  "  n: number;",
  "}",
  "export default async (ctx: unknown, args: Shape): Promise<void> => {",
  "  await Promise.resolve();",
  "  explode();",
  "};",
  "",
].join("\n");

describe("a routine's error", () => {
  const frame = (dir: string) => new RegExp(`^ {4}at (?:.* \\()?${RegExp.escape(dir)}/([a-z]+\\.ts):(\\d+):(\\d+)\\)?$`);

  for (const viaSymlink of [false, true]) {
    it(`reports its message and the frames inside the library, as files and with the source's lines${viaSymlink ? ", through a symlinked directory" : ""}`, async () => {
      const real = library({ "action.ts": ACTION, "helper.ts": HELPER });
      const link = path.join(SCRATCH, `link${counter++}`);
      if (viaSymlink) symlinkSync(real, link);
      const loader = new RoutineLoader(viaSymlink ? link : real);
      const run = await runRoutine(loader, "action");
      assert.equal(run.status, "error");
      const [first, ...frames] = (run.error ?? "").split("\n");
      assert.equal(first, "Error: boom");
      assert.ok(frames.length > 0, `no frames in ${run.error}`);
      const located = frames.map((line) => {
        const match = frame(real).exec(line);
        assert.ok(match, `a frame outside the library, or one with its generation or URL: ${line}`);
        return `${match[1]}:${match[2]}`;
      });
      assert.deepEqual(located, ["helper.ts:2", "action.ts:7"]);
      assert.ok(!(run.error ?? "").includes("?g="));
      assert.ok(!(run.error ?? "").includes("file://"));
    });
  }

  it("reports where a module throws while it is evaluated", async () => {
    const loader = new RoutineLoader(library({ "eval.ts": '\n\nthrow new TypeError("at load");\nexport default () => 1;\n' }));
    const run = await runRoutine(loader, "eval");
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /^TypeError: at load\n {4}at .*\/eval\.ts:3:7$/);
  });

  it("reports where a module that does not compile is wrong", async () => {
    const dir = library({ "bad.ts": "export default () => 1;\nconst = ;\n" });
    const run = await runRoutine(new RoutineLoader(dir), "bad");
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", new RegExp(`^${RegExp.escape(dir)}/bad\\.ts:2\\n`));
    assert.match(run.error ?? "", /SyntaxError: /);
    assert.ok(!(run.error ?? "").includes("?g="));
  });

  it("reports a value that is not an error as its text", async () => {
    const loader = new RoutineLoader(library({ "str.ts": 'export default () => { throw "plain"; };' }));
    assert.equal((await runRoutine(loader, "str")).error, "plain");
  });

  it("names an absent routine and one that exports no function", async () => {
    const loader = new RoutineLoader(library({ "nofn.ts": "export const a = 1;" }));
    assert.match((await runRoutine(loader, "nofn")).error ?? "", /routine "nofn" must default-export a function/);
    assert.match((await runRoutine(loader, "absent")).error ?? "", /no routine named "absent"/);
  });

  it("returns the result as JSON with the routine's logs", async () => {
    const loader = new RoutineLoader(library({ "ok.ts": 'export default async (ctx) => { ctx.log("hello", { a: 1 }); return { big: 2n, nothing: undefined }; };' }));
    const run = await runRoutine(loader, "ok");
    assert.deepEqual({ ...run, durationMs: 0 }, { status: "ok", result: { big: "2" }, error: undefined, logs: "hello { a: 1 }", durationMs: 0 });
  });
});
