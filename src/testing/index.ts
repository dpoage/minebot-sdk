// `minebot-sdk/testing`: run routines in a test without a Minecraft server. The harness gives them
// the body's routine contract (argument and result validation, `ctx.store` namespaces, call
// observation) over a fake Mineflayer bot on the real registry of the version the body targets.
// It tests decision logic, not physics; see `createHarness`.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { z } from "zod";
import { Notes } from "../notes.ts";
import { formatLogLine } from "../program/runner.ts";
import type { ProgramScope } from "../program/scope.ts";
import { JsonStore } from "../store.ts";
import type { RoutineContext } from "../routine/context.ts";
import { checkStoreNamespace, type RoutineCallObserver, withObserver } from "../routine/define.ts";
import { invokeRoutine } from "../routine/invoke.ts";
import type { Routine } from "../routine/public.ts";
import { createFakeBot, type EntitySpec, type EquipmentSlot } from "./bot.ts";
import { UnsupportedApiError } from "./strict.ts";
import { type At, type BlockSpec, type Ground, vec } from "./world.ts";

export { UnsupportedApiError } from "./strict.ts";
export type { EntitySpec, EquipmentSlot } from "./bot.ts";
export type { At, BlockSpec, Ground } from "./world.ts";

export interface HarnessOptions {
  /** What the bot carries: item name to count. */
  inventory?: Readonly<Record<string, number>>;
  /** Items from `inventory` to hold or wear at start. */
  equipment?: Readonly<Partial<Record<EquipmentSlot, string>>>;
  /** Blocks to set: one at `at`, or a box from `from` to `to`. They win over the ground. */
  blocks?: readonly BlockSpec[];
  /** The flat ground layer under the bot: `{ y, name }`, default stone at y 63. `false` for a world of air. */
  ground?: Ground | false;
  /** Creatures, players, and dropped items to place. */
  entities?: readonly EntitySpec[];
  /** Where the bot's feet are. Default (0.5, 64, 0.5), on the ground layer. */
  position?: At;
  /** Ticks since dawn, 0 to 23999. Default 1000 (morning). */
  time?: number;
  health?: number;
  food?: number;
  username?: string;
}

/** One call of a routine value declared with a `module.routine` name (the built-in routines), as the call observer saw it: nested calls included. `kit` is the module part of the name and `action` the routine part. A routine value without such a name is not recorded. */
export interface RecordedCall {
  kit: string;
  action: string;
  /** The arguments as the caller passed them, before defaults. */
  args: unknown;
}

/** A function of the context and its arguments, as a module's default export. */
type RoutineFunction = (ctx: RoutineContext, args: never) => unknown;
/**
 * The function's own parameter and result, when `defineRoutine` declared no schema for them (a
 * schema-less `defineRoutine` value reads as `unknown` either way). A `never` parameter is the
 * compiler checking `args` before it has inferred the routine from an inline function: it reads as `unknown`.
 */
type PlainArgs<F> = F extends (ctx: never, args: infer P) => unknown ? ([P] extends [never] ? unknown : P) : never;
type PlainResult<F> = F extends (...args: never) => infer X ? Awaited<X> : never;
/** A `defineRoutine` value carries its schemas in its type: callers pass the schema's input, and get its output, as `invokeRoutine` does. */
type RunArgs<F> = F extends Routine<infer A, infer _R> ? (z.ZodType extends A ? PlainArgs<F> : z.input<A>) : PlainArgs<F>;
type RunResult<F> = F extends Routine<infer _A, infer R> ? (z.ZodType extends R ? PlainResult<F> : z.output<R>) : PlainResult<F>;

