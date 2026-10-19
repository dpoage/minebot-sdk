// Per-action call statistics: how often each kit action succeeded or failed on this body, and
// why it failed last. The kit framework records every call, nested ones included, so an agent
// choosing between actions sees which ones work. Counts persist in the state directory.
import type { ActionStats } from "../protocol/index.ts";
import type { JsonStore } from "../store.ts";

const KEY = "actions";
const MAX_ERROR_LENGTH = 300;
/** Calls in a tight loop would otherwise rewrite the file each time. */
const FLUSH_DELAY_MS = 500;

export class KitStats {
  readonly #store: JsonStore;
  #data: Record<string, Record<string, ActionStats>>;
  #timer: NodeJS.Timeout | undefined;

  constructor(store: JsonStore) {
    this.#store = store;
    const saved = store.get(KEY);
    this.#data = typeof saved === "object" && saved !== null && !Array.isArray(saved) ? (saved as Record<string, Record<string, ActionStats>>) : {};
  }

  /** Counts one finished call; `error` is set when the action failed. */
  record(kit: string, action: string, error?: { message: string }): void {
    const actions = (this.#data[kit] ??= {});
    const stats = (actions[action] ??= { ok: 0, failed: 0 });
    if (error) {
      stats.failed++;
      stats.lastError = error.message.length > MAX_ERROR_LENGTH ? `${error.message.slice(0, MAX_ERROR_LENGTH - 3)}...` : error.message;
    } else {
      stats.ok++;
    }
    this.#timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS).unref();
  }

  /** The counts of one kit's actions; an action that never ran is absent. */
  forKit(kit: string): Record<string, ActionStats> {
    return Object.fromEntries(Object.entries(this.#data[kit] ?? {}).map(([action, stats]) => [action, { ...stats }]));
  }

  /** Forgets a kit's counts: a new version of an agent kit starts clean. */
  reset(kit: string): void {
    if (!(kit in this.#data)) return;
    delete this.#data[kit];
    this.flush();
  }

  /** Writes the counts now. The body calls this when it closes. */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#store.set(KEY, this.#data);
  }
}
