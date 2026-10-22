// Response types of the body API. Every wire shape lives here or in schemas.ts; adapters,
// the body, and the wiki all import from this package, never from each other's modules.
import type { MilestoneProgress, MilestoneSet } from "../milestones/milestones.ts";
import type { PageMeta } from "./schemas.ts";

export type { MilestoneProgress, MilestoneSet };

export interface Endpoint {
  name: string;
  url: string;
  token: string;
  pid: number;
  mcVersion: string;
  server: { host: string; port: number };
}

/** `timeout` and `stopped` mean the program was aborted; its side effects up to that point remain. */
export type RunStatus = "ok" | "error" | "timeout" | "stopped";

export interface RunResult {
  status: RunStatus;
  /** JSON value returned by the program, or a util.inspect string when the value is not JSON-safe. */
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
}

export interface BodyEvent {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}

export interface EventsResponse {
  events: BodyEvent[];
  /** Pass as `since` on the next call to receive only newer events. */
  next: number;
}

/** Filters of a blocking wait. Every given filter must match the same event. */
export interface WaitRequest {
  /** Event types to wait for; any of them matches. */
  types?: string[];
  /** The sender of a chat or whisper. */
  from?: string;
  /** Case-insensitive regular expression matched against chat, whisper, and system messages. */
  match?: string;
  /** Only events after this cursor. Default: the current end of the log, so only new events match. */
  since?: number;
  timeoutMs?: number;
}

export interface WaitResponse {
  /** The first matching event after the cursor, or null on timeout. */
  event: BodyEvent | null;
  /** Pass as `since` on the next wait to skip what this one already examined. */
  next: number;
  timedOut: boolean;
}

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export interface ItemSummary {
  name: string;
  count: number;
  slot: number;
}

export interface EntitySummary {
  id: number;
  type: string;
  name: string;
  username?: string;
  distance: number;
  position: Vec;
}

export interface EffectSummary {
  name: string;
  /** 0 for level I, 1 for level II, and so on. */
  amplifier: number;
  /** Seconds left; absent for an effect without an end. */
  remaining?: number;
}

export type Observation =
  | { connected: false; reconnecting: boolean; lastDisconnect?: string }
  | {
      connected: true;
      username: string;
      gameMode: string;
      dimension: string;
      position: Vec;
      yaw: number;
      pitch: number;
      onGround: boolean;
      health: number;
      food: number;
      saturation: number;
      oxygen: number;
      experienceLevel: number;
      timeOfDay: number;
      isDay: boolean;
      isRaining: boolean;
      heldItem: ItemSummary | null;
      /** What the player wears; null for an empty slot. */
      armor: { head: ItemSummary | null; chest: ItemSummary | null; legs: ItemSummary | null; feet: ItemSummary | null };
      offhand: ItemSummary | null;
      /** Active potion effects. */
      effects: EffectSummary[];
      /** The biome at the player's feet, e.g. `forest`. */
      biome: string;
      /** The block the player stands on; null when its chunk is not loaded. */
      standingOn: string | null;
      /** The block in the line of sight within 5 blocks; null when there is none. */
      lookingAt: { name: string; position: Vec; distance: number } | null;
      /** Light at the player's feet, 0 to 15, as the server sent it. `sky` is absent when the chunk has no sky light data, which shows as 0 under open sky; raw sky light does not follow the time of day. */
      light?: { block: number; sky?: number };
      inventory: ItemSummary[];
      nearbyEntities: EntitySummary[];
      program: { running: boolean; elapsedMs?: number };
      /** Looking straight up from the player; water counts as cover, leaves do not. */
      sky: { open: boolean; cover?: string; solidAbove: number; waterAbove: number };
      /** Programs in a row that ended with the same position and inventory. */
      programsWithoutChange: number;
      /** Active kits. Present only when the body offers kits. */
      kits?: string[];
    };

export interface StatusResponse {
  connected: boolean;
  /** ISO time the body process started. */
  startedAt: string;
  /** Deaths since the body process started. */
  deaths: number;
  reconnects: number;
  /** Progress toward the body's milestones, graded from the server's statistics; null without a set or a connection. Absent when the body has no milestones. */
  milestones?: MilestoneProgress | null;
  /** Why `milestones` is null, when a set exists but grading failed. */
  milestonesError?: string;
}

export interface Note {
  key: string;
  text: string;
  /** ISO time of the last change. */
  updated: string;
}

export type WikiMode = "off" | "read" | "write";

/**
 * - verified: checked on the pinned Minecraft version.
 * - stale: checked on another version; recheck before trusting.
 * - unverified: general knowledge, never checked in game.
 * - lesson: written by an agent; nobody has reviewed it.
 */
export type PageStatus = "verified" | "stale" | "unverified" | "lesson";

export interface WikiPage {
  /** Path without extension, e.g. `quirks/drops-fall-out-of-reach` or `lessons/end-crystals`. */
  id: string;
  meta: PageMeta;
  status: PageStatus;
  body: string;
}

export interface PageSummary {
  id: string;
  title: string;
  tags: string[];
  status: PageStatus;
}

export interface SearchHit extends PageSummary {
  score: number;
  snippet: string;
}

/** How often one kit action ran on this body, counted by the kit framework. */
export interface ActionStats {
  ok: number;
  failed: number;
  /** The message of the latest failure; absent while the action has not failed. */
  lastError?: string;
}

