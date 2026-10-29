// Assembling the context a routine run sees, from the body's features. Only what the capability
// table allows is present; a routine on a body without a feature finds no such member.
import type { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { withObserver, type RoutineCallObserver } from "../routine/define.ts";
import type { RoutineContext } from "../routine/public.ts";
import { capabilities, type BodyFeatures, type LessonInput, type StatusResponse } from "../protocol/index.ts";
import { UNSCOPED_BOT, type ProgramScope, type WatchOptions } from "../program/scope.ts";
import type { WikiAccess } from "../wiki/access.ts";
import type { Connection } from "./connection.ts";
import type { Notes } from "../notes.ts";

export interface GlobalsDeps {
  connection: Connection;
  wiki: WikiAccess;
  notes: Notes;
  /** The persistent store of a routine namespace, for `ctx.store`. */
  store: (namespace: string) => ReturnType<RoutineContext["store"]>;
  /** Told of every routine call a routine run makes, nested ones included (see `routineContext`). */
  observe: RoutineCallObserver;
  features: () => BodyFeatures;
  status: () => Promise<StatusResponse>;
}

/** The notes, `status`, and `wiki` when the body's wiki is on: the members of the context that depend on the body's features. */
function facilities(deps: GlobalsDeps) {
  const caps = capabilities(deps.features());
  return {
    notes: {
      list: () => deps.notes.list(),
      get: (key: string) => deps.notes.get(key)?.text,
      set: (key: string, text: string) => deps.notes.set(key, text),
      delete: (key: string) => deps.notes.delete(key),
    },
    status: deps.status,
    ...(caps.wiki && {
      wiki: {
        search: (query: string, limit?: number) => deps.wiki.search(query, limit),
        read: (id: string) => deps.wiki.readFormatted(id).text,
        list: (section?: string) => deps.wiki.list(section),
        ...(caps.lessons && { addLesson: (lesson: LessonInput) => deps.wiki.addLesson(lesson) }),
      },
    }),
  };
}

/** The listener methods of a bot, and how each registers a listener with the run (see `ProgramScope.watch`). */
const BOT_LISTENERS: Record<string, WatchOptions> = {
  on: {},
  addListener: {},
  once: { once: true },
  prependListener: { prepend: true },
  prependOnceListener: { once: true, prepend: true },
};

/**
 * The live bot as a run sees it. A listener added with `on`, `once`, `addListener`, `prependListener`, or
 * `prependOnceListener` is the run's: removed at every end, and its throw ends the run, not the packet dispatch.
 * `off` and `removeListener` remove a run listener through its record, and any other listener as the bot would;
 * `removeAllListeners` is the bot's. Every other member is the bot's, bound so Mineflayer never sees the proxy.
 */
function scopedBot(bot: Bot, watch: NonNullable<ProgramScope["watch"]>): Bot {
  /** The bot as the emitter it is: its listener methods take event names the Mineflayer typings do not list. */
  const emitter = bot as unknown as EventEmitter;
  /** What the program registered on this bot, so its own `off(event, handler)` removes the run's wrapper. */
  const registered: { event: string; handler: (...args: unknown[]) => void; remove: () => void }[] = [];
  const register = (event: string, handler: (...args: unknown[]) => void, options: WatchOptions): Bot => {
    registered.push({ event, handler, remove: watch(bot, event, handler, options) });
    return scoped;
  };
  const scoped: Bot = new Proxy(bot, {
    get(target, member) {
      if (member === UNSCOPED_BOT) return target;
      if (typeof member === "string" && Object.hasOwn(BOT_LISTENERS, member)) {
        const options = BOT_LISTENERS[member]!;
        return (event: string, handler: (...args: unknown[]) => void) => register(event, handler, options);
      }
      if (member === "off" || member === "removeListener") {
        return (event: string, handler: (...args: unknown[]) => void) => {
          const at = registered.findLastIndex((entry) => entry.event === event && entry.handler === handler);
          if (at >= 0) registered.splice(at, 1)[0]!.remove();
          // Not this view's wrapper: the listener is the bot's own, from a Mineflayer helper or from `unscopedBot`.
          else emitter.off(event, handler);
          return scoped;
        };
      }
      if (member === "removeAllListeners") {
        return (event?: string) => {
          for (let at = registered.length - 1; at >= 0; at--) {
            if (event === undefined || registered[at]!.event === event) registered.splice(at, 1);
          }
          emitter.removeAllListeners(event);
          return scoped;
        };
      }
      const value = Reflect.get(target, member, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set: (target, member, value) => Reflect.set(target, member, value, target),
  });
  return scoped;
}

/**
 * What a run's default export receives: the run's scope, the live bot, the facilities the body
 * offers, and `store`. A routine call, a module run, and a reflex firing all get it.
 */
export function routineContext(scope: ProgramScope, deps: GlobalsDeps): RoutineContext {
  const bot = deps.connection.requireBot();
  const ctx: RoutineContext = { ...scope, bot: scope.watch ? scopedBot(bot, scope.watch) : bot, ...facilities(deps), store: deps.store };
  return withObserver(ctx, deps.observe);
}
