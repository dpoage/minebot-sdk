import type { Bot } from "mineflayer";
import type { KitRegistry } from "../kit/registry.ts";
import type { LessonInput, Note, PageSummary, SearchHit, StatusResponse } from "../protocol/index.ts";

/**
 * What a routine's default export receives: the live bot, this run's log, sleep, signal and event
 * subscription, and the body's facilities. `kit` is present when the body offers kits and `wiki`
 * when its wiki is on; no other member exists.
 */
export interface RoutineContext {
  readonly bot: Bot;
  /** Appends to the run's log. */
  log(...args: unknown[]): void;
  /** Resolves after `ms`; rejects when the run is aborted. */
  sleep(ms: number): Promise<void>;
  /** Fires on timeout or stop; check `signal.aborted` in long loops. */
  readonly signal: AbortSignal;
  /** Subscribes to a bot event until the run ends or is aborted. The handler's arguments are `unknown`: narrow them, or subscribe with the typed `ctx.bot.on`. */
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** The body's notepad; it survives body restarts. */
  readonly notes: {
    list(): Note[];
    get(key: string): string | undefined;
    set(key: string, text: string): Note;
    delete(key: string): boolean;
  };
  /** Deaths, reconnects, and milestone progress. */
  status(): Promise<StatusResponse>;
  /** The active kits' actions, namespaced by kit: `await ctx.kit.move.to({ position })`. */
  readonly kit?: Readonly<KitRegistry>;
  readonly wiki?: {
    search(query: string, limit?: number): SearchHit[];
    read(id: string): string;
    list(section?: string): PageSummary[];
    /** Present when the body may write lessons. */
    addLesson?(lesson: LessonInput): Promise<PageSummary>;
  };
}
