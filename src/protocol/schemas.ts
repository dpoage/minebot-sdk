// Zod schemas for every request and query of the body API, plus the endpoint file.
// The daemon validates with them, the MCP server builds its input schemas from them, and the
// client parses the endpoint file with them, so the three can never drift apart.
import { z } from "zod";
import { MilestoneSet } from "../milestones/milestones.ts";
import { isReflexEvent } from "./event-filter.ts";
import type { Endpoint } from "./types.ts";

export const MAX_NOTES = 200;
export const MAX_NOTE_LENGTH = 8000;

export const NoteKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,63}$/, "use 1-64 lowercase letters, digits, and . _ / -; start with a letter or digit");
export const NoteText = z.string().min(1).max(MAX_NOTE_LENGTH);

/** Features of a body that wiki content can depend on; the cut-block markers share these names. */
export const WikiFeature = z.enum(["kits", "milestones", "agentKits", "reflexes", "routines"]);
export type WikiFeature = z.infer<typeof WikiFeature>;

/** Wiki page frontmatter. Pages that require a feature are hidden from bodies without it. */
export const PageMeta = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Minecraft version the page was last verified on. Absent: never verified in game. */
  mc_version: z.string().optional(),
  /** How the page was verified: a check program, a test, or a recorded observation. */
  verified_by: z.string().min(1),
  /** Program in the wiki's checks/ directory that succeeds while the page is true. */
  check: z.string().optional(),
  /** Features a body needs for the page to make sense; bodies without one do not see the page. */
  requires: z.array(WikiFeature).default([]),
  /** Lessons only: the body that wrote it, and when. */
  author: z.string().optional(),
  created: z.string().optional(),
});
export type PageMeta = z.output<typeof PageMeta>;

/** A kit name: the same shape a saved kit's `defineKit({ name })` must use. */
export const KitName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "use 1-32 lowercase letters, digits, and _; start with a letter");

/** A routine name: the file name of a library module, `<name>.ts`, so it is also what other modules import. */
export const RoutineName = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, "use 1-48 lowercase letters, digits, _ and -; start with a letter");

/**
 * An action binding's name, which `POST /call` takes. It follows the routine name rule, so a dotted
 * name such as `move.to` is never a binding: that shape is for the built-in routines' call names.
 */
export const BindingName = RoutineName;

/**
 * The call name of a built-in routine: `<module>.<routine>`, e.g. `move.to` or `gatherer.collectDrops`. Only the
 * shape is checked here; whether the body offers that routine is the body's to say (a 404 naming it).
 */
export const BuiltinCallName = z.string().max(100).regex(/^[^\s.]+(\.[^\s.]+)+$/, "use <module>.<routine>");

/** Query of `GET /builtins/docs`: module names, comma-separated; none means every offered module. */
export const BuiltinDocsQuery = z.object({ names: z.string().optional() });

/** Query of `GET /builtins/search`. */
export const BuiltinSearchQuery = z.object({ q: z.string().min(1), limit: z.coerce.number().int().positive().max(20).default(5) });

/** Query of `GET /builtins/source`. */
export const BuiltinSourceQuery = z.object({ name: RoutineName });

/** The largest routine source the library keeps, in UTF-8 bytes. */
export const ROUTINE_SOURCE_LIMIT = 128 * 1024;

const utf8 = new TextEncoder();

/** A routine's TypeScript source, within the library's limit. The library refuses a save with this schema's message. */
export const RoutineSource = z.string().refine((source) => utf8.encode(source).length <= ROUTINE_SOURCE_LIMIT, `routine source is limited to ${ROUTINE_SOURCE_LIMIT / 1024} KiB`);

export const EndpointSchema: z.ZodType<Endpoint> = z.object({
  name: z.string(),
  url: z.string(),
  token: z.string(),
  pid: z.number(),
  mcVersion: z.string(),
  server: z.object({ host: z.string(), port: z.number() }),
});

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

/** Body of `POST /run`. */
export const RunInput = z.object({
  code: z.string(),
  timeoutMs: z.number().int().nonnegative().max(MAX_TIMEOUT_MS).optional(),
});

export const ChatInput = z.object({ message: z.string().min(1).max(256) });

function isPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** Body of `POST /wait`; the `wait_for` MCP tool takes the same fields (`timeoutMs` is `timeout_ms` there). */
export const WaitInput = z.object({
  types: z.array(z.string().min(1)).min(1).optional(),
  from: z.string().min(1).max(64).optional(),
  match: z.string().min(1).max(1024).refine(isPattern, "must be a regular expression").optional(),
  since: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

export const EventsQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export const ObserveQuery = z.object({ brief: z.enum(["0", "1", "true", "false"]).optional() });

export const NoteInput = z.object({ text: NoteText });

/** Body of `PUT /milestones`. */
export const MilestonesInput = z.object({ milestones: MilestoneSet.nullable() });

/** Body of `POST /kits`: replace the active kits. */
export const UseKitsInput = z.object({ use: z.array(KitName).min(1) });

export const KitDocsQuery = z.object({ names: z.string().optional() });

export const KitSourceQuery = z.object({ name: KitName });

/** Body of `POST /kits/save`: a kit's TypeScript source. */
export const SaveKitInput = z.object({
  source: z
    .string()
    .min(1)
    .max(128 * 1024, "kit source is limited to 128 KiB"),
});

/** Body of `POST /kits/remove`. */
export const RemoveKitInput = z.object({ name: KitName });

/** Body of `POST /kits/try`: run one action of unsaved kit source once. */
export const TryKitInput = z.object({
  source: SaveKitInput.shape.source,
  action: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: RunInput.shape.timeoutMs,
});

/** Query of `GET /kits/search`. */
export const KitSearchQuery = z.object({ q: z.string().min(1), limit: z.coerce.number().int().positive().max(20).default(5) });

/** Query of `GET /kits/versions`. */
export const KitVersionsQuery = z.object({ name: KitName });

/** Body of `POST /kits/revert`: save an earlier version of a kit again, as a new version. */
export const RevertKitInput = z.object({ name: KitName, version: z.number().int().positive() });

export const WikiSearchQuery = z.object({ q: z.string().min(1), limit: z.coerce.number().int().positive().max(20).default(5) });

export const WikiPageQuery = z.object({ id: z.string().min(1) });

export const WikiListQuery = z.object({ section: z.string().optional() });

/** Body of `POST /wiki/lessons`; the `wiki_add_lesson` MCP tool takes the same fields. */
export const LessonInput = z.object({
  title: z.string().min(3).max(120),
  tags: z.array(z.string().min(1).max(40)).max(8).default([]),
  body: z.string().min(10).max(8000),
});
export type LessonInput = z.input<typeof LessonInput>;

export const MAX_TRIGGERS = 50;
export const DEFAULT_TRIGGER_COOLDOWN_MS = 1000;
export const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000;
/** A reflex that fails this many times in a row disables itself. */
export const MAX_TRIGGER_FAILURES = 3;

/**
 * A name the reflex store may hold. It is wider than a binding's: an entry saved before reflexes
 * can have a dot, and `POST /unbind` must be able to name it to delete it.
 */
export const StoredName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, "use 1-48 lowercase letters, digits, and . _ -; start with a letter or digit");

/** Body of `POST /routines/save`. */
export const SaveRoutineInput = z.object({ name: RoutineName, source: RoutineSource });

/** Query of `GET /routines/source`. */
export const RoutineSourceQuery = z.object({ name: RoutineName });

/** Query of `GET /routines/versions`. */
export const RoutineVersionsQuery = z.object({ name: RoutineName });

/** Body of `POST /routines/revert`: save an earlier version of a routine again, as a new version. */
export const RevertRoutineInput = z.object({ name: RoutineName, version: z.number().int().positive() });

/**
 * A reflex: a saved routine that fires when events arrive. The routine's default export is called
 * with `(ctx, { event })`; `bot.on` handlers it adds are its own.
 */
export const ReflexInput = z.object({
  name: BindingName,
  routine: RoutineName,
  /** Event types that fire the reflex; any of them matches. A reflex cannot listen to `reflex_*` events. */
  on: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(16)
    .refine((types) => !types.some(isReflexEvent), "a reflex cannot listen to reflex events"),
  from: WaitInput.shape.from,
  match: WaitInput.shape.match,
  /** A JavaScript expression over `event` and `bot`; the reflex fires only when it is truthy. */
  when: z.string().min(1).max(2000).optional(),
  /** Minimum time between two firings of this reflex. */
  cooldownMs: z.number().int().nonnegative().max(60 * 60_000).default(DEFAULT_TRIGGER_COOLDOWN_MS),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TRIGGER_TIMEOUT_MS),
  enabled: z.boolean().default(true),
  /** Abort the running run when the reflex fires; the firing runs once that run has ended. */
  preempt: z.boolean().default(false),
  /** Order of waiting reflexes, highest first; a preempting reflex never aborts a running reflex of equal or higher priority. */
  priority: z.number().int().min(-100).max(100).default(0),
});
export type ReflexInput = z.infer<typeof ReflexInput>;

/**
 * Body of `POST /bind`: an action, a saved routine called by name with `POST /call`, or a reflex,
 * a saved routine the body calls when events arrive.
 */
export const BindInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), name: BindingName, routine: RoutineName }),
  ReflexInput.extend({ kind: z.literal("reflex") }),
]);
export type BindInput = z.infer<typeof BindInput>;

/** Body of `POST /unbind`: any name the store holds (see `StoredName`). */
export const UnbindInput = z.object({ name: StoredName });

/**
 * Body of `POST /call`: calls the action bound to `name`, or the built-in routine `<module>.<routine>`
 * (a name with a dot is never a binding). `args` default to `{}`; `timeoutMs` as for `POST /run`.
 */
export const CallInput = z.object({
  name: z.union([BindingName, BuiltinCallName], { error: "use an action's name (1-48 lowercase letters, digits, _ and -; start with a letter) or a built-in routine's <module>.<routine>" }),
  args: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: RunInput.shape.timeoutMs,
});
