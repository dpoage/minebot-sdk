// The body's state directory: the one owner of where persistent state lives. Notes, milestones,
// reflexes, action bindings, routine stores, and routines survive body restarts here, and every file is written atomically.
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

  /** The agent's reflexes, one entry per name (and the entries saved before reflexes, which stay until unbound). Apart from the stores, which are named by namespace. */
  get triggers(): JsonStore {
    this.#triggers ??= new JsonStore(path.join(this.dir, "triggers.json"));
    return this.#triggers;
  }

  /** How often each built-in routine succeeded and failed on this body. Apart from the stores, which are named by namespace. */
  get kitStats(): JsonStore {
    this.#kitStats ??= new JsonStore(path.join(this.dir, "kit-stats.json"));
    return this.#kitStats;
  }

  /** The agent's action bindings, one entry per bound name. Apart from the stores, which are named by namespace. */
  get bindings(): JsonStore {
    this.#bindings ??= new JsonStore(path.join(this.dir, "bindings.json"));
    return this.#bindings;
  }

  /** Where the routine library lives; bodies that share the directory share their routines. */
  get routinesDir(): string {
    return path.join(this.dir, "routines");
  }

  /** The persistent JSON store of one namespace: `stores/<namespace>.json`. The body's own stores (`BODY_STORES`) and the routines' share the directory, and only the routines' go through `routineStore`. */
  store(namespace: string): JsonStore {
    let store = this.#stores.get(namespace);
    if (!store) {
      store = new JsonStore(path.join(this.dir, "stores", `${namespace}.json`));
      this.#stores.set(namespace, store);
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
