// A run is a module: POST /run evaluates its `code` as a module of its own, once per run, in the bot host
// (the real Connection, Body, world, and routes over a fake player, under the real supervisor; see
// fixtures/host/fake-body.ts), and answers with the awaited default export. Its imports resolve as a
// library module's do. A run has the lifecycle of a call, which the lifecycle legs run through both.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { RoutineLoader } from "../src/host/routines/loader.ts";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, GRACE_MS, removeScratch, startFakeBody, type FakeBodyOptions } from "./fixtures/host/fake-body.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "minebot-module-run-"));
after(() => {
  removeScratch();
  rmSync(scratch, { recursive: true, force: true });
});

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

async function using<T>(options: FakeBodyOptions, test: (body: FakeBody) => Promise<T>): Promise<T> {
  const body = await startFakeBody(options);
  try {
    return await test(body);
  } finally {
    await body.close();
  }
}

const run = (body: FakeBody, code: string, args?: Record<string, unknown>, timeoutMs?: number) => body.request("POST", "/run", { code, args, timeoutMs });

describe("what a run answers", () => {
  it("calls a default function with the run's ctx and the args, and answers its awaited return", async () => {
    await using({}, async (body) => {
      const code = "export default async (ctx: { log(...a: unknown[]): void }, args: { n: number }) => {\n  ctx.log('n', args.n);\n  return { double: args.n * 2 };\n};\n";
      const answer = runOf(await run(body, code, { n: 21 }));
      assert.deepEqual({ status: answer.status, result: answer.result, logs: answer.logs }, { status: "ok", result: { double: 42 }, logs: "n 21" });
    });
  });

  it("passes {} as the args of a run given none", async () => {
    await using({}, async (body) => {
      assert.deepEqual(runOf(await run(body, "export default (_ctx: unknown, args: unknown) => args;")).result, {});
    });
  });

  it("validates the args and the return of a default export made by defineRoutine, as a call does", async () => {
    await using({}, async (body) => {
      const code = `import { defineRoutine, z } from "minebot-sdk/routine";
export default defineRoutine({ args: z.object({ n: z.number().default(3) }), returns: z.object({ n: z.number() }) }, async (_ctx, args) => ({ n: args.n }));
`;
      assert.deepEqual(runOf(await run(body, code)).result, { n: 3 });
      assert.deepEqual(runOf(await run(body, code, { n: 5 })).result, { n: 5 });
      const wrong = runOf(await run(body, code, { n: "five" }));
      assert.equal(wrong.status, "error");
      assert.match(wrong.error ?? "", /n/);
      assert.equal(runOf(await run(body, code, { n: 1 })).result && true, true, "a refused run did not leave the body busy");
    });
  });

  it("answers any other default export as it is, awaited: a value, a promise, and nothing", async () => {
    await using({}, async (body) => {
      assert.equal(runOf(await run(body, "export default 42;")).result, 42);
      assert.deepEqual(runOf(await run(body, "export default { a: [1, 2], b: 'x' };")).result, { a: [1, 2], b: "x" });
      assert.equal(runOf(await run(body, "export default new Promise((resolve) => setTimeout(() => resolve('later'), 20));")).result, "later");
      const none = runOf(await run(body, "export const unused = 1;"));
      assert.deepEqual({ status: none.status, result: none.result }, { status: "ok", result: undefined });
      const empty = runOf(await run(body, "console.log('top level');"));
      assert.deepEqual({ status: empty.status, result: empty.result, logs: empty.logs }, { status: "ok", result: undefined, logs: "top level" });
    });
  });

  it("strips types, as it does for a library module", async () => {
    await using({}, async (body) => {
      const code = "interface Shape { n: number }\nconst shape: Shape = { n: 7 };\nexport default shape.n as number;\n";
      assert.equal(runOf(await run(body, code)).result, 7);
    });
  });

  it("ends a source with a top-level return in status error, and the error says to use export default", async () => {
    await using({}, async (body) => {
      for (const code of ["return 1;", "const a: number = 2;\nreturn a;\n"]) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error");
        assert.match(answer.error ?? "", /export default/);
      }
    });
  });

  it("says nothing of export default for any other SyntaxError that mentions a return statement: one the run throws or causes, and a library module's own top-level return", async () => {
    await using({}, async (body) => {
      body.writeRoutines({ badlib: "return 1;\nexport const x = 1;\n" });
      const cases = {
        "JSON.parse": ["JSON.parse('return statement');\nexport default 1;\n", /is not valid JSON/],
        thrown: ["throw new SyntaxError('return statement');\n", /^SyntaxError: return statement/],
        "a library module": ["import { x } from './badlib.ts';\nexport default x;\n", /badlib\.ts:1[\s\S]*SyntaxError: /],
      } as const;
      for (const [name, [code, error]] of Object.entries(cases)) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error", name);
        assert.match(answer.error ?? "", error, name);
        assert.doesNotMatch(answer.error ?? "", /export default|a run is a module/, name);
      }
    });
  });

  it("ends a syntax error and a throw in status error, the throw with the run's own line", async () => {
    await using({}, async (body) => {
      const syntax = runOf(await run(body, "export default (;"));
      assert.equal(syntax.status, "error");
      assert.match(syntax.error ?? "", /SyntaxError/);
      const thrown = runOf(await run(body, "const a = 1;\nexport default () => {\n  throw new Error('boom');\n};\n"));
      assert.equal(thrown.status, "error");
      assert.match(thrown.error ?? "", /^Error: boom\n/);
      assert.match(thrown.error ?? "", new RegExp(`${RegExp.escape(path.join(body.routinesDir, ".run.ts"))}:3:`));
      const top = runOf(await run(body, "const a = 1;\nthrow new Error('top boom');\n"));
      assert.match(top.error ?? "", /^Error: top boom\n/);
      assert.match(top.error ?? "", new RegExp(`\\.run\\.ts:2:`));
    });
  });

  it("evaluates the module afresh each run, also for byte-identical sources", async () => {
    await using({}, async (body) => {
      const code = "globalThis.n = ((globalThis as { n?: number }).n ?? 0) + 1;\nexport default (globalThis as { n?: number }).n;\n";
      assert.equal(runOf(await run(body, code)).result, 1);
      assert.equal(runOf(await run(body, code)).result, 2);
      assert.equal(runOf(await run(body, code)).result, 3);
    });
  });

  it("records one history line per run, with the source as its code and the args it was given", async () => {
    await using({}, async (body) => {
      const code = "export default (_ctx: unknown, args: { a: number }) => args.a;\n";
      runOf(await run(body, code, { a: 1 }));
      runOf(await run(body, "export default 1;"));
      const [first, second] = body.history();
      assert.deepEqual([first!.code, first!.args, first!.status], [code, { a: 1 }, "ok"]);
      assert.deepEqual([second!.code, "args" in second!, second!.status], ["export default 1;", false, "ok"]);
      assert.equal(body.eventsOf("program_finished").length, 2);
    });
  });

  it("is refused while the body is not connected, and the refusal is not a run", async () => {
    await using({}, async (body) => {
      assert.equal((await body.request("POST", "/run", { code: "export default 1;", args: "x" })).status, 400);
      assert.equal(body.history().length, 0);
    });
  });
});

