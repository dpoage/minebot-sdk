// The routine contract K1: a routine value validates every call (direct or invoked) and reports it to the
// observer its context carries; `ctx.store` namespaces; the closed export set of `minebot-sdk/routine`;
// and the run scope's refusal of subscriptions after the run's abort (mb-jg8).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { BodyState } from "../src/host/state.ts";
import { ProgramRunner } from "../src/program/runner.ts";
import type { ProgramScope } from "../src/program/scope.ts";
import { type RoutineCallEnd, type RoutineCallObserver, withObserver } from "../src/routine/define.ts";
import { invokeRoutine } from "../src/routine/invoke.ts";
import * as publicRoutine from "../src/routine/public.ts";
import { defineRoutine, z, type RoutineContext } from "../src/routine/public.ts";
import { createKitHarness } from "../src/testing/index.ts";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "routine-direct-")));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  removeScratch();
});

function contextOf(signal: AbortSignal = new AbortController().signal): RoutineContext {
  return {
    bot: {} as Bot, // routines under test never touch the bot
    log: () => {},
    sleep: async () => {},
    signal,
    on: () => {},
    notes: { list: () => [], get: () => undefined, set: (key, text) => ({ key, text, updated: "" }), delete: () => false },
    store: () => ({ get: () => undefined, set: () => {}, delete: () => false, keys: () => [] }),
    status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
  };
}
const ctx = contextOf();

describe("a routine value's direct call", () => {
  const seen: unknown[] = [];
  const shaped = defineRoutine({ name: "t.shaped", args: z.object({ n: z.number().default(3), label: z.string().default("x") }), returns: z.object({ n: z.number(), label: z.string() }) }, (_ctx, args) => {
    seen.push(args);
    return args;
  });

  it("hands the run function args.parse(a), defaults applied, for every way of omitting a defaulted key", async () => {
    seen.length = 0;
    assert.deepEqual(await shaped(ctx, { label: "y" }), { n: 3, label: "y" });
    assert.deepEqual(await shaped(ctx, {}), { n: 3, label: "x" });
    // An all-optional schema is called without arguments, and an omitted `args` is {}.
    const bare: { n: number; label: string } = await shaped(ctx);
    assert.deepEqual(bare, { n: 3, label: "x" });
    assert.deepEqual(await shaped(ctx, { n: 5 }), { n: 5, label: "x" });
    assert.deepEqual(seen, [{ n: 3, label: "y" }, { n: 3, label: "x" }, { n: 3, label: "x" }, { n: 5, label: "x" }]);
  });

  it("is typed: a wrong argument type does not compile, and a required key is required", async () => {
    // @ts-expect-error n must be a number
    await assert.rejects(shaped(ctx, { n: "one" }), /routine "t\.shaped" arguments/);
    const required = defineRoutine({ name: "t.required", args: z.object({ id: z.string(), n: z.number().default(1) }), returns: z.string() }, (_ctx, args) => args.id + args.n);
    // @ts-expect-error `args` are required when a key has no default
    await assert.rejects(required(ctx), /routine "t\.required" arguments/);
    // @ts-expect-error `id` is missing
    await assert.rejects(required(ctx, {}), /"id"/);
    const out: string = await required(ctx, { id: "a" });
    assert.equal(out, "a1");
  });

  it("rejects arguments that do not match before the run function runs, naming the routine and the args schema; null is an argument", async () => {
    seen.length = 0;
    const failure = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^routine "t\.shaped" arguments: /);
      assert.match(error.message, /\nargs schema: \{.*"n":\{"default":3,"type":"number"\}/);
      return true;
    };
    await assert.rejects(shaped(ctx, { n: "one" } as never), failure);
    await assert.rejects(shaped(ctx, null as never), failure);
    assert.deepEqual(seen, []);
  });

  it("resolves with returns.parse(result) and rejects a result that does not match, naming the routine", async () => {
    const returns = z.object({ total: z.number(), tag: z.string().default("sum") });
    const summed = defineRoutine({ name: "t.sum", args: z.object({ a: z.number(), b: z.number() }), returns }, (_ctx, args) => ({ total: args.a + args.b }));
    const out: { total: number; tag: string } = await summed(ctx, { a: 1, b: 2 });
    assert.deepEqual(out, { total: 3, tag: "sum" });
    const wrong = defineRoutine({ name: "t.wrong", returns }, (() => ({ total: "many" })) as never);
    await assert.rejects(wrong(ctx), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^routine "t\.wrong" returned a value that does not match its returns schema: /);
      assert.match(error.message, /\nreturns schema: \{.*"total"/);
      return true;
    });
  });

  it("calls a routine without a schema with its arguments as given ({} when absent), and names an unnamed routine \"routine\"", async () => {
    const echo = defineRoutine({}, (_ctx, args) => args);
    assert.deepEqual(await echo(ctx), {});
    assert.deepEqual(await echo(ctx, { anything: [1] }), { anything: [1] });
    const unnamed = defineRoutine({ args: z.object({ n: z.number() }) }, () => 1);
    await assert.rejects(unnamed(ctx, {} as never), /routine "routine" arguments: /);
  });

  it("rejects, never throws, when the run function throws synchronously", async () => {
    const throwing = defineRoutine({ name: "t.throws" }, () => {
      throw new Error("sync");
    });
    const pending = throwing(ctx);
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, /sync/);
  });
});

