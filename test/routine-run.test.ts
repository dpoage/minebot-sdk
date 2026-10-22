import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
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
  store: () => ({ get: () => undefined, set: () => {}, delete: () => false, keys: () => [] }),
  status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
});

/** Runs routine `name` of `loader`'s library as the body does: one call of the runner. */
function runRoutine(loader: RoutineLoader, name: string, args: unknown = {}) {
  const runner = new ProgramRunner();
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
      assert.ok(!(run.error ?? "").includes("?"));
      assert.ok(!(run.error ?? "").includes("file://"));
    });
  }

  for (const viaSymlink of [false, true]) {
    it(`names a frame's file whatever its module URL adds, and keeps only the frames inside the directory${viaSymlink ? ", given through a symlink" : ""}`, async () => {
      const real = library({});
      const link = path.join(SCRATCH, `link${counter++}`);
      if (viaSymlink) symlinkSync(real, link);
      const url = (file: string) => pathToFileURL(path.join(real, file)).href;
      const error = new Error("made up");
      // The loader decides what a library module's URL adds to the file; the frames must not depend on it.
      error.stack = [
        "Error: made up",
        `    at first (${url("a.ts")}?v=1:2:9)`,
        `    at ${url("b.ts")}#x:3:1`,
        `    at async ${url("c.ts")}:4:2`,
        `    at elsewhere (${pathToFileURL(`${real}-sibling/d.ts`).href}?v=1:5:5)`,
        "    at node:internal/modules/esm/module_job:1:1",
      ].join("\n");
      const runner = new ProgramRunner();
      const run = await runner.call(
        async () => {
          throw error;
        },
        { sourceDir: viaSymlink ? link : real },
      );
      assert.equal(run.error, ["Error: made up", `    at first (${real}/a.ts:2:9)`, `    at ${real}/b.ts:3:1`, `    at async ${real}/c.ts:4:2`].join("\n"));
    });
  }

  /** Calls a routine that logs, then throws `thrown`, with the library in `dir`. */
  const throwing = (dir: string, thrown: () => unknown) =>
    new ProgramRunner().call(
      async (scope) => {
        scope.log("before");
        throw thrown();
      },
      { sourceDir: dir },
    );

  for (const [what, thrown, expected] of [
    ["an error whose message holds a URL that is no file (%zz)", () => new Error("see file:///tmp/%zz:3"), "Error: see file:///tmp/%zz:3"],
    ["an error whose message holds a URL with an encoded slash", () => new Error("see file:///tmp/a%2Fb.ts:1:2"), "Error: see file:///tmp/a%2Fb.ts:1:2"],
  ] as const) {
    it(`reports ${what} as an error with its message and the logs`, async () => {
      const run = await throwing(library({}), thrown);
      assert.deepEqual({ status: run.status, error: run.error, logs: run.logs }, { status: "error", error: expected, logs: "before" });
    });
  }

  it("drops a frame whose URL names no file and keeps the library's frames", async () => {
    const dir = library({});
    const stack = ["Error: x", "    at f (file:///tmp/a%2Fb.ts:1:1)", "    at g (file:///tmp/%zz.ts:1:1)", `    at h (${pathToFileURL(path.join(dir, "a.ts")).href}?q=1:2:3)`].join("\n");
    const run = await throwing(dir, () => ({ stack, message: "x" }));
    assert.deepEqual({ status: run.status, error: run.error, logs: run.logs }, { status: "error", error: `Error: x\n    at h (${dir}/a.ts:2:3)`, logs: "before" });
  });

  it("reports a value with no string form, or whose stack cannot be read, as an error with the logs", async () => {
    const dir = library({});
    const bare = await throwing(dir, () => Object.create(null));
    assert.deepEqual({ status: bare.status, error: bare.error, logs: bare.logs }, { status: "error", error: "[Object: null prototype] {}", logs: "before" });
    const unreadable = await throwing(dir, () => ({
      message: "hidden",
      get stack(): string {
        throw new Error("no stack");
      },
    }));
    assert.equal(unreadable.status, "error");
    assert.match(unreadable.error ?? "", /message: 'hidden'/);
    assert.equal(unreadable.logs, "before");
  });

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
    assert.ok(!(run.error ?? "").includes("file://"));
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