describe("how a run's imports resolve", () => {
  it("resolves packages as a library module does: bare imports, CommonJS named imports, require, and Node built-ins", async () => {
    await using({}, async (body) => {
      const code = `import { Vec3 } from "vec3";
import { goals } from "mineflayer-pathfinder";
import pathfinder from "mineflayer-pathfinder";
import os from "node:os";
import { z } from "zod";
const vec3 = require("vec3");
export default {
  sum: new Vec3(1, 2, 3).offset(1, 1, 1).toArray(),
  named: typeof goals.GoalNear,
  sameInstance: goals === pathfinder.goals,
  required: vec3.Vec3 === Vec3,
  builtin: typeof os.cpus,
  zod: z.string().parse("ok"),
};
`;
      assert.deepEqual(runOf(await run(body, code)).result, { sum: [2, 3, 4], named: "function", sameInstance: true, required: true, builtin: "function", zod: "ok" });
    });
  });

  it("binds require in a run, unless the run has a binding of its own", async () => {
    await using({}, async (body) => {
      assert.equal(runOf(await run(body, "const require = 5;\nexport default require;\n")).result, 5);
      assert.equal(runOf(await run(body, "export default typeof require('node:os').cpus;\n")).result, "function");
    });
  });

  it("imports a library module by file name as the library has it when the run starts", async () => {
    await using({}, async (body) => {
      body.writeRoutines({ shared: "export const answer = 41;\nexport default () => 'routine';\n", other: "import { answer } from './shared.ts';\nexport const next = answer + 1;\n" });
      const code = "import { answer } from './shared.ts';\nimport { next } from './other.ts';\nimport routine from './shared.ts';\nexport default { answer, next, routine: routine({} as never, {}) };\n";
      assert.deepEqual(runOf(await run(body, code)).result, { answer: 41, next: 42, routine: "routine" });
      body.writeRoutines({ shared: "export const answer = 99;\nexport default () => 'changed';\n" });
      assert.deepEqual(runOf(await run(body, code)).result, { answer: 99, next: 100, routine: "changed" });
    });
  });

  const refusals: [string, (dir: string) => string][] = [
    ["../x.ts", () => "../x.ts"],
    ["./sub/x.ts", () => "./sub/x.ts"],
    ["an absolute path", (dir) => path.join(path.dirname(dir), "x.ts")],
    ["an absolute path into the library", (dir) => path.join(dir, "x.ts")],
    ["a file: URL", (dir) => pathToFileURL(path.join(path.dirname(dir), "x.ts")).href],
    ["a file: URL into the library", (dir) => pathToFileURL(path.join(dir, "x.ts")).href],
  ];
  for (const [what, specifier] of refusals) {
    for (const exists of [true, false]) {
      it(`refuses ${what}, naming the specifier, whether or not a file is there (${exists ? "a file" : "none"})`, async () => {
        await using({}, async (body) => {
          body.writeRoutines({ x: "export default 'library';\n" });
          mkdirSync(path.join(body.routinesDir, "sub"), { recursive: true });
          if (exists) {
            writeFileSync(path.join(body.routinesDir, "sub", "x.ts"), "export default 'sub';\n");
            writeFileSync(path.join(path.dirname(body.routinesDir), "x.ts"), "export default 'outside';\n");
          }
          const named = specifier(body.routinesDir);
          const answer = runOf(await run(body, `import x from ${JSON.stringify(named)};\nexport default x;\n`));
          assert.equal(answer.status, "error", JSON.stringify(answer));
          assert.ok((answer.error ?? "").includes(named), `${answer.error}`);
          assert.doesNotMatch(answer.error ?? "", /outside|'sub'/);
        });
      });
    }
  }

  it("refuses a dynamic import of a path that leaves the library from inside a run", async () => {
    await using({}, async (body) => {
      writeFileSync(path.join(path.dirname(body.routinesDir), "x.ts"), "export default 'outside';\n");
      body.writeRoutines({ x: "export default 'library';\n" });
      const answer = runOf(await run(body, "export default async () => (await import('../x.ts')).default;\n"));
      assert.equal(answer.status, "error");
      assert.match(answer.error ?? "", /\.\.\/x\.ts/);
      assert.equal(runOf(await run(body, "export default async () => (await import('./x.ts')).default;\n")).result, "library");
    });
  });

  it("on a body without routines, imports packages and fails a relative import naming the specifier", async () => {
    await using({ init: { routines: false } }, async (body) => {
      assert.equal(runOf(await run(body, "import { Vec3 } from 'vec3';\nexport default new Vec3(1, 2, 3).x;\n")).result, 1);
      assert.equal(runOf(await run(body, "export default require('vec3').Vec3.name;\n")).result, "Vec3");
      for (const specifier of ["./x.ts", "../x.ts"]) {
        const answer = runOf(await run(body, `import x from ${JSON.stringify(specifier)};\nexport default x;\n`));
        assert.equal(answer.status, "error");
        assert.ok((answer.error ?? "").includes(specifier), `${answer.error}`);
      }
    });
  });

  it("on a body without routines, imports data: URLs, node: built-ins, and packages, and its refusal of a file import says none of them fail", async () => {
    await using({ init: { routines: false } }, async (body) => {
      const kinds = {
        "data: URLs": { source: "import x from 'data:text/javascript,export default 7';\nexport default x;\n", result: 7, named: /data:/ },
        "node: built-ins": { source: "import { sep } from 'node:path';\nexport default sep;\n", result: path.sep, named: /node:|Node built-ins/ },
        packages: { source: "import { Vec3 } from 'vec3';\nexport default new Vec3(1, 2, 3).x;\n", result: 1, named: /packages?/ },
      };
      for (const [kind, { source, result }] of Object.entries(kinds)) assert.equal(runOf(await run(body, source)).result, result, kind);
      for (const specifier of ["./x.ts", "/x.ts", "file:///x.ts"]) {
        const { status, error = "" } = runOf(await run(body, `import x from ${JSON.stringify(specifier)};\nexport default x;\n`));
        assert.equal(status, "error", specifier);
        // The refusal may say what a run imports. If it says "only", the list holds every kind that just worked; it denies none of them.
        for (const [kind, { named }] of Object.entries(kinds)) {
          if (/\bonly\b/i.test(error)) assert.match(error, named, `the refusal of ${specifier} lists what a run imports without ${kind}: ${error}`);
          assert.doesNotMatch(error, new RegExp(`\\bno (?:${named.source})`, "i"), `the refusal of ${specifier} denies ${kind}: ${error}`);
        }
      }
    });
  });
});