describe("invokeRoutine on a routine value", () => {
  it("parses the arguments once and checks the result once, with the invoke name in the messages", async () => {
    let parsedArgs = 0;
    let parsedReturns = 0;
    const counted = defineRoutine(
      {
        name: "t.counted",
        args: z.object({ n: z.number() }).transform((value) => (parsedArgs++, value)),
        returns: z.number().transform((value) => (parsedReturns++, value)),
      },
      (_ctx, args) => args.n * 2,
    );
    assert.equal(await invokeRoutine({ default: counted }, "bound-name", ctx, { n: 4 }), 8);
    assert.deepEqual([parsedArgs, parsedReturns], [1, 1]);
    assert.equal(await counted(ctx, { n: 4 }), 8);
    assert.deepEqual([parsedArgs, parsedReturns], [2, 2]);
    await assert.rejects(invokeRoutine({ default: counted }, "bound-name", ctx, { n: "x" }), /^Error: routine "bound-name" arguments: /);
    await assert.rejects(counted(ctx, { n: "x" } as never), /routine "t\.counted" arguments: /);
  });
});

describe("the routine call observer", () => {
  type Record = { event: "start"; name?: string; args: unknown } | { event: "end"; name?: string; end: RoutineCallEnd };

  /** An observer that writes one record per start and one per end, named by the routine's declared name. */
  function recorder(): { observer: RoutineCallObserver; records: Record[] } {
    const records: Record[] = [];
    const observer: RoutineCallObserver = ({ name, args }) => {
      records.push({ event: "start", name, args });
      return (end) => void records.push({ event: "end", name, end });
    };
    return { observer, records };
  }

  const inner = defineRoutine({ name: "t.inner", args: z.object({ n: z.number().default(1) }) }, (_ctx, args) => args.n);
  const failing = defineRoutine({ name: "t.fail", args: z.object({}) }, () => {
    throw new Error("nope");
  });
  const outer = defineRoutine({ name: "t.outer" }, async (c) => {
    await inner(c);
    await inner({ ...c, log: () => {} }, { n: 2 });
    await failing(c, {}).catch(() => {});
    return "done";
  });

  it("reports one start and one end per call, nested calls included, in start order, through a spread context", async () => {
    const { observer, records } = recorder();
    assert.equal(await invokeRoutine({ default: outer }, "outer", withObserver(ctx, observer), undefined), "done");
    assert.deepEqual(records, [
      { event: "start", name: "t.outer", args: undefined },
      { event: "start", name: "t.inner", args: undefined },
      { event: "end", name: "t.inner", end: { ok: true } },
      { event: "start", name: "t.inner", args: { n: 2 } },
      { event: "end", name: "t.inner", end: { ok: true } },
      { event: "start", name: "t.fail", args: {} },
      { event: "end", name: "t.fail", end: { ok: false, message: "nope", aborted: false } },
      { event: "end", name: "t.outer", end: { ok: true } },
    ]);
  });

  it("carries the observer as an enumerable property under the registered symbol, outside the context's members", () => {
    const { observer } = recorder();
    const observed = withObserver(ctx, observer);
    const descriptor = Object.getOwnPropertyDescriptor(observed, Symbol.for("minebot-sdk.routine-observer"));
    assert.equal(descriptor?.enumerable, true);
    assert.deepEqual(Object.keys(observed).sort(), Object.keys(ctx).sort());
    assert.equal(Object.getOwnPropertyDescriptor({ ...observed }, Symbol.for("minebot-sdk.routine-observer"))?.value, observer);
  });

  it("reports a call that fails before its run function as one failed end, with the raw arguments at the start", async () => {
    const { observer, records } = recorder();
    await assert.rejects(inner(withObserver(ctx, observer), { n: "x" } as never));
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { event: "start", name: "t.inner", args: { n: "x" } });
    const [, end] = records;
    assert.ok(end?.event === "end" && !end.end.ok && end.end.message.startsWith('routine "t.inner" arguments: ') && !end.end.aborted);
  });

  it("reports whether the run's signal had fired by the end of a failed call", async () => {
    const controller = new AbortController();
    const stopped = defineRoutine({ name: "t.stopped" }, (c) => {
      controller.abort(new Error("stopped"));
      return c.signal.throwIfAborted();
    });
    const { observer, records } = recorder();
    await assert.rejects(stopped(withObserver(contextOf(controller.signal), observer)), /stopped/);
    assert.deepEqual(records[1], { event: "end", name: "t.stopped", end: { ok: false, message: "stopped", aborted: true } });
  });

  it("hands the observer the routine value itself, and does not observe plain functions or an unobserved context", async () => {
    const calls: unknown[] = [];
    const observer: RoutineCallObserver = ({ routine }) => (calls.push(routine), () => {});
    await inner(withObserver(ctx, observer));
    await invokeRoutine({ default: (_c: RoutineContext, args: unknown) => args }, "plain", withObserver(ctx, observer), {});
    assert.deepEqual(calls, [inner]);
    assert.equal(await inner(ctx, { n: 7 }), 7);
    assert.equal(await invokeRoutine({ default: outer }, "outer", ctx, {}), "done");
  });
});

