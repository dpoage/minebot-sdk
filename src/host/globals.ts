// Assembling the globals a program sees, from the body's features. Only what the capability
// table allows is present; a program on a body without a feature finds no such global.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { KitHost } from "../kit/kit.ts";
import type { KitRegistry } from "../kit/registry.ts";
import type { RoutineContext } from "../routine/public.ts";
import { capabilities, type BodyFeatures, type LessonInput, type StatusResponse } from "../protocol/index.ts";
import type { ProgramScope } from "../program/scope.ts";
import type { WikiAccess } from "../wiki/access.ts";
import type { Connection } from "./connection.ts";
import type { Notes } from "../notes.ts";

const { goals, Movements } = pathfinderPkg;

export interface GlobalsDeps {
  connection: Connection;
  kits: KitHost;
  wiki: WikiAccess;
  notes: Notes;
  /** The persistent store of a routine namespace, for `ctx.store`. */
  store: (namespace: string) => ReturnType<RoutineContext["store"]>;
  features: () => BodyFeatures;
  status: () => Promise<StatusResponse>;
  /** Authoring hooks, present only when the body offers agent kits. `try` runs inside the calling program, so it takes that program's scope and bot. */
  kitAuthoring?: {
    save: (source: string) => Promise<unknown>;
    remove: (name: string) => Promise<void>;
    source: (name: string) => string;
    versions: (name: string) => Promise<unknown>;
    revert: (name: string, version: number) => Promise<unknown>;
    try: (source: string, run: { action: string; args?: unknown }, scope: ProgramScope, bot: Bot) => Promise<unknown>;
  };
}

/**
 * What programs and routines both get, from one place: the notes, `status`, `kit` when the body offers
 * kits, and `wiki` when its wiki is on. A fact about these members changes here only.
 */
function facilities(scope: ProgramScope, deps: GlobalsDeps, bot: Bot) {
  const caps = capabilities(deps.features());
  return {
    notes: {
      list: () => deps.notes.list(),
      get: (key: string) => deps.notes.get(key)?.text,
      set: (key: string, text: string) => deps.notes.set(key, text),
      delete: (key: string) => deps.notes.delete(key),
    },
    status: deps.status,
    ...(caps.kits && { kit: deps.kits.api(scope, bot) }),
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
export function programGlobals(scope: ProgramScope, deps: GlobalsDeps): Record<string, unknown> {
  const bot = deps.connection.requireBot();
  const caps = capabilities(deps.features());
  const globals: Record<string, unknown> = { bot, goals, Movements, Vec3, ...facilities(scope, deps, bot) };
  if (caps.kits) {
    const authoring = caps.agentKits ? deps.kitAuthoring : undefined;
    globals.kits = deps.kits.controller({
      switching: caps.kitSwitching,
      ...(authoring && { ...authoring, try: (source: string, run: { action: string; args?: unknown }) => authoring.try(source, run, scope, bot) }),
    });
  }
  return globals;
}

/**
 * What a routine's default export receives for one call: the run's scope, the live bot, and the
 * facilities the body offers programs, plus `store`, which programs have no global for. Nothing else: the kit controller stays a program global.
 */
export function routineContext(scope: ProgramScope, deps: GlobalsDeps): RoutineContext {
  const bot = deps.connection.requireBot();
  const { kit, ...rest } = facilities(scope, deps, bot);
  // The kit calls of the host's registry are the shape `KitRegistry` types for authors.
  return { ...scope, bot, ...rest, store: deps.store, ...(kit && { kit: kit as Readonly<KitRegistry> }) };
}