export interface KitInfo {
  name: string;
  description: string;
  /** Kits whose actions this kit calls; activated together with this kit. */
  uses: string[];
  active: boolean;
  /** True for kits agents saved on this body. */
  agent: boolean;
  /** Action names, e.g. `to`. Programs call `kit.<kit>.<action>({ ... })`. */
  actions: string[];
  /** Calls so far, by action name; actions that never ran are absent. Counted per body, and kept across restarts. */
  stats: Record<string, ActionStats>;
}

export interface KitsResponse {
  kits: KitInfo[];
  active: string[];
  locked: boolean;
}

/** One action's shape for typing: JSON Schema (draft 2020-12) of what a call takes and, when the action declares it, what it returns. */
export interface ActionSchema {
  doc: string;
  /** The argument as callers write it (zod input). */
  args: Record<string, unknown>;
  /** The result as callers read it (zod output); absent when the action declares no `returns`. */
  returns?: Record<string, unknown>;
}

/** One kit's actions with their schemas: what `minebot types` generates declarations from. */
export interface KitSchema {
  name: string;
  description: string;
  uses: string[];
  active: boolean;
  /** True for kits agents saved on this body; the rest ship with the package and are typed there. */
  agent: boolean;
  actions: Record<string, ActionSchema>;
}

export interface KitSchemasResponse {
  kits: KitSchema[];
}

/**
 * The type check of kit source against `minebot-sdk/kit` and the body's other kits. It never
 * blocks a save or a try: `failed` lists the errors (`<kit>.ts(line,col): error TSxxxx: ...`) and
 * the kit is saved anyway; `skipped` says why no check ran (TypeScript is an optional peer dependency).
 */
export type KitTypeCheck = { status: "passed" } | { status: "failed"; errors: string[] } | { status: "skipped"; reason: string };

/** What saving a kit returns: the kit as the body now offers it, and the type check of its source. */
export type SaveKitResponse = KitInfo & { typeCheck: KitTypeCheck };

/** One ranked answer of a kit search: a kit, or one of its actions. */
export interface KitSearchHit {
  kit: string;
  /** Absent when the hit is the kit as a whole. */
  action?: string;
  score: number;
  /** The kit's description, or the first line of the action's doc. */
  text: string;
  active: boolean;
  /** Calls of the action so far, when it has run. */
  stats?: ActionStats;
}

/** One saved version of an agent kit. */
export interface KitVersion {
  version: number;
  /** ISO time of the save. */
  savedAt: string;
  /** The body that saved it. */
  savedBy: string;
  /** The version the agent kit has now. */
  current: boolean;
  /** Set when the version came from `kits.revert`: the version it restored. */
  revertedFrom?: number;
}

/** A routine in the library: a module `<name>.ts`. */
export interface RoutineInfo {
  name: string;
  /** The saved version whose source is the file's; absent for a file nothing saved through the library. */
  version?: number;
  /** ISO time of that version. */
  savedAt?: string;
}

/** One saved version of a routine. */
export interface RoutineVersion {
  version: number;
  /** ISO time of the save. */
  savedAt: string;
  /** The body that saved it; "unknown" for source found in the library that no save wrote. */
  savedBy: string;
  /** The latest version whose source is the routine's file. */
  current: boolean;
  /** Set when the version came from a revert: the version it restored. */
  revertedFrom?: number;
}

/** A trigger as the body keeps it: its definition, and what it has done since the body started. */
export interface TriggerInfo {
  name: string;
  on: string[];
  from?: string;
  match?: string;
  when?: string;
  run: string;
  cooldownMs: number;
  timeoutMs: number;
  enabled: boolean;
  preempt: boolean;
  priority: number;
  /** ISO time the trigger was saved. */
  updated: string;
  /** Why the body disabled it, when it did. */
  disabledReason?: string;
  /** Times it has run since the body started. */
  fired: number;
  /** ISO time of the latest firing since the body started. */
  lastFired?: string;
  /** How the latest run ended. */
  lastStatus?: RunStatus;
  lastError?: string;
  /** Runs in a row that failed. */
  failures: number;
}

export interface TriggersResponse {
  triggers: TriggerInfo[];
}

/** What saving a trigger returns: the trigger as stored, and whether it replaced one of the same name. */
export interface AddTriggerResponse {
  trigger: TriggerInfo;
  replaced: boolean;
}

/** What listing the routine library returns. */
export interface RoutinesResponse {
  routines: RoutineInfo[];
}

/** A routine's source. */
export interface RoutineSourceResponse {
  name: string;
  source: string;
}

/** What saving a routine returns: the routine as the library now has it, and the type check of its source (which never blocks a save). */
export interface SaveRoutineResponse {
  routine: RoutineInfo;
  typeCheck: KitTypeCheck;
}

export interface RoutineVersionsResponse {
  name: string;
  versions: RoutineVersion[];
}

/** What a revert returns: the routine, now at a new version holding the earlier source. */
export interface RevertRoutineResponse {
  routine: RoutineInfo;
}

/** An action binding: `name` calls the saved routine `routine`. */
export interface ActionBindingInfo {
  kind: "action";
  name: string;
  routine: string;
}

/** A name bound to a routine. */
export type BindingInfo = ActionBindingInfo;

export interface BindingsResponse {
  bindings: BindingInfo[];
}

/** What binding returns: the binding as stored, and whether it replaced one of the same name. */
export interface BindResponse {
  binding: BindingInfo;
  replaced: boolean;
}

export interface UnbindResponse {
  unbound: string;
}
