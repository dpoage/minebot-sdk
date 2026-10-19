// The kit framework: composable libraries of typed actions. Programs call them namespaced —
// `await kit.move.to({ position })` — and a kit's actions call the kits it declared in `uses`
// through `ctx.kits`, so routine kits are built from public primitives exactly the way an
// agent's own kits are. This module imports no body code; the composition root injects the
// catalog, the per-kit stores, and the bot.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { z } from "zod";
import type { Within } from "../mc/within.ts";
import { biomeAt } from "../mc/biome.ts";
import { within } from "../mc/within.ts";
import { isHostile } from "../mc/hostile.ts";
import { NamePattern, nameMatcher } from "../mc/names.ts";
import { isAir, type SkyView, skyAbove } from "../mc/sky.ts";
import { burnTicks, pickFuel, SMELT_TICKS, smeltInputs, smeltOutput, withoutReserved } from "../mc/smelting.ts";
import { Position, toVec3 } from "../mc/position.ts";
import { KitName, type KitInfo, type KitSearchHit } from "../protocol/index.ts";
import type { ProgramScope } from "../program/scope.ts";
import { JsonStore } from "../store.ts";
import { actionReference, kitReference } from "./doc.ts";
import { documentsOf, rank } from "./search.ts";
import type { KitStats } from "./stats.ts";

// What a kit file may import, beyond zod and vec3: the framework itself. Everything else a kit
// needs arrives through the action context. `minebot kits source <kit>` shows this working.
const { goals, Movements } = pathfinderPkg;
export { goals, Movements };
export { NamePattern, nameMatcher };
export { Position, toVec3 };
export { isAir, skyAbove, type SkyView };
export { biomeAt };
export { isHostile };
export { burnTicks, pickFuel, SMELT_TICKS, smeltInputs, smeltOutput, withoutReserved };
export { within, type Within };
export type { Block } from "prismarine-block";
export type { Chest, Furnace } from "mineflayer";
export type { Item } from "prismarine-item";
export type { Entity } from "prismarine-entity";
export type { Vec3 } from "vec3";
/** One kit's actions as a caller sees them: `kits.move.to({ ... })`. Only the kits a kit declared in `uses` (or the active kits, for programs) appear. */
export type KitCalls = Readonly<Record<string, Readonly<Record<string, (args: unknown) => unknown>>>>;

/** What a kit action receives: the calling program's scope, the bot, a time limit, the kits this kit uses, and this kit's own store. */
export interface KitContext extends ProgramScope {
  readonly bot: Bot;
  /** Rejects work that runs longer than `ms` after running `cancel`; pathfinding and digging can otherwise wait forever. */
  readonly within: Within;
  /** The kits listed in this kit's `uses`, namespaced: `ctx.kits.move.to({ position })`. */
  readonly kits: KitCalls;
  /** JSON state scoped to this kit alone; it survives programs, kit swaps, and body restarts, and no other kit can read it. */
  readonly store: JsonStore;
}

export interface KitAction {
  readonly doc: string;
  readonly args: z.ZodObject;
  invoke(ctx: KitContext, args: unknown, label: string): unknown;
}

/**
 * Declares one action. Every action takes a single object argument described by a zod object
 * schema; the argument is validated on every call, nested calls included, and a bad call fails
 * with the schema in the error. `doc` documents what the action does and returns.
 */
export function action<S extends z.ZodObject>(spec: {
  doc: string;
  args: S;
  run: (ctx: KitContext, args: z.output<S>) => unknown;
}): KitAction {
  if (!(spec.args instanceof z.ZodObject)) throw new Error("action args must be a z.object(...)");
  return {
    doc: spec.doc,
    args: spec.args,
    invoke(ctx, args, label) {
      // Actions take one object argument; a call with none reads as the empty object, and any
      // argument the schema requires is then reported by the schema itself.
      const parsed = spec.args.safeParse(args ?? {});
      if (!parsed.success) {
        const [kitName = "", actionName = ""] = label.split(".");
        throw new Error(`kit.${label} arguments: ${z.prettifyError(parsed.error)}\nexpected:\n${actionReference(kitName, actionName, spec.args)}`);
      }
      return spec.run(ctx, parsed.data);
    },
  };
}