describe("ctx.store", () => {
  const INVALID = ["", "Upper", "1abc", "a.b", "x/y", "../notes", "a".repeat(49)];

  it("persists a namespace at <state>/stores/<namespace>.json and survives a new BodyState on the directory", () => {
    const dir = path.join(SCRATCH, "state-a");
    const state = new BodyState(dir);
    const store = state.routineStore("explorer");
    store.set("places", { home: [1, 2, 3] });
    store.set("gone", 1);
    assert.equal(store.delete("gone"), true);
    assert.equal(store.delete("gone"), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "stores", "explorer.json"), "utf8")), { places: { home: [1, 2, 3] } });
    const again = new BodyState(dir).routineStore("explorer");
    assert.deepEqual(again.get("places"), { home: [1, 2, 3] });
    assert.deepEqual(again.keys(), ["places"]);
    assert.equal(existsSync(path.join(dir, "stores", "other.json")), false);
  });

  it("refuses a name that is not a routine name, and notes and body, naming the rule, and leaves the body's own files alone", () => {
    const state = new BodyState(path.join(SCRATCH, "state-b"));
    state.notes.set("k", "kept");
    for (const namespace of INVALID) assert.throws(() => state.routineStore(namespace), /ctx\.store namespace .* is not allowed: use 1-48 lowercase letters, digits, _ and -; start with a letter/, namespace);
    for (const namespace of ["notes", "body"]) assert.throws(() => state.routineStore(namespace), new RegExp(`ctx\\.store namespace "${namespace}" is reserved for the body's own state`));
    assert.equal(state.notes.get("k")?.text, "kept");
  });

  it("is in memory and per harness in the harness, under the same rule", async () => {
    const first = createKitHarness();
    const second = createKitHarness();
    const write = defineRoutine({ name: "t.write", args: z.object({ value: z.number() }) }, (c, args) => {
      c.store("t").set("v", args.value);
      return c.store("t").keys();
    });
    assert.deepEqual(await first.run(write, { value: 7 }), ["v"]);
    assert.equal(await first.run((c) => c.store("t").get("v")), 7);
    assert.equal(await second.run((c) => c.store("t").get("v")), undefined);
    for (const namespace of [...INVALID, "notes", "body"]) await assert.rejects(first.run((c) => c.store(namespace)), /ctx\.store namespace/, namespace);
  });

  it("is the host's ctx.store: a call writes the namespace's file, a restarted body reads it, and notes stay out of reach", async () => {
    const probe = [
      "export default (ctx: { store(ns: string): { get(k: string): unknown; set(k: string, v: unknown): void } }, args: { ns: string; write?: unknown }) => {",
      "  if (args.write !== undefined) ctx.store(args.ns).set('v', args.write);",
      "  return ctx.store(args.ns).get('v');",
      "};",
      "",
    ].join("\n");
    const stateDir = path.join(SCRATCH, "state-host");
    const run = async (body: FakeBody, args: unknown) => (await body.request("POST", "/call", { name: "probe", args })) as { status: number; body: { status: string; result?: unknown; error?: string } };
    const first = await startFakeBody({ stateDir });
    try {
      first.writeRoutines({ probe });
      await first.ok("POST", "/bind", { kind: "action", name: "probe", routine: "probe" });
      assert.deepEqual((await run(first, { ns: "mine", write: { n: 1 } })).body.result, { n: 1 });
      const refused = (await run(first, { ns: "notes", write: 1 })).body;
      assert.equal(refused.status, "error");
      assert.match(refused.error ?? "", /ctx\.store namespace "notes" is reserved/);
    } finally {
      await first.close();
    }
    assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir, "stores", "mine.json"), "utf8")), { v: { n: 1 } });
    const second = await startFakeBody({ stateDir });
    try {
      assert.deepEqual((await run(second, { ns: "mine" })).body.result, { n: 1 });
    } finally {
      await second.close();
    }
    assert.equal(existsSync(path.join(stateDir, "stores", "notes.json")), false);
  });
});

