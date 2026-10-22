// Assembling the globals a program sees, from the body's features. Only what the capability
// table allows is present; a program on a body without a feature finds no such global.
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { withObserver, type RoutineCallObserver } from "../routine/define.ts";
import type { RoutineContext } from "../routine/public.ts";
import { capabilities, type BodyFeatures, type LessonInput, type StatusResponse } from "../protocol/index.ts";
import type { ProgramScope } from "../program/scope.ts";
import type { WikiAccess } from "../wiki/access.ts";
import type { Connection } from "./connection.ts";
import type { Notes } from "../notes.ts";

const { goals, Movements } = pathfinderPkg;

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

/**
 * What programs and routines both get, from one place: the notes, `status`, and `wiki` when the
 * body's wiki is on. A fact about these members changes here only.
 */
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

/** The globals of one program run: the base environment plus exactly the features the body offers. */
export function programGlobals(deps: GlobalsDeps): Record<string, unknown> {
  const bot = deps.connection.requireBot();
  return { bot, goals, Movements, Vec3, ...facilities(deps) };
}

/**
 * What a routine's default export receives for one call: the run's scope, the live bot, and the
 * facilities the body offers programs, plus `store`, which programs have no global for.
 */
export function routineContext(scope: ProgramScope, deps: GlobalsDeps): RoutineContext {
  const bot = deps.connection.requireBot();
  const ctx: RoutineContext = { ...scope, bot, ...facilities(deps), store: deps.store };
  return withObserver(ctx, deps.observe);
}
