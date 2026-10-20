// `minebot-sdk/testing`: run kit actions in a test without a Minecraft server. The harness gives
// them the real framework (argument and result validation, `uses`, per-kit stores, the active
// set) over a fake Mineflayer bot on the real registry of the version the body targets. It
// tests decision logic, not physics; see `createKitHarness`.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { BUILTIN_KITS } from "../kit/index.ts";
import { type Kit, type KitAction, KitHost } from "../kit/kit.ts";
import type { KitRegistry } from "../kit/registry.ts";
import { JsonStore } from "../store.ts";
import { createFakeBot, type EntitySpec, type EquipmentSlot } from "./bot.ts";
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

/** One call of one action, as the framework ran it: nested calls through `ctx.kits` included. */
export interface RecordedCall {
  kit: string;
  action: string;
  /** The arguments as the caller passed them, before defaults. */
  args: unknown;
}

export interface KitHarness {
  /** The fake bot kits receive as `ctx.bot`. */
  readonly bot: Bot;
  /** The real kit host the actions run in. */
  readonly host: KitHost;
  /** Built-in kits as a program sees them: `await h.kit.crafter.make({ item: "stick" })`, typed. Kits outside `KitRegistry` go through `call`. */
  readonly kit: Readonly<KitRegistry>;
  /** Runs `"kit.action"` through the framework and resolves with its result. */
  call<R = unknown>(path: string, args?: unknown): Promise<R>;
  /** Every action call so far, in order. */
  readonly calls: readonly RecordedCall[];
  /** What kits passed to `ctx.log`. */
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
  /** Aborts the running program's signal, as stop and timeout do. */
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
  const kit = host.api(
    {
      log: (...args) => {
        logs.push(args.map(String).join(" "));
      },
      // Passes the clock, then yields a macrotask: polling loops (`while (!ready) await ctx.sleep(ms)`)
      // must let timers fire, or `within`, node:test timeouts, and a timed `abort()` could never run.
      sleep: async (ms) => {
        controller.signal.throwIfAborted();
        handle.advance(Math.ceil(ms / 50));
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.signal.throwIfAborted();
      },
      signal: controller.signal,
      on: (event, handler) => {
        bot.on(event as never, handler as never);
      },
    },
    bot,
  );

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
    abort: (reason) => controller.abort(reason ?? new Error("aborted")),
    furnaceAt: handle.furnaceAt,
  };
}