describe("the harness's call record", () => {
  it("records every call of a named routine value at its start as { kit: module, action: routine, args }, nested included", async () => {
    const h = createKitHarness();
    const leaf = defineRoutine({ name: "dig.down", args: z.object({ depth: z.number().default(2) }), returns: z.number() }, (_ctx, args) => args.depth);
    const unnamed = defineRoutine({}, () => 0);
    const top = defineRoutine({ name: "miner.mine" }, async (c) => {
      await unnamed(c);
      return (await leaf(c)) + (await leaf(c, { depth: 5 }));
    });
    assert.equal(await h.run(top), 7);
    assert.deepEqual(h.calls, [
      { kit: "miner", action: "mine", args: undefined },
      { kit: "dig", action: "down", args: undefined },
      { kit: "dig", action: "down", args: { depth: 5 } },
    ]);
    // Kit actions are recorded as before.
    await h.call("move.to", { position: { x: 1, y: 64, z: 0 } }).catch(() => {});
    assert.equal(h.calls.at(-1)?.kit, "move");
  });
});

describe("minebot-sdk/routine exports", () => {
  it("are defineRoutine, z, and the authoring values of the kit surface without action and defineKit", () => {
    const names = Object.keys(publicRoutine).sort();
    assert.deepEqual(names, [
      "Movements",
      "NamePattern",
      "Point",
      "Position",
      "SMELT_TICKS",
      "Vec3",
      "biomeAt",
      "burnTicks",
      "defineRoutine",
      "goals",
      "isAir",
      "isHostile",
      "nameMatcher",
      "pickFuel",
      "skyAbove",
      "smeltInputs",
      "smeltOutput",
      "toVec3",
      "withoutReserved",
      "within",
      "z",
    ].sort());
  });
});

