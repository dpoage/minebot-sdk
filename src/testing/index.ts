// `minebot-sdk/testing`: run kit actions and routines in a test without a Minecraft server. The
// harness gives them the real framework (argument and result validation, `uses`, per-kit stores,
// the active set) over a fake Mineflayer bot on the real registry of the version the body targets.
// It tests decision logic, not physics; see `createKitHarness`.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { z } from "zod";
import { BUILTIN_KITS } from "../kit/index.ts";
import { type Kit, type KitAction, KitHost } from "../kit/kit.ts";
import type { KitRegistry } from "../kit/registry.ts";
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

export interface KitHarnessOptions {
  /** Kits under test. They join the built-in kits, and replace a built-in kit of the same name. */
  kits?: readonly Kit[];
  /** Offer the built-in kits, so `uses: ["move"]` resolves. Default true. */
  builtins?: boolean;
  /** Kits active at start; default: every offered kit. */
  active?: readonly string[];
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

/** One call of one action, as the framework ran it: nested calls through `ctx.kits` included. A routine value named `module.routine` records as kit `module`, action `routine`. */
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

export interface KitHarness {
  /** The fake bot kits receive as `ctx.bot`. */
  readonly bot: Bot;
  /** The real kit host the actions run in. */
  readonly host: KitHost;
  /** Built-in kits as a program sees them: `await h.kit.crafter.make({ item: "stick" })`, typed. Kits outside `KitRegistry` go through `call`. */
  readonly kit: Readonly<KitRegistry>;
  /** Runs `"kit.action"` through the framework and resolves with its result. */
  call<R = unknown>(path: string, args?: unknown): Promise<R>;
  /**
   * Runs a routine through the same `invokeRoutine` the body calls, with this harness's bot, logs,
   * clock, kits, notes, and in-memory `ctx.store` namespaces. `routine` is a `defineRoutine` value, a plain function
   * `(ctx, args) => result`, or a module namespace whose default export is one (`await import("./mine.ts")`).
   * Arguments and result are validated as in the body, with the same messages; the routine is
   * named "under test" in them. `ctx.status` and `ctx.wiki` throw `UnsupportedApiError`.
   *
   * Each call is one run, as in the body: its own `ctx`, whose `signal` `abort` stops and which is
   * aborted with `finished` once the call settles (a later `ctx.sleep` rejects), and whose `ctx.on`
   * handlers hear events only until then. Kit actions the routine calls run with that scope.
   */
  run<F extends RoutineFunction>(routine: F, args?: NoInfer<RunArgs<F>>): Promise<RunResult<F>>;
  run<M extends { readonly default: RoutineFunction }>(routine: M, args?: NoInfer<RunArgs<M["default"]>>): Promise<RunResult<M["default"]>>;
  /** Every action call so far, in order, and during `run` every call of a routine named `module.routine`, at its start. */
  readonly calls: readonly RecordedCall[];
  /**
   * What kits and routines passed to `ctx.log`. A routine run's lines (its kit calls' included) read
   * as the body's run log writes them, non-strings through `util.inspect`; lines from `call` and `kit` join `String`s.
   */
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
  /** Aborts the runs in progress, as stop and timeout do; with none in progress, the signal `call` and `kit` run actions with. */
  abort(reason?: unknown): void;
  /** The furnace at a position: what it holds and how far it has cooked. */
  furnaceAt(at: At): { input: { name: string; count: number } | null; fuel: { name: string; count: number } | null; output: { name: string; count: number } | null } | undefined;
}

/** Wraps a kit's actions so every call is recorded, nested ones too. */
function recording(kit: Kit, calls: RecordedCall[]): Kit {
  const actions: Record<string, KitAction> = {};
  for (const [name, act] of Object.entries(kit.actions)) {
    actions[name] = {
      ...act,
      invoke(ctx, args, label) {
        calls.push({ kit: kit.name, action: name, args });
        return act.invoke(ctx, args, label);
      },
    };
  }
  return Object.freeze({ ...kit, actions: Object.freeze(actions) });
}

/**
 * A test harness for kits. It runs actions through the real `KitHost` — arguments and results
 * are validated, `uses` limits what a kit can call, each kit gets an in-memory store — over a
 * fake bot built on the real registry:
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
 * <api>` when called, so a kit never carries on with an `undefined` where the real bot would act.
 */
export function createKitHarness(options: KitHarnessOptions = {}): KitHarness {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
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

  const own = new Set((options.kits ?? []).map((kit) => kit.name));
  const offered = [...(options.builtins === false ? [] : BUILTIN_KITS.filter((kit) => !own.has(kit.name))), ...(options.kits ?? [])].map((kit) => recording(kit, calls));
  const stores = new Map<string, JsonStore>();
  const host = new KitHost({
    kits: offered,
    stores: (name) => {
      let store = stores.get(name);
      if (!store) {
        store = JsonStore.memory();
        stores.set(name, store);
      }
      return store;
    },
    ...(options.active && { active: options.active }),
  });
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
  // What `call` and `kit` run actions with: the harness's log, clock, abort, and the bot's events.
  const scope: ProgramScope = {
    log: (...args) => {
      logs.push(args.map(String).join(" "));
    },
    sleep: sleepUntil(controller.signal),
    signal: controller.signal,
    on: (event, handler) => {
      bot.on(event as never, handler as never);
    },
  };
  const kit = host.api(scope, bot);
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
  } satisfies Omit<RoutineContext, keyof ProgramScope | "kit">;
  /** Records each call of a named routine value at its start, as `call` records a kit action; the routines `h.run` runs and the ones they call both pass through it. */
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
    const ctx = withObserver<RoutineContext>({ ...runScope, ...facilities, kit: host.api(runScope, bot) as unknown as Readonly<KitRegistry> }, observe);
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
    host,
    kit: kit as unknown as Readonly<KitRegistry>,
    async call(path, args) {
      const dot = path.indexOf(".");
      const [kitName, actionName] = dot < 0 ? [path, ""] : [path.slice(0, dot), path.slice(dot + 1)];
      const namespace = (kit as Record<string, Record<string, (args: unknown) => unknown> | undefined>)[kitName];
      if (!namespace) throw new Error(`no kit "${kitName}" is offered or active in this harness; offered: ${host.offered.join(", ")}`);
      const run = namespace[actionName];
      if (!run) throw new Error(`kit "${kitName}" has no action "${actionName}"; it has: ${Object.keys(namespace).join(", ") || "none"}`);
      return (await run(args)) as never;
    },
    run: run as KitHarness["run"],
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
      if (running.size === 0) controller.abort(why);
      for (const runAbort of running) runAbort.abort(why);
    },
    furnaceAt: handle.furnaceAt,
  };
}
