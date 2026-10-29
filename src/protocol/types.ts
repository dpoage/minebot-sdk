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
  /** How many times the player died while the run was active; absent when it did not. `observe` shows the last death. */
  diedDuringRun?: number;
}

/**
 * A finished foreground run (a module run or a call; a reflex firing is not one) as `GET /runs` and
 * the `get_run` tool serve it: the run's history line without its code. The body keeps the last
 * `KEPT_RUNS` of them, so an agent can read a run's outcome after it detached.
 */
export interface RunRecord {
  /** The run's seq: the `run` field of its `program_finished` event, and what `get_run` takes. */
  seq: number;
  startedAt: string;
  status: RunStatus;
  durationMs: number;
  result?: unknown;
  error?: string;
  logs: string;
  /** The call the run was: its name, the routine it is bound to when it is an action, and the args it was given. */
  call?: { name: string; routine?: string; args: unknown };
  /** The args a module run was given. */
  args?: unknown;
  /** How many times the player died while the run was active; absent when it did not. */
  diedDuringRun?: number;
}

export interface BodyEvent {
  /**
   * The log's number for this event: a seed taken from the log's creation wall clock, then one per
   * event. The seed is above an earlier log's seqs only when the new log starts in a later wall-clock
   * second than the earlier log's last event and that log averaged under 1000 events a second, so a
   * same-second restart can reuse an old cursor's range; the clock is assumed never to move back.
   */
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}

export interface EventsResponse {
  /** The events, oldest first: with no cursor, the newest `limit` of them. */
  events: BodyEvent[];
  /** Pass as `since` on the next call to receive only newer events. */
  next: number;
  /** The log's newest seq: anything pushed later is newer than every event here. */
  latest: number;
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

/** The most recent death of this host session, as the observation reports it. */
export interface DeathSummary {
  /** ISO time the body saw the death. */
  time: string;
  position: Vec;
  /** The server's death message, e.g. "Fartmastery drowned"; absent when the server sent none. */
  cause?: string;
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
  /** The stack a dropped item entity holds: `name` is the item (not "item"), `count` its size. Absent for every other entity. */
  item?: { name: string; count: number };
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
      /** Runs and calls in a row that ended with the same position and inventory. */
      programsWithoutChange: number;
      /** The most recent death of this host session; absent until the player dies. */
      lastDeath?: DeathSummary;
      /**
       * Where the player respawns: a bed or respawn anchor the server confirmed (the position it was set
       * at); `null` once the server reset it to the world spawn; absent while this host session has not heard.
       */
      spawnPoint?: Vec | null;
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
 * - stale-lesson: a lesson that names a module which changed since the lesson was written; `stale` says which and what to check.
 */
export type PageStatus = "verified" | "stale" | "unverified" | "lesson" | "stale-lesson";

export interface WikiPage {
  /** Path without extension, e.g. `quirks/drops-fall-out-of-reach` or `lessons/end-crystals`. */
  id: string;
  meta: PageMeta;
  status: PageStatus;
  /** Present exactly when `status` is `stale-lesson`: one `[stale: <module> changed since this lesson was written; check it against ... before relying on it]` mark per changed module. */
  stale?: string;
  body: string;
}

export interface PageSummary {
  id: string;
  title: string;
  tags: string[];
  status: PageStatus;
  /** Present exactly when `status` is `stale-lesson`; the same text as `WikiPage.stale`. */
  stale?: string;
}

export interface SearchHit extends PageSummary {
  score: number;
  snippet: string;
}

/** How often one built-in routine ran on this body. */
export interface ActionStats {
  ok: number;
  failed: number;
  /** The message of the latest failure; absent while the action has not failed. */
  lastError?: string;
}

/** The type check of a routine's source against the packages the body ships. It never blocks a save: `failed` lists the errors (`<name>.ts(line,col): error TSxxxx: ...`) and the routine is saved anyway; `skipped` says why no check ran (TypeScript is an optional peer dependency). */
export type TypeCheck =
  | {
      status: "passed";
      /** The suggestions a passing run's log carries: a missing-member read, and the real member to use (absent when the check had none). */
      notes?: string[];
    }
  | { status: "failed"; errors: string[] }
  | { status: "skipped"; reason: string };

/** A built-in routine module a body offers: `import * as <name> from "minebot-sdk/routines/<name>"`, and each routine callable as `<name>.<routine>`. */
export interface BuiltinInfo {
  name: string;
  description: string;
  /** The built-in modules offered together with this one (`uses`); every one of them is offered too. */
  uses: string[];
  /** Routine names, in the order the module declares them, e.g. `to`. */
  routines: string[];
  /** Calls so far, by routine name; routines that never ran are absent. Counted per body, and kept across restarts. */
  stats: Record<string, ActionStats>;
}

export interface BuiltinsResponse {
  builtins: BuiltinInfo[];
}

/** One ranked answer of a built-in search: a module, or one of its routines. */
export interface BuiltinSearchHit {
  module: string;
  /** Absent when the hit is the module as a whole. */
  routine?: string;
  score: number;
  /** The module's description, or the first line of the routine's description. */
  text: string;
  /** Calls of the routine so far, when it has run. */
  stats?: ActionStats;
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
  typeCheck: TypeCheck;
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

/**
 * A reflex: the saved routine `routine` runs when the events in `on` arrive, called with
 * `(ctx, { event })`, with the fields it was bound with and what the body has counted for it since it started.
 */
export interface ReflexBindingInfo {
  kind: "reflex";
  name: string;
  routine: string;
  on: string[];
  from?: string;
  match?: string;
  when?: string;
  cooldownMs: number;
  timeoutMs: number;
  enabled: boolean;
  preempt: boolean;
  priority: number;
  /** ISO time the reflex was bound. */
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

/** A name bound to a routine. */
export type BindingInfo = ActionBindingInfo | ReflexBindingInfo;

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