export interface Kit {
  readonly name: string;
  readonly description: string;
  /** Kits whose actions this kit calls; activating this kit activates them. */
  readonly uses: readonly string[];
  readonly actions: Readonly<Record<string, KitAction>>;
}

/** True for values defineKit produced: the shape a compiled kit must have. */
export function isKit(value: unknown): value is Kit {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || !("description" in value) || !("uses" in value) || !("actions" in value)) return false;
  return typeof value.name === "string" && typeof value.description === "string" && Array.isArray(value.uses) && typeof value.actions === "object" && value.actions !== null;
}

const ACTION_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;

function isKitAction(value: unknown): value is KitAction {
  if (typeof value !== "object" || value === null) return false;
  if (!("doc" in value) || !("args" in value) || !("invoke" in value)) return false;
  return (
    typeof value.doc === "string" &&
    typeof value.args === "object" &&
    value.args !== null &&
    "safeParse" in value.args &&
    typeof value.args.safeParse === "function" &&
    typeof value.invoke === "function"
  );
}
export function defineKit(spec: {
  name: string;
  description: string;
  /** Kits this kit calls through `ctx.kits`; they activate together with this kit. */
  uses?: readonly string[];
  actions: Record<string, unknown>;
}): Kit {
  const name = KitName.safeParse(spec.name);
  if (!name.success) throw new Error(`kit name "${String(spec.name)}": ${name.error.issues[0]?.message ?? "invalid"}`);
  if (typeof spec.description !== "string" || spec.description.length === 0 || spec.description.length > 400) {
    throw new Error(`kit "${spec.name}" needs a description of 1-400 characters`);
  }
  const uses = spec.uses ?? [];
  if (!Array.isArray(uses) || uses.some((dep) => !KitName.safeParse(dep).success)) {
    throw new Error(`kit "${spec.name}" uses must be a list of kit names`);
  }
  if (new Set(uses).size !== uses.length) throw new Error(`kit "${spec.name}" lists a kit in uses twice`);
  if (typeof spec.actions !== "object" || spec.actions === null || Array.isArray(spec.actions)) {
    throw new Error(`kit "${spec.name}" needs an actions object`);
  }
  const actions: Record<string, KitAction> = {};
  for (const [name, value] of Object.entries(spec.actions)) {
    if (!ACTION_NAME_PATTERN.test(name)) throw new Error(`kit "${spec.name}" action name "${name}" must match ${ACTION_NAME_PATTERN}`);
    if (!isKitAction(value)) throw new Error(`kit "${spec.name}" action "${name}" must be declared with action({ doc, args, run })`);
    actions[name] = value;
  }
  return Object.freeze({ name: spec.name, description: spec.description, uses: Object.freeze([...uses]), actions: Object.freeze(actions) });
}

/** The throwaway store of one kit in a trial: created on first use, shared by every call of that kit within the trial, never written to disk. */
function trialStore(trial: Map<string, JsonStore>, kit: string): JsonStore {
  let store = trial.get(kit);
  if (!store) {
    store = JsonStore.memory();
    trial.set(kit, store);
  }
  return store;
}

export class KitLockedError extends Error {
  constructor() {
    super("kits are locked on this body");
  }
}

export interface KitHostOptions {
  /** The kits this body offers. */
  kits: readonly Kit[];
  /** Persistent JSON state per kit; one kit never sees another's. */
  stores: (kit: string) => JsonStore;
  /** Kits active at start; default: every offered kit. */
  active?: readonly string[];
  /** Forbid changing the active kits while the body runs. */
  locked?: boolean;
  /** Which offered kits agents saved on this body; used for the kit listing. */
  agent?: (name: string) => boolean;
  /** Counts every call of every action; the listing and search show the counts. */
  stats?: KitStats;
}

/**
 * The kits a body offers and the set that is active. The catalog is mutable: an agent kit saved
 * while the body runs is added, a removed one disappears. Calls go through the active set at
 * call time, so `kits.use(...)` takes effect on the next call.
 */
