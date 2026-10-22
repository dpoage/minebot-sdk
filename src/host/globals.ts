// Assembling the globals a program sees, from the body's features. Only what the capability
// table allows is present; a program on a body without a feature finds no such global.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { KitHost } from "../kit/kit.ts";
import { capabilities, type BodyFeatures, type LessonInput, type StatusResponse } from "../protocol/index.ts";
import type { ProgramScope } from "../program/scope.ts";
import type { WikiAccess } from "../wiki/access.ts";
import type { Connection } from "./connection.ts";
import type { Notes } from "../notes.ts";
import type { Triggers } from "./triggers.ts";

const { goals, Movements } = pathfinderPkg;

export interface GlobalsDeps {
  connection: Connection;
  kits: KitHost;
  wiki: WikiAccess;
  notes: Notes;
  features: () => BodyFeatures;
  status: () => Promise<StatusResponse>;
  /** Present only when the body offers triggers. */
  triggers?: Triggers;
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

/** The globals of one program run: the base environment plus exactly the features the body offers. */
export function programGlobals(scope: ProgramScope, deps: GlobalsDeps): Record<string, unknown> {
  const bot = deps.connection.requireBot();
  const caps = capabilities(deps.features());
  const notes = {
    list: () => deps.notes.list(),
    get: (key: string) => deps.notes.get(key)?.text,
    set: (key: string, text: string) => deps.notes.set(key, text),
    delete: (key: string) => deps.notes.delete(key),
  };
  const globals: Record<string, unknown> = { bot, goals, Movements, Vec3, notes, status: deps.status };
  if (caps.kits) {
    globals.kit = deps.kits.api(scope, bot);
    const authoring = caps.agentKits ? deps.kitAuthoring : undefined;
    globals.kits = deps.kits.controller({
      switching: caps.kitSwitching,
      ...(authoring && { ...authoring, try: (source: string, run: { action: string; args?: unknown }) => authoring.try(source, run, scope, bot) }),
    });
  }
  if (caps.triggers && deps.triggers) {
    const { triggers } = deps;
    globals.triggers = {
      add: (trigger: unknown) => triggers.add(trigger),
      remove: (name: string) => triggers.remove(name),
      list: () => triggers.list(),
      enable: (name: string) => triggers.setEnabled(name, true),
      disable: (name: string) => triggers.setEnabled(name, false),
    };
  }
  if (caps.wiki) {
    globals.wiki = {
      search: (query: string, limit?: number) => deps.wiki.search(query, limit),
      read: (id: string) => deps.wiki.readFormatted(id).text,
      list: (section?: string) => deps.wiki.list(section),
      ...(caps.lessons && { addLesson: (lesson: LessonInput) => deps.wiki.addLesson(lesson) }),
    };
  }
  return globals;
}
