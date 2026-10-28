// Assembling the context a routine run sees, from the body's features. Only what the capability
// table allows is present; a routine on a body without a feature finds no such member.
import type { Bot } from "mineflayer";
import { withObserver, type RoutineCallObserver } from "../routine/define.ts";
import type { RoutineContext } from "../routine/public.ts";
import { capabilities, type BodyFeatures, type LessonInput, type StatusResponse } from "../protocol/index.ts";
import type { ProgramScope, WatchOptions } from "../program/scope.ts";
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
 * The live bot as a run sees it: a listener it adds with `on`, `once`, `addListener`, `prependListener`, or
 * `prependOnceListener` is the run's, removed at every end of the run, and a throw from it ends the run instead of
 * the packet dispatch that called it. The program's own `off` and `removeListener` remove what it added: the run
 * registered a wrapper, which the record of the handler names. Every other member is the bot's, bound to it so the
 * proxy is never the `this` a Mineflayer method sees.
 */
function scopedBot(bot: Bot, watch: NonNullable<ProgramScope["watch"]>): Bot {
  /** What the program registered on this bot, so its own `off(event, handler)` removes the run's wrapper. */
  const registered: { event: string; handler: (...args: unknown[]) => void; remove: () => void }[] = [];
  const register = (event: string, handler: (...args: unknown[]) => void, options: WatchOptions): Bot => {
    registered.push({ event, handler, remove: watch(bot, event, handler, options) });
    return scoped;
  };
  const scoped: Bot = new Proxy(bot, {
    get(target, member) {
      if (typeof member === "string" && Object.hasOwn(BOT_LISTENERS, member)) {
        const options = BOT_LISTENERS[member]!;
        return (event: string, handler: (...args: unknown[]) => void) => register(event, handler, options);
      }
      if (member === "off" || member === "removeListener") {
        return (event: string, handler: (...args: unknown[]) => void) => {
          const at = registered.findLastIndex((entry) => entry.event === event && entry.handler === handler);
          if (at >= 0) registered.splice(at, 1)[0]!.remove();
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
