// The body's state directory: the one owner of where persistent state lives. Notes, milestones,
// triggers, action bindings, per-kit stores, agent kits, and routines survive body restarts here, and every file is written atomically.
import path from "node:path";
import { JsonStore } from "../store.ts";
import { Notes } from "../notes.ts";
import { BODY_STORES, checkStoreNamespace } from "../routine/define.ts";

export class BodyState {
  readonly dir: string;
  readonly #stores = new Map<string, JsonStore>();
  #triggers: JsonStore | undefined;
  #kitStats: JsonStore | undefined;
  #bindings: JsonStore | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The agent's persistent notes. */
  get notes(): Notes {
    return new Notes(this.store(BODY_STORES.notes));
  }

  /** The agent's triggers, one entry per trigger name. Apart from the kit stores, which are named by kit. */
  get triggers(): JsonStore {
    this.#triggers ??= new JsonStore(path.join(this.dir, "triggers.json"));
    return this.#triggers;
  }

  /** How often each kit action succeeded and failed on this body. Apart from the kit stores, which are named by kit. */
  get kitStats(): JsonStore {
    this.#kitStats ??= new JsonStore(path.join(this.dir, "kit-stats.json"));
    return this.#kitStats;
  }

  /** The agent's action bindings, one entry per bound name. Apart from the kit stores, which are named by kit. */
  get bindings(): JsonStore {
    this.#bindings ??= new JsonStore(path.join(this.dir, "bindings.json"));
    return this.#bindings;
  }

  /** Where the routine library lives; bodies that share the directory share their routines. */
  get routinesDir(): string {
    return path.join(this.dir, "routines");
  }

  /** Where agents' kits live; bodies that share the directory share their kits. */
  get agentKitsDir(): string {
    return path.join(this.dir, "agent-kits");
  }

  /** The persistent JSON store of one kit. Kits never see each other's stores. */
  store(kit: string): JsonStore {
    let store = this.#stores.get(kit);
    if (!store) {
      store = new JsonStore(path.join(this.dir, "stores", `${kit}.json`));
      this.#stores.set(kit, store);
    }
    return store;
  }

  /** The store a routine opens as `ctx.store(namespace)`: a routine name other than the body's own (`BODY_STORES`), else it throws naming the rule. */
  routineStore(namespace: string): JsonStore {
    checkStoreNamespace(namespace);
    return this.store(namespace);
  }

  /** The body's milestones, or null when none are set. */
  get milestones(): unknown {
    return this.store(BODY_STORES.body).get("milestones");
  }

  /** Replaces the milestones; null removes them. */
  setMilestones(value: unknown): void {
    this.store(BODY_STORES.body).set("milestones", value ?? undefined);
  }
}
