import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { defineRoutine, z, type RoutineContext } from "../src/routine/public.ts";
import { invokeRoutine } from "../src/routine/invoke.ts";

const ctx: RoutineContext = {
  bot: {} as Bot, // routines under test never touch the bot
  log: () => {},
  sleep: async () => {},
  signal: new AbortController().signal,
  on: () => {},
  notes: { list: () => [], get: () => undefined, set: (key, text) => ({ key, text, updated: "" }), delete: () => false },
  status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
};

// The context offers exactly these members; adding or dropping one fails to compile here.
const MEMBERS: Record<keyof RoutineContext, true> = { bot: true, log: true, sleep: true, signal: true, on: true, notes: true, status: true, kit: true, wiki: true };

describe("RoutineContext", () => {
  it("offers the bot, the run's tools, and the body's facilities, kit and wiki optionally", () => {
    assert.deepEqual(Object.keys(MEMBERS).sort(), ["bot", "kit", "log", "notes", "on", "signal", "sleep", "status", "wiki"]);
    const withOptional: RoutineContext = { ...ctx, kit: {} as NonNullable<RoutineContext["kit"]>, wiki: { search: () => [], read: () => "", list: () => [] } };
    assert.ok(withOptional.wiki && withOptional.kit);
    // The handler of the run-scoped subscription is the one a program's `on` takes, so the host assigns its scope's `on` without a cast.
    ctx.on("chat", (...args) => void args);
  });
});

describe("invokeRoutine", () => {
  it("calls a plain function with the context and the arguments as given and awaits it", async () => {
    const seen: unknown[] = [];
    const module = { default: async (c: RoutineContext, args: unknown) => (seen.push(c, args), { answer: 42 }) };
    assert.deepEqual(await invokeRoutine(module, "plain", ctx, { n: "1" }), { answer: 42 });
    assert.deepEqual(seen, [ctx, { n: "1" }]);
  });

  it("calls a routine declared with no schemas with its arguments unvalidated", async () => {
    const module = { default: defineRoutine({ description: "echo" }, (_ctx, args) => args) };
    assert.deepEqual(await invokeRoutine(module, "echo", ctx, { anything: [1] }), { anything: [1] });
  });

  it("hands the routine the parsed arguments, defaults applied", async () => {
    const module = {
      default: defineRoutine({ args: z.object({ n: z.number().default(3), label: z.string() }) }, (_ctx, args) => {
        const n: number = args.n;
        return `${args.label}:${n}`;
      }),
    };
    assert.equal(await invokeRoutine(module, "label", ctx, { label: "x" }), "x:3");
    assert.equal(await invokeRoutine(module, "label", ctx, { label: "x", n: 5 }), "x:5");
  });

  it("treats absent arguments as {}: a defaulted schema gets its defaults, a plain function gets {}", async () => {
    const defaulted = { default: defineRoutine({ args: z.object({ n: z.number().default(3) }) }, (_ctx, args) => args.n) };
    assert.equal(await invokeRoutine(defaulted, "defaulted", ctx, undefined), 3);
    assert.deepEqual(await invokeRoutine({ default: (_ctx: RoutineContext, args: unknown) => args }, "plain", ctx, undefined), {});
    // Only absence is defaulted: null is an argument, and the schema refuses it.
    await assert.rejects(invokeRoutine(defaulted, "defaulted", ctx, null), /routine "defaulted" arguments: /);
  });

  it("rejects arguments that do not match, naming the routine and the schema, without calling it", async () => {
    let calls = 0;
    const module = { default: defineRoutine({ args: z.object({ n: z.number() }) }, () => void calls++) };
    await assert.rejects(invokeRoutine(module, "counter", ctx, { n: "one" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /routine "counter"/);
      assert.match(error.message, /"n"/);
      assert.match(error.message, /"type":"number"/);
      return true;
    });
    assert.equal(calls, 0);
  });

  it("returns the value its returns schema validates, and rejects one that does not, naming the routine and the schema", async () => {
    const returns = z.object({ ok: z.boolean() });
    const good = { default: defineRoutine({ returns }, async () => ({ ok: true })) };
    assert.deepEqual(await invokeRoutine(good, "good", ctx, undefined), { ok: true });
    // Typed: a result that is not the schema's input is a compile error.
    // @ts-expect-error `ok` must be a boolean
    defineRoutine({ returns }, () => ({ ok: "yes" }));
    const declared = { default: defineRoutine({ returns }, (() => ({ ok: "yes" })) as never) };
    await assert.rejects(invokeRoutine(declared, "bad", ctx, undefined), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /routine "bad" returned a value that does not match its returns schema/);
      assert.match(error.message, /"ok"/);
      assert.match(error.message, /"type":"boolean"/);
      return true;
    });
  });

  it("rejects a module whose default export is not a function, naming the routine and what it exports", async () => {
    const cases: [unknown, RegExp][] = [
      [{ default: 3 }, /its default export is of type number/],
      [{ default: null }, /its default export is null/],
      [{ default: "x", extra: 1 }, /its default export is of type string \(other exports: extra\)/],
      [{ run: () => 1, other: 2 }, /no default export \(it exports: run, other\)/],
      [{}, /it exports nothing/],
      [undefined, /the module is undefined/],
    ];
    for (const [module, expected] of cases) {
      await assert.rejects(invokeRoutine(module, "broken", ctx, {}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /routine "broken" must default-export a function/);
        assert.match(error.message, expected);
        return true;
      });
    }
  });

  it("rejects what a routine throws and what it rejects with", async () => {
    await assert.rejects(invokeRoutine({ default: () => { throw new Error("sync"); } }, "x", ctx, {}), /sync/);
    await assert.rejects(invokeRoutine({ default: async () => { throw new Error("async"); } }, "x", ctx, {}), /async/);
  });

  it("refuses to declare a routine whose schemas are not schemas or whose body is not a function", () => {
    assert.throws(() => defineRoutine({ args: {} as z.ZodType }, () => 1), /args must be a zod schema/);
    assert.throws(() => defineRoutine({ returns: "x" as unknown as z.ZodType }, () => 1), /returns must be a zod schema/);
    assert.throws(() => defineRoutine({}, 1 as unknown as () => void), /needs a function/);
  });
});