/** The scope a run hands out, and what ends it, for the two places a run scope is made. */
interface Run {
  scope: ProgramScope;
  emitter: Pick<EventEmitter, "emit" | "listenerCount">;
}

type Ending = "end" | "stop" | "timeout";

/** Waits for the abort of `signal` and rejects with its reason: a run that only ends when stopped. */
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

/** One `ProgramRunner.call` that ends as `how` says, and the scope it handed out. */
async function bodyRun(how: Ending): Promise<Run> {
  const emitter = new EventEmitter();
  const runner = new ProgramRunner({ globals: () => ({}), events: () => emitter });
  const scopes = Promise.withResolvers<ProgramScope>();
  const ended = runner.call(
    async (scope) => {
      scopes.resolve(scope);
      if (how !== "end") await untilAborted(scope.signal);
    },
    { sourceDir: SCRATCH, ...(how === "timeout" && { timeoutMs: 20 }) },
  );
  const scope = await scopes.promise;
  if (how === "stop") assert.equal(runner.stop(), true);
  await ended;
  assert.equal(scope.signal.aborted, true);
  return { scope, emitter };
}

/** One `h.run` that ends as `how` says, and the context it handed out. */
async function harnessRun(how: Ending): Promise<Run> {
  const h = createKitHarness();
  const scopes = Promise.withResolvers<RoutineContext>();
  const ended = h.run(async (c) => {
    scopes.resolve(c);
    if (how !== "end") await untilAborted(c.signal);
  });
  const scope = await scopes.promise;
  if (how !== "end") h.abort(new Error(how === "timeout" ? "timeout" : "stopped"));
  await ended.catch(() => {});
  assert.equal(scope.signal.aborted, true);
  return { scope, emitter: h.bot };
}

describe("a run scope after the run's abort (mb-jg8)", () => {
  const places: [string, (how: Ending) => Promise<Run>][] = [
    ["ProgramRunner.call", bodyRun],
    ["the harness's h.run", harnessRun],
  ];
  for (const [place, make] of places) {
    for (const how of ["stop", "timeout", "end"] as const) {
      it(`${place}: after ${how}, on() registers nothing, a later emit reaches no handler, and sleep rejects`, async () => {
        const { scope, emitter } = await make(how);
        const before = emitter.listenerCount("x");
        let heard = 0;
        scope.on("x", () => void heard++);
        assert.equal(emitter.listenerCount("x"), before);
        emitter.emit("x");
        assert.equal(heard, 0);
        await assert.rejects(scope.sleep(10));
      });
    }
  }

  it("still delivers events to a subscription made while the run was live, until the run ends", async () => {
    const emitter = new EventEmitter();
    const runner = new ProgramRunner({ globals: () => ({}), events: () => emitter });
    let heard = 0;
    await runner.call(
      async (scope) => {
        scope.on("x", () => void heard++);
        emitter.emit("x");
      },
      { sourceDir: SCRATCH },
    );
    emitter.emit("x");
    assert.equal(heard, 1);
    assert.equal(emitter.listenerCount("x"), 0);
  });
});