export interface Harness {
  /** The fake bot routines receive as `ctx.bot`. */
  readonly bot: Bot;
  /**
   * Runs a routine through the same `invokeRoutine` the body calls, with this harness's bot, logs,
   * clock, notes, and in-memory `ctx.store` namespaces (a value set in one run is read in the next). `routine` is a `defineRoutine` value, a plain function
   * `(ctx, args) => result`, or a module namespace whose default export is one (`await import("./mine.ts")`).
   * Arguments and result are validated as in the body, with the same messages; the routine is
   * named "under test" in them. `ctx.status` and `ctx.wiki` throw `UnsupportedApiError`.
   *
   * Each call is one run, as in the body: its own `ctx`, whose `signal` `abort` stops and which is
   * aborted with `finished` once the call settles (a later `ctx.sleep` rejects), and whose `ctx.on`
   * handlers hear events only until then. Routines this one calls by import run with that scope; those named `module.routine` are recorded in `calls`.
   */
  run<F extends RoutineFunction>(routine: F, args?: NoInfer<RunArgs<F>>): Promise<RunResult<F>>;
  run<M extends { readonly default: RoutineFunction }>(routine: M, args?: NoInfer<RunArgs<M["default"]>>): Promise<RunResult<M["default"]>>;
  /** Every call so far of a routine value named `module.routine` (the built-in routines), in the order the calls started: the one `run` runs and the ones it calls. */
  readonly calls: readonly RecordedCall[];
  /** What routines passed to `ctx.log`, as the body's run log writes the lines: non-strings through `util.inspect`. */
  readonly logs: readonly string[];
  /** What the bot said with `bot.chat`. */
  readonly chat: readonly string[];
  /** Inventory totals by item name. */
  readonly inventory: Readonly<Record<string, number>>;
  /** How many of `name` the inventory holds. */
  count(name: string): number;
  /** Adds items to the inventory. */
  give(name: string, count?: number): void;
  /** The block at a position. */
  blockAt(at: At): Block;
  /** Sets a block. */
  setBlock(at: At, name: string, properties?: Record<string, unknown>): Block;
  /** Where the bot's feet are. */
  readonly position: Vec3;
  /** Moves the bot without pathfinding. */
  teleport(at: At): void;
  /** Places a creature, player, or dropped item. */
  spawn(spec: EntitySpec): Entity;
  /** Entities in the world besides the bot: creatures, players, and dropped items. */
  readonly entities: readonly Entity[];
  /** Passes game ticks (20 per second): the clock moves and furnaces cook. `ctx.sleep(ms)` passes `ms / 50`. */
  advance(ticks: number): void;
  /** Aborts the runs in progress, as stop and timeout do; with none in progress it does nothing. */
  abort(reason?: unknown): void;
  /** The furnace at a position: what it holds and how far it has cooked. */
  furnaceAt(at: At): { input: { name: string; count: number } | null; fuel: { name: string; count: number } | null; output: { name: string; count: number } | null } | undefined;
}

