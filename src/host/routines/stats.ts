// Per-routine call statistics: how often each built-in routine succeeded or failed on this body, and
// why it failed last. The host owns one instance, which the built-in call observer records into, so
// every counter has one writer. Counts persist in the state directory (kit-stats.json, named for the
// kits the routines replace: {"actions": {<module>: {<routine>: {ok, failed, lastError?}}}}).
import type { ActionStats } from "../../protocol/index.ts";
import type { JsonStore } from "../../store.ts";

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

  /** Counts one finished call; `error` is set when the routine failed. */
  record(module: string, routine: string, error?: { message: string }): void {
    const routines = (this.#data[module] ??= {});
    const stats = (routines[routine] ??= { ok: 0, failed: 0 });
    if (error) {
      stats.failed++;
      stats.lastError = error.message.length > MAX_ERROR_LENGTH ? `${error.message.slice(0, MAX_ERROR_LENGTH - 3)}...` : error.message;
    } else {
      stats.ok++;
    }
    this.#timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS).unref();
  }

  /** The counts of one module's routines; a routine that never ran is absent. */
  forKit(module: string): Record<string, ActionStats> {
    return Object.fromEntries(Object.entries(this.#data[module] ?? {}).map(([routine, stats]) => [routine, { ...stats }]));
  }

  /** Writes the counts now. The body calls this when it closes. */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#store.set(KEY, this.#data);
  }
}