describe("a run does not change the library's generation", () => {
  it("leaves loader.load(x) with the namespace it had, and the run sees that namespace", async () => {
    const dir = path.join(scratch, "library");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "x.ts"), "export const stamp = Symbol('x');\nexport default () => 1;\n");
    writeFileSync(path.join(dir, "y.ts"), "import { stamp } from './x.ts';\nexport default () => stamp;\n");
    const loader = new RoutineLoader(dir);
    const before = (await loader.load("x")) as { stamp: symbol };
    const ran = (await loader.run("import * as x from './x.ts';\nimport y from './y.ts';\nexport default { x, y };\n")) as { default: { x: unknown; y: () => symbol } };
    assert.equal(ran.default.x, before, "the run did not import the library's module of its generation");
    assert.equal(ran.default.y(), before.stamp);
    assert.equal(await loader.load("x"), before, "a run changed what load returns");
    // A run that holds the library's bytes never makes a module of its own part of them.
    await loader.run("export default 1;");
    await loader.run("export default 1;");
    assert.equal(await loader.load("x"), before);
    // After a save the library is a new generation, as it was without runs.
    writeFileSync(path.join(dir, "x.ts"), "export const stamp = Symbol('x2');\nexport default () => 2;\n");
    const after = (await loader.load("x")) as { stamp: symbol };
    assert.notEqual(after, before);
    assert.equal(await loader.load("x"), after);
    assert.equal(((await loader.run("import * as x from './x.ts';\nexport default x;\n")) as { default: unknown }).default, after);
  });

  it("evaluates a library module a run imports no more than the library's own load does", async () => {
    const dir = path.join(scratch, "counting");
    mkdirSync(dir);
    const marker = path.join(scratch, "evaluations");
    writeFileSync(path.join(dir, "x.ts"), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nexport default () => 1;\n`);
    const loader = new RoutineLoader(dir);
    await loader.load("x");
    await loader.run("import './x.ts';\nexport default 1;\n");
    await loader.run("import './x.ts';\nexport default 1;\n");
    await loader.load("x");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(marker, "utf8"), "x", "x was evaluated again for a run");
  });
});

/** Vehicles for the lifecycle legs: how a test starts a run that sleeps, one that blocks the host, and a quick one, as /run or as /call. */
interface Vehicle {
  name: string;
  /** Starts the vehicle's slow run (sleeps until aborted); `timeoutMs` as for the request. */
  sleeper(body: FakeBody, timeoutMs?: number): Promise<{ status: number; body: unknown }>;
  blocker(body: FakeBody, timeoutMs: number): Promise<{ status: number; body: unknown }>;
  quick(body: FakeBody): Promise<{ status: number; body: unknown }>;
  /** The history line's field that tells this vehicle's runs from the other's. */
  line(line: Record<string, unknown>): unknown;
  /** The body for a vehicle: `call` needs its routines. */
  setup(options?: FakeBodyOptions): Promise<FakeBody>;
}

const SLEEPER_MODULE = "export default async (ctx: { sleep(ms: number): Promise<void> }) => {\n  await ctx.sleep(30_000);\n};\n";
const BLOCKER_MODULE = "export default (): never => {\n  for (;;) {}\n};\n";
const QUICK_MODULE = "export default () => 'quick';\n";

const vehicles: Vehicle[] = [
  {
    name: "run",
    sleeper: (body, timeoutMs) => run(body, SLEEPER_MODULE, undefined, timeoutMs),
    blocker: (body, timeoutMs) => run(body, BLOCKER_MODULE, undefined, timeoutMs),
    quick: (body) => run(body, QUICK_MODULE),
    line: (line) => line.code,
    setup: (options) => startFakeBody(options),
  },
  {
    name: "call",
    sleeper: (body, timeoutMs) => body.request("POST", "/call", { name: "sleeper", timeoutMs }),
    blocker: (body, timeoutMs) => body.request("POST", "/call", { name: "blocker", timeoutMs }),
    quick: (body) => body.request("POST", "/call", { name: "quick" }),
    line: (line) => (line.call as { name: string }).name,
    async setup(options) {
      const body = await startFakeBody(options);
      body.writeRoutines({ sleeper: SLEEPER_MODULE, blocker: BLOCKER_MODULE, quick: QUICK_MODULE });
      for (const name of ["sleeper", "blocker", "quick"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
      return body;
    },
  },
];

/** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
async function running(body: FakeBody): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
  assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
  await sleep(150);
}

describe("a run has the lifecycle of a call", () => {
  for (const vehicle of vehicles) {
    describe(`as ${vehicle.name}`, () => {
      const started = async (test: (body: FakeBody) => Promise<void>) => {
        const body = await vehicle.setup();
        try {
          await test(body);
        } finally {
          await body.close();
        }
      };

      it("is refused with 409 while a run or a call executes, in both directions, and the refusal is not a run", async () => {
        await started(async (body) => {
          const first = vehicle.sleeper(body);
          await running(body);
          for (const other of vehicles) {
            const refused = await other.quick(body).catch(() => undefined);
            // `call` has no routine on a body set up for `run`: only the vehicle's own twin is bound; a refusal is a 409 either way.
            if (refused) assert.ok(refused.status === 409 || refused.status === 404, `${other.name}: ${refused.status} ${JSON.stringify(refused.body)}`);
          }
          assert.equal((await run(body, "export default 1;")).status, 409);
          assert.equal((await vehicle.quick(body)).status, 409);
          assert.deepEqual(await body.host.stop(), { stopped: true });
          assert.equal(runOf(await first).status, "stopped");
          assert.equal(body.history().length, 1, "a refused request is not a run");
          assert.equal(runOf(await vehicle.quick(body)).result, "quick");
        });
      });

      it("is aborted by /stop and by its own timeout, and each is a history line", async () => {
        await started(async (body) => {
          const stopped = vehicle.sleeper(body);
          await running(body);
          assert.deepEqual(await body.host.stop(), { stopped: true });
          assert.equal(runOf(await stopped).status, "stopped");
          assert.equal(runOf(await vehicle.sleeper(body, 300)).status, "timeout");
          assert.deepEqual(
            body.history().map((line) => [typeof vehicle.line(line), line.status]),
            [
              ["string", "stopped"],
              ["string", "timeout"],
            ],
          );
        });
      });

      it("ends a run that blocks the host by the supervisor's deadline: the restarted error, one history line, the host replaced", { timeout: 30_000 }, async () => {
        await started(async (body) => {
          const pid = (code: string) => run(body, code);
          const before = runOf(await pid("export default () => process.pid;")).result;
          const since = body.events.since(0, 1000).next;
          const t0 = Date.now();
          const answer = runOf(await vehicle.blocker(body, 200));
          assert.ok(Date.now() - t0 < 200 + GRACE_MS + 500 + 4_000, `took ${Date.now() - t0} ms`);
          assert.equal(answer.error, restartedError(hungCause(GRACE_MS)));
          await body.waitFor("connected", since);
          const after = runOf(await pid("export default () => process.pid;")).result;
          assert.notEqual(after, before, "the host was replaced");
          const blocked = body.history().filter((line) => line.status === answer.status && line.error === answer.error);
          assert.equal(blocked.length, 1, "the killed run has one history line");
        });
      });
    });
  }

  it("is refused with 409 while a reflex's firing executes, and a firing waits for a run instead of preempting it", { timeout: 30_000 }, async () => {
    const body = await startFakeBody();
    try {
      body.writeRoutines({ slow: "export default async (ctx: { sleep(ms: number): Promise<void> }) => {\n  await ctx.sleep(30_000);\n};\n", mark: "export default () => 'marked';\n" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "slowreflex", routine: "slow", on: ["chat"], match: "^go$", cooldownMs: 0, timeoutMs: 60_000 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "markreflex", routine: "mark", on: ["chat"], match: "^mark$", cooldownMs: 0 });
      await body.ok("POST", "/bind", { kind: "action", name: "mark", routine: "mark" });
      const say = (message: string) => `export default (ctx: { bot: { emit(event: string, ...args: unknown[]): void } }) => ctx.bot.emit('chat', 'ana', ${JSON.stringify(message)});`;
      // A run says "go" and ends; the slow reflex it fires executes.
      assert.equal(runOf(await run(body, say("go"))).status, "ok");
      await body.waitFor("reflex_fired");
      await running(body);
      for (const refused of [await run(body, "export default 1;"), await body.request("POST", "/call", { name: "mark" })]) assert.equal(refused.status, 409, JSON.stringify(refused.body));
      const runs = () => body.history().filter((line) => line.status !== "registered");
      assert.equal(runs().length, 1, "the firing is still running: only the run that said go has ended");
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal((await body.waitFor("reflex_finished")).data.status, "stopped");
      assert.equal(runs().length, 2, "the runs are the run and the firing; the refused requests are none");

      // The other direction: a run executes, and the firing its own chat starts waits for it.
      const long = "export default async (ctx: { bot: { emit(event: string, ...args: unknown[]): void }; sleep(ms: number): Promise<void> }) => {\n  ctx.bot.emit('chat', 'ana', 'mark');\n  await ctx.sleep(600);\n  return 'long';\n};\n";
      assert.equal(runOf(await run(body, long)).result, "long");
      const finished = await body.waitFor("reflex_finished", body.eventsOf("reflex_finished")[0]!.seq);
      assert.deepEqual([finished.data.name, finished.data.status], ["markreflex", "ok"]);
      const ended = body.eventsOf("program_finished").at(-1)!;
      assert.ok(body.eventsOf("reflex_fired").at(-1)!.seq > ended.seq, "the firing waited for the run to end");
    } finally {
      await body.close();
    }
  });
});

describe("console output during a run", () => {
  it("lands in the log of the run that wrote it, and in no other", async () => {
    await using({}, async (body) => {
      const first = runOf(await run(body, "export default () => {\n  console.log('a', { n: 1 });\n  console.info('b');\n  console.warn('c');\n  console.error('d');\n  console.debug('e');\n};\n"));
      assert.equal(first.logs, "a { n: 1 }\nb\nc\nd\ne");
      assert.equal(runOf(await run(body, "export default () => 1;")).logs, "");
    });
  });
});

describe("a run's ctx", () => {
  const KEYS = "export default (ctx: object) => Object.keys(ctx);\n";
  for (const wikiMode of ["off", "read", "write"] as const) {
    it(`has the members of a routine call's ctx, in the order the reference lists them, with wiki ${wikiMode}`, async () => {
      await using({ init: { wikiMode } }, async (body) => {
        body.writeRoutines({ keys: KEYS });
        await body.ok("POST", "/bind", { kind: "action", name: "keys", routine: "keys" });
        const ran = runOf(await run(body, KEYS)).result;
        assert.deepEqual(ran, runOf(await body.request("POST", "/call", { name: "keys" })).result);
        const doc = ((await body.ok("GET", "/api")) as { doc: string }).doc;
        assert.deepEqual(/^ctx, the default function's first argument, has exactly: (.*)\.$/m.exec(doc)?.[1]?.split(", "), ran);
        assert.deepEqual(ran, ["log", "sleep", "signal", "on", "bot", "notes", "status", ...(wikiMode === "off" ? [] : ["wiki"]), "store"]);
      });
    });
  }

  it("shares the body's notes and store with calls, and reads the store across runs", async () => {
    await using({}, async (body) => {
      const write = "export default (ctx: { notes: { set(k: string, t: string): unknown }; store(ns: string): { set(k: string, v: unknown): void } }) => {\n  ctx.notes.set('from-run', 'x');\n  ctx.store('modrun').set('n', 7);\n};\n";
      const read = "export default (ctx: { notes: { get(k: string): string | undefined }; store(ns: string): { get(k: string): unknown } }) => [ctx.notes.get('from-run'), ctx.store('modrun').get('n')];\n";
      assert.equal(runOf(await run(body, write)).status, "ok");
      assert.deepEqual(runOf(await run(body, read)).result, ["x", 7]);
    });
  });
});