/**
 * A test harness for routines. It runs a routine through the real `invokeRoutine`: arguments and
 * results are validated, and each call of a routine value named `module.routine` (the built-in routines) is observed (`calls`). The harness
 * keeps a notepad and `ctx.store` namespaces in memory, over a fake bot built on the real registry:
 *
 * - A block world: `blockAt`, `findBlock(s)`, a flat ground layer plus the blocks you set.
 *   Digging removes the block and drops its items (walk over them to pick them up); placing
 *   sets a block and spends the held item. Blocks and tools are the real prismarine ones, so
 *   harvest-tool rules hold.
 * - An inventory with Mineflayer's slots: `items()`, `equip`, `toss`, `heldItem`, and crafting
 *   with the real recipes (`recipesFor`, `recipesAll`, `craft`).
 * - Entities, time, health, and food, and furnaces that cook on the clock.
 * - A pathfinder whose `goto` and `setGoal` teleport to the nearest standable spot that
 *   satisfies the goal. Digging, placing, and opening furnaces are limited to 4.5 blocks.
 *
 * Scope is decision logic. Every Mineflayer API outside the above (`bot.attack`, `bot.sleep`,
 * `bot.openContainer`, `bot.world.raycast`, ...) throws `not supported by minebot-sdk/testing:
 * <api>` when called, so a routine never carries on with an `undefined` where the real bot would act.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const ground = options.ground === false ? null : (options.ground ?? { y: 63, name: "stone" });
  const handle = createFakeBot({
    blocks: options.blocks ?? [],
    ground,
    inventory: options.inventory ?? {},
    equipment: options.equipment ?? {},
    entities: options.entities ?? [],
    position: options.position ?? [0.5, (ground?.y ?? 63) + 1, 0.5],
    time: options.time ?? 1000,
    health: options.health ?? 20,
    food: options.food ?? 20,
    username: options.username ?? "harness",
  });
  const { bot } = handle;

  // The clock's sleep for a scope that `signal` aborts. It passes the clock, then yields a macrotask: polling
  // loops (`while (!ready) await ctx.sleep(ms)`) must let timers fire, or `within`, node:test timeouts, and a timed `abort()` could never run.
  const sleepUntil =
    (signal: AbortSignal) =>
    async (ms: number): Promise<void> => {
      signal.throwIfAborted();
      handle.advance(Math.ceil(ms / 50));
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    };
  // The body's notepad over a store that never touches the disk; it belongs to the harness, not to one run.
  const notes = new Notes(JsonStore.memory());
  /** `ctx.store` namespaces, in memory and per harness, under the body's namespace rule. */
  const routineStores = new Map<string, JsonStore>();
  const facilities = {
    bot,
    notes: {
      list: () => notes.list(),
      get: (key) => notes.get(key)?.text,
      set: (key, text) => notes.set(key, text),
      delete: (key) => notes.delete(key),
    },
    status: () => {
      throw new UnsupportedApiError("ctx.status");
    },
    wiki: {
      search: () => {
        throw new UnsupportedApiError("ctx.wiki.search");
      },
      read: () => {
        throw new UnsupportedApiError("ctx.wiki.read");
      },
      list: () => {
        throw new UnsupportedApiError("ctx.wiki.list");
      },
    },
    store: (namespace) => {
      checkStoreNamespace(namespace);
      let store = routineStores.get(namespace);
      if (!store) {
        store = JsonStore.memory();
        routineStores.set(namespace, store);
      }
      return store;
    },
  } satisfies Omit<RoutineContext, keyof ProgramScope>;
  /** Records each call of a routine value named `module.routine` at its start; the routines `h.run` runs and the ones they call both pass through it. */
  const observe: RoutineCallObserver = ({ name, args }) => {
    const dot = name?.indexOf(".") ?? -1;
    if (name && dot > 0) calls.push({ kit: name.slice(0, dot), action: name.slice(dot + 1), args });
    return () => {};
  };
  /** The runs in progress, by their abort: what `abort` stops. */
  const running = new Set<AbortController>();

  /** One `h.run`: a run scope of its own, as `ProgramRunner.call` gives a routine in the body. */
  async function run(routine: unknown, args: unknown): Promise<unknown> {
    const runAbort = new AbortController();
    const { signal } = runAbort;
    const subscriptions: [string, (...args: unknown[]) => void][] = [];
    // Stop and the end of the run both abort the signal; either way the run's handlers hear nothing more.
    signal.addEventListener(
      "abort",
      () => {
        for (const [event, handler] of subscriptions.splice(0)) bot.off(event as never, handler as never);
      },
      { once: true },
    );
    const runScope: ProgramScope = {
      log: (...values) => {
        logs.push(formatLogLine(values));
      },
      sleep: sleepUntil(signal),
      signal,
      on: (event, handler) => {
        if (signal.aborted) return;
        bot.on(event as never, handler as never);
        subscriptions.push([event, handler]);
      },
    };
    const ctx = withObserver<RoutineContext>({ ...runScope, ...facilities }, observe);
    running.add(runAbort);
    try {
      return await invokeRoutine(typeof routine === "function" ? { default: routine } : routine, "under test", ctx, args);
    } finally {
      running.delete(runAbort);
      if (!signal.aborted) runAbort.abort(new Error("finished"));
    }
  }

  return {
    bot,
    run: run as Harness["run"],
    calls,
    logs,
    chat: handle.chat,
    get inventory() {
      return handle.inventory.totals();
    },
    count: (name) => handle.inventory.totals()[name.replace(/^minecraft:/, "")] ?? 0,
    give(name, count = 1) {
      const stack = handle.inventory.make(name, 1);
      if (handle.inventory.add(stack.type, count) > 0) throw new Error(`the inventory has no room for ${count} ${name}`);
    },
    blockAt: (at) => handle.world.blockAt(vec(at)),
    setBlock: (at, name, properties) => handle.world.setBlock(at, name, properties),
    get position() {
      return bot.entity.position.clone();
    },
    teleport(at) {
      bot.entity.position = vec(at);
    },
    spawn: handle.spawn,
    get entities() {
      return handle.others();
    },
    advance: handle.advance,
    abort(reason) {
      const why = reason ?? new Error("aborted");
      for (const runAbort of running) runAbort.abort(why);
    },
    furnaceAt: handle.furnaceAt,
  };
}
