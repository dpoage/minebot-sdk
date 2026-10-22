// The body's state directory: the one owner of where persistent state lives. Notes, milestones,
// triggers, per-kit stores, and agent kits survive body restarts here, and every file is written atomically.
import path from "node:path";
import { JsonStore } from "../store.ts";
import { Notes } from "../notes.ts";

export class BodyState {
  readonly dir: string;
  readonly #stores = new Map<string, JsonStore>();
  #triggers: JsonStore | undefined;
  #kitStats: JsonStore | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The agent's persistent notes. */
  get notes(): Notes {
    return new Notes(this.store("notes"));
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

  /** The body's milestones, or null when none are set. */
  get milestones(): unknown {
    return this.store("body").get("milestones");
  }

  /** Replaces the milestones; null removes them. */
  setMilestones(value: unknown): void {
    this.store("body").set("milestones", value ?? undefined);
  }
}