export class KitHost {
  readonly #kits = new Map<string, Kit>();
  readonly #stores: (kit: string) => JsonStore;
  readonly #agent: (name: string) => boolean;
  readonly #stats: KitStats | undefined;
  readonly #locked: boolean;
  #active: string[] = [];

  constructor(options: KitHostOptions) {
    this.#stores = options.stores;
    this.#agent = options.agent ?? (() => false);
    this.#stats = options.stats;
    for (const kit of options.kits) this.#register(kit);
    this.#active = options.active ? this.resolve(options.active) : [...this.#kits.keys()];
    this.#locked = options.locked ?? false;
  }

  /** Registers or replaces a kit in the catalog. A saved kit that replaces its own earlier version keeps its place. */
  #register(kit: Kit): void {
    this.#kits.set(kit.name, kit);
  }

  /**
   * Adds a kit saved while the body runs: offered from now on, and active immediately unless the
   * set is locked. When the kit's uses do not resolve, the catalog is left unchanged and the
   * error names the problem.
   */
  add(kit: Kit): void {
    const wasActive = this.#active.includes(kit.name);
    this.update(kit);
    if (this.#locked || wasActive) return;
    try {
      this.use([...this.#active, kit.name]);
    } catch (err) {
      this.remove(kit.name);
      this.#active = wasActive ? [...this.#active, kit.name] : this.#active;
      throw err;
    }
  }

  /** Replaces a kit's definition, keeping its place in the catalog and the active set. */
  update(kit: Kit): void {
    this.#register(kit);
  }

  /** Drops a kit from the catalog and the active set. */
  remove(name: string): void {
    this.#kits.delete(name);
    this.#active = this.#active.filter((active) => active !== name);
  }

  /** Every offered kit's name. */
  get offered(): string[] {
    return [...this.#kits.keys()];
  }

  get locked(): boolean {
    return this.#locked;
  }

  /** Active kits, including the kits they use, in activation order. */
  get active(): string[] {
    return [...this.#active];
  }

  /** Replaces the active set. Returns the resolved set, including used kits. */
  use(names: readonly string[]): string[] {
    if (this.#locked) throw new KitLockedError();
    this.#active = this.resolve(names);
    return this.active;
  }

  /** One kit's listing entry, regardless of the lock. */
  infoFor(kit: Kit): KitInfo {
    return {
      name: kit.name,
      description: kit.description,
      uses: [...kit.uses],
      active: this.#active.includes(kit.name),
      agent: this.#agent(kit.name),
      actions: Object.keys(kit.actions),
      stats: this.#stats?.forKit(kit.name) ?? {},
    };
  }

  /** The kits an agent can learn about: all of them, or only the active ones when the set is locked. */
  info(): KitInfo[] {
    return [...this.#kits.values()]
      .filter((kit) => !this.#locked || this.#active.includes(kit.name))
      .map((kit) => this.infoFor(kit));
  }

  /**
   * Ranks the kits and actions this body lists against `query`: names, kit descriptions, and
   * action docs. A locked body searches only its active kits.
   */
  search(query: string, limit = 5): KitSearchHit[] {
    const listed = [...this.#kits.values()].filter((kit) => this.#listed(kit.name));
    return rank(documentsOf(listed), query)
      .slice(0, limit)
      .map(({ document, score }) => {
        const stats = document.action === undefined ? undefined : this.#stats?.forKit(document.kit)[document.action];
        return {
          kit: document.kit,
          ...(document.action !== undefined && { action: document.action }),
          score: Math.round(score * 100) / 100,
          text: document.text,
          active: this.#active.includes(document.kit),
          ...(stats && { stats }),
        };
      });
  }

  /**
   * Reference text for the named kits, or for the active kits when `names` is empty.
   * A locked set documents only its active kits.
   */
  docs(names: readonly string[] = []): string {
    const selected = names.length > 0 ? this.resolve(names) : this.#active;
    if (this.#locked) {
      const hidden = selected.find((name) => !this.#active.includes(name));
      if (hidden !== undefined) throw new Error(`unknown kit "${hidden}"`);
    }
    if (selected.length === 0) {
      if (this.#locked) throw new Error("no kits are available on this body");
      return `No kits are active. Available kits: ${[...this.#kits.keys()].join(", ")}`;
    }
    return selected.map((name) => kitReference(this.#kits.get(name)!)).join("\n\n");
  }

  /** The context one kit's actions run with: the caller's scope, the bot, this kit's store, and only the kits it uses. In a trial, every kit's store is a throwaway. */
  #contextFor(kit: Kit, scope: ProgramScope, bot: Bot, trial?: Map<string, JsonStore>): KitContext {
    const host = this;
    const kits: KitCalls = new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== "string" || !kit.uses.includes(name)) return undefined;
          const used = host.offeredKit(name);
          return used ? host.#namespace(used, scope, bot, trial) : undefined;
        },
        has: (_, name) => typeof name === "string" && kit.uses.includes(name) && this.#kits.has(name),
        ownKeys: () => [...kit.uses].filter((name) => this.#kits.has(name)),
        getOwnPropertyDescriptor: (_, name) =>
          typeof name === "string" && kit.uses.includes(name) && this.#kits.has(name)
            ? { configurable: true, enumerable: true, writable: false, value: undefined }
            : undefined,
      },
    );
    return { ...scope, bot, within, store: trial ? trialStore(trial, kit.name) : this.#stores(kit.name), kits };
  }

  /**
   * The `kit` object programs see: `kit.<kit>.<action>({ ... })`. Lookups go through the active
   * set at call time, so a program that calls `kits.use(...)` can use the new kits immediately.
   * On a locked body, kits that are not active read as nonexistent.
   */
  api(scope: ProgramScope, bot: Bot): KitCalls {
    const host = this;
    return new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== "string") return undefined;
          const kit = host.offeredKit(name);
          if (!kit || (host.locked && !host.active.includes(name))) return undefined;
          return host.#namespace(kit, scope, bot);
        },
        has: (_, name) => typeof name === "string" && this.#listed(name),
        ownKeys: () => this.#listedNames(),
        getOwnPropertyDescriptor: (_, name) =>
          typeof name === "string" && this.#listed(name) ? { configurable: true, enumerable: true, writable: false, value: undefined } : undefined,
      },
    ) as KitCalls;
  }

  /**
   * The `kits` object programs see: `use` only when the set can change, and save, remove, source,
   * versions, revert, and try only when the body offers agent kits.
   */
  controller(
    deps: {
      switching?: boolean;
      save?: (source: string) => Promise<unknown>;
      remove?: (name: string) => Promise<void>;
      source?: (name: string) => string;
      versions?: (name: string) => Promise<unknown>;
      revert?: (name: string, version: number) => Promise<unknown>;
      try?: (source: string, run: { action: string; args?: unknown }) => Promise<unknown>;
    } = {},
  ): {
    readonly active: string[];
    readonly locked: boolean;
    readonly agentKits: boolean;
    available: () => KitInfo[];
    use?: (...names: string[]) => string[];
    docs: (...names: string[]) => string;
    search: (query: string, limit?: number) => KitSearchHit[];
    save?: (source: string) => Promise<unknown>;
    remove?: (name: string) => Promise<void>;
    source?: (name: string) => string;
    versions?: (name: string) => Promise<unknown>;
    revert?: (name: string, version: number) => Promise<unknown>;
    try?: (source: string, run: { action: string; args?: unknown }) => Promise<unknown>;
  } {
    const host = this;
    return {
      get active() {
        return host.active;
      },
      get locked() {
        return host.locked;
      },
      get agentKits() {
        return deps.save !== undefined;
      },
      available: () => host.info(),
      // Accept kits.use("a,b") and kits.use("a b") as well as kits.use("a", "b").
      ...(deps.switching && { use: (...names: string[]) => host.use(names.flatMap((n) => n.split(/[\s,]+/).filter(Boolean))) }),
      docs: (...names) => host.docs(names.flatMap((n) => n.split(/[\s,]+/).filter(Boolean))),
      search: (query, limit) => host.search(query, limit),
      ...(deps.save && { save: deps.save }),
      ...(deps.remove && { remove: deps.remove }),
      ...(deps.source && { source: deps.source }),
      ...(deps.versions && { versions: deps.versions }),
      ...(deps.revert && { revert: deps.revert }),
      ...(deps.try && { try: deps.try }),
    };
  }

  /** Resolves names to an activation order: each kit after the kits it uses, cycles and unknown names rejected. */
  resolve(names: readonly string[]): string[] {
    const order: string[] = [];
    const visit = (name: string, path: string[]) => {
      if (order.includes(name)) return;
      if (path.includes(name)) throw new Error(`kit dependency cycle: ${[...path, name].join(" -> ")}`);
      const kit = this.#kits.get(name);
      if (!kit) {
        const known = this.#locked ? `unknown kit "${name}"` : `unknown kit "${name}"; available: ${[...this.#kits.keys()].join(", ")}`;
        throw new Error(known);
      }
      for (const dep of kit.uses) visit(dep, [...path, name]);
      order.push(name);
    };
    for (const name of names) visit(name, []);
    return order;
  }

  offeredKit(name: string): Kit | undefined {
    return this.#kits.get(name);
  }

  /**
   * Runs one action of a kit that is not in the catalog, once. Nothing is registered, written, or
   * counted: the kit and the kits it uses get throwaway stores, and no call adds to the statistics.
   * The kit's `uses` must be offered and active, as for a saved kit.
   */
  tryKit(kit: Kit, actionName: string, args: unknown, scope: ProgramScope, bot: Bot): unknown {
    const action = Object.hasOwn(kit.actions, actionName) ? kit.actions[actionName] : undefined;
    if (!action) throw new Error(`kit "${kit.name}" has no action "${actionName}"; it has: ${Object.keys(kit.actions).join(", ") || "none"}`);
    return action.invoke(this.#contextFor(kit, scope, bot, new Map()), args, `${kit.name}.${actionName}`);
  }

  /** One kit's actions as callable functions. */
  #namespace(kit: Kit, scope: ProgramScope, bot: Bot, trial?: Map<string, JsonStore>): Readonly<Record<string, (args: unknown) => unknown>> {
    const host = this;
    return new Proxy(
      {},
      {
        get: (_, action) => {
          if (typeof action !== "string" || !(action in kit.actions)) return undefined;
          return (args: unknown) => host.#invoke(kit, action, scope, bot, args, trial);
        },
        has: (_, action) => typeof action === "string" && action in kit.actions,
        ownKeys: () => Object.keys(kit.actions),
        getOwnPropertyDescriptor: (_, action) =>
          typeof action === "string" && action in kit.actions ? { configurable: true, enumerable: true, writable: false, value: undefined } : undefined,
      },
    );
  }

  #invoke(kit: Kit, action: string, scope: ProgramScope, bot: Bot, args: unknown, trial?: Map<string, JsonStore>): unknown {
    if (!this.#active.includes(kit.name)) {
      throw new Error(`the "${kit.name}" kit is not active; call kits.use("${kit.name}") first`);
    }
    const call = () => kit.actions[action]!.invoke(this.#contextFor(kit, scope, bot, trial), args, `${kit.name}.${action}`);
    return trial ? call() : this.#counted(kit.name, action, scope.signal, call);
  }

  /**
   * Runs one call and counts its end, whether it returns, throws, or resolves later. A call that
   * fails after the program was aborted (stop, timeout, preemption) is not a failure of the action.
   */
  #counted(kit: string, action: string, signal: AbortSignal, call: () => unknown): unknown {
    const stats = this.#stats;
    if (!stats) return call();
    const failed = (err: unknown): never => {
      if (!signal.aborted) stats.record(kit, action, { message: err instanceof Error ? err.message : String(err) });
      throw err;
    };
    let result: unknown;
    try {
      result = call();
    } catch (err) {
      return failed(err);
    }
    if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") {
      return (result as PromiseLike<unknown>).then((value) => {
        stats.record(kit, action);
        return value;
      }, failed);
    }
    stats.record(kit, action);
    return result;
  }

  #listed(name: string): boolean {
    const kit = this.#kits.get(name);
    return kit !== undefined && (!this.#locked || this.#active.includes(name));
  }

  #listedNames(): string[] {
    return [...this.#kits.keys()].filter((name) => this.#listed(name));
  }
}
