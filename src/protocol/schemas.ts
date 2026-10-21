// Zod schemas for every request and query of the body API, plus the endpoint file.
// The daemon validates with them, the MCP server builds its input schemas from them, and the
// client parses the endpoint file with them, so the three can never drift apart.
import { z } from "zod";
import { MilestoneSet } from "../milestones/milestones.ts";
import type { Endpoint } from "./types.ts";

export const MAX_NOTES = 200;
export const MAX_NOTE_LENGTH = 8000;

export const NoteKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,63}$/, "use 1-64 lowercase letters, digits, and . _ / -; start with a letter or digit");
export const NoteText = z.string().min(1).max(MAX_NOTE_LENGTH);

/** Features of a body that wiki content can depend on; the cut-block markers share these names. */
export const WikiFeature = z.enum(["kits", "milestones", "agentKits", "triggers"]);
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
export const MAX_TRIGGER_CODE_LENGTH = 32 * 1024;
export const DEFAULT_TRIGGER_COOLDOWN_MS = 1000;
export const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000;
/** A trigger that fails this many times in a row disables itself. */
export const MAX_TRIGGER_FAILURES = 3;

export const TriggerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, "use 1-48 lowercase letters, digits, and . _ -; start with a letter or digit");

/** Body of `POST /triggers`; the `trigger_add` MCP tool takes the same fields (`cooldownMs` is `cooldown_ms` there). */
export const TriggerInput = z.object({
  name: TriggerName,
  /** Event types that fire the trigger; any of them matches. A trigger cannot listen to `trigger_*` events. */
  on: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(16)
    .refine((types) => !types.some((type) => type.startsWith("trigger_")), "a trigger cannot listen to trigger events"),
  from: WaitInput.shape.from,
  match: WaitInput.shape.match,
  /** A JavaScript expression over `event` and `bot`; the trigger fires only when it is truthy. */
  when: z.string().min(1).max(2000).optional(),
  /** Program source, run with the usual globals plus `event`. */
  run: z.string().min(1).max(MAX_TRIGGER_CODE_LENGTH, "trigger code is limited to 32 KiB"),
  /** Minimum time between two firings of this trigger. */
  cooldownMs: z.number().int().nonnegative().max(60 * 60_000).default(DEFAULT_TRIGGER_COOLDOWN_MS),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TRIGGER_TIMEOUT_MS),
  enabled: z.boolean().default(true),
  /** Abort the running program when the trigger fires; the firing runs once that program has ended. */
  preempt: z.boolean().default(false),
  /** Order of waiting triggers, highest first; a preempting trigger never aborts a running trigger of equal or higher priority. */
  priority: z.number().int().min(-100).max(100).default(0),
});
export type TriggerInput = z.input<typeof TriggerInput>;

/** Body of `POST /triggers/remove`. */
export const RemoveTriggerInput = z.object({ name: TriggerName });

/** Body of `POST /triggers/enabled`. */
export const TriggerEnabledInput = z.object({ name: TriggerName, enabled: z.boolean() });
