// The IPC contract between the supervisor (src/body/) and the bot host it forks (src/host/): the
// arguments the host is forked with and the messages each side sends over the child-process
// channel. Not re-exported from the protocol index: clients of the body API never see it.
import type { DaemonOptions } from "../body/daemon.ts";
import type { BodyEvent, RunResult, RunStatus } from "./types.ts";

/** The arguments the supervisor forks the host with: its own pid, which the host watches to end with it. */
export function hostArguments(supervisorPid: number): string[] {
  return [String(supervisorPid)];
}

/** The supervisor's pid from the host's `process.argv`; undefined when the host was not forked by a supervisor. */
export function supervisorPidOf(argv: readonly string[]): number | undefined {
  const pid = Number(argv[2]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** How long a program gets to settle after it is aborted (stop, timeout, preemption) before the host is restarted. */
export const STOP_GRACE_MS = 5_000;
/**
 * Extra time the supervisor gives a live host to report a hung program before it kills the host
 * itself: with none, the supervisor's deadline (on its own clock) races the host's report.
 */
export const KILL_MARGIN_MS = 500;

/** What a request answers while the body has no player connection, and while the host is down for good. */
export const NOT_CONNECTED_MESSAGE = "the body is not connected to a server";

/** Why the host was restarted when a program did not stop. */
export function hungCause(graceMs: number): string {
  return `the program did not stop within ${graceMs / 1000} s`;
}

/** The error a run carries when its host was restarted. */
export function restartedError(cause: string): string {
  return `${cause}; the bot host was restarted`;
}

/** The part of a trigger run's logs kept in its `trigger_finished` event, whether the host or the supervisor pushes it. */
export const MAX_EVENT_LOGS = 2000;

/** How a program's run or a trigger's firing ended, as far as its finished event tells. */
export type FinishedEnd = { status: RunStatus; error?: string; logs?: string; durationMs: number };

export type ProgramFinished = { status: RunStatus; durationMs: number };
export type TriggerFinished = { name: string; status: RunStatus; durationMs: number; error?: string; logs?: string };
export type TriggerDisabled = { name: string; failures: number; reason: string };

/** The data of a `program_finished` event, built by the host that ran the program and by the supervisor that ends it for a dead host. */
export function programFinished(end: FinishedEnd): ProgramFinished {
  return { status: end.status, durationMs: end.durationMs };
}

/** The data of a `trigger_finished` event, built by the host that ran the firing and by the supervisor that ends it for a dead host. */
export function triggerFinished(name: string, end: FinishedEnd): TriggerFinished {
  const logs = end.logs ? end.logs.slice(0, MAX_EVENT_LOGS) : undefined;
  return { name, status: end.status, durationMs: end.durationMs, ...(end.error !== undefined && { error: end.error }), ...(logs && { logs }) };
}

/** Which definition of a trigger a firing ran: its name and when that definition was saved. */
export interface FiringOf {
  name: string;
  updated: string;
}

/** How a trigger's firing ended that its host could not finish: the host was killed or died during it. */
export interface LostFiring extends FiringOf {
  status: RunStatus;
  error?: string;
  durationMs: number;
}

/** Where events are pushed and heard: the supervisor's EventLog, and the bot host's stand-in that sends them there. */
export interface EventSink {
  push(type: string, data?: Record<string, unknown>): void;
  /** Calls `listener` with every event as it is logged. Returns the function that stops it. */
  subscribe(listener: (event: BodyEvent) => void): () => void;
}

/**
 * What the host builds its world from: the daemon's options without what only the supervisor
 * serves (the API address, the token, the history file), plus what a host carries over.
 */
export type HostInit = Omit<DaemonOptions, "apiHost" | "apiPort" | "token" | "historyFile"> & {
  /** When the supervisor started; the host's /status reports it. */
  startedAt: string;
  deaths: number;
  reconnects: number;
  /** The kit set to activate, when it is not the catalog's default. */
  active?: string[];
  /** Each trigger's run of failures, as the host this one replaces last reported it. */
  triggerFailures?: Record<string, number>;
  /** The trigger firing the replaced host ended in: this host records its end as if the firing had finished here. */
  lostFiring?: LostFiring;
  /** Whether the host sets `milestones` from the options; false once an agent may have replaced them. */
  applyMilestones: boolean;
};

export type ToHost =
  | { kind: "init"; init: HostInit }
  /** Joins the server; sent once the endpoint is published. */
  | { kind: "start" }
  /** One API request that is not the supervisor's. `body` is the raw request body, parsed when a handler reads it. */
  | { kind: "request"; id: number; method: string; url: string; body: string | null; tooLarge: boolean }
  /** Aborts the running program. */
  | { kind: "stop" }
  /**
   * Answers `run_started`, `run_finished`, or `register` once the history line is written; `error`
   * means it could not be. After `run_started` the program must not run; after `run_finished` the
   * run fails with `error`. A `run_finished` without a result is answered with no error.
   */
  | { kind: "run_ack"; runId: number; error?: string }
  /** Echo of every event the supervisor's log recorded, with the log's own seq and time. */
  | { kind: "event"; event: BodyEvent }
  /** Closes the body, flushes what is buffered, and exits. */
  | { kind: "shutdown" };

export type FromHost =
  | { kind: "ready" }
  /** The world could not be built; `message` is the error's text. */
  | { kind: "failed"; message: string }
  | { kind: "response"; id: number; status: number; body: unknown }
  /** An event for the supervisor's log; the supervisor numbers it and echoes it back. */
  | { kind: "event"; type: string; data: Record<string, unknown> }
  /**
   * A program is about to run; user code starts only after the matching `run_ack`. `requestId` is
   * the forwarded request the run answers (/run, /kits/try); `trigger` is the definition a trigger's run fires, which has no request.
   */
  | { kind: "run_started"; runId: number; code: string; timeoutMs: number; extra: object; kits: string[]; requestId?: number; trigger?: FiringOf }
  /**
   * The run ended; the run settles once the matching `run_ack` arrives. `result: null` means it threw
   * before producing one (not connected, busy): the run is over and leaves no final history line.
   * `hung` means the program was aborted and has not settled within the grace: `result` holds what
   * the run had, the supervisor kills the host and restarts it, and no `run_ack` is sent.
   */
  | { kind: "run_finished"; runId: number; result: RunResult | null; hung?: true }
  /**
   * The end of a run, reported and acked, reached where it goes: its request was answered (sent
   * after the `response`) or, for a trigger's run, `finished` is the trigger_finished, `disabled`
   * the trigger_disabled the firing caused, and `triggerFailures` the failures with the firing
   * counted, all taken in as one message.
   */
  | { kind: "run_delivered"; runId: number; finished?: TriggerFinished; disabled?: TriggerDisabled; triggerFailures?: Record<string, number> }
  /** Code the body will run later (a trigger), for the history's audit; answered by `run_ack` like a run. */
  | { kind: "register"; runId: number; code: string; extra: object; kits: string[] }
  /**
   * The triggers' failures after a change no run's delivery carries: the counts a host starts with
   * (the firing it was started to count included), a firing that ended with no run of the
   * supervisor's behind it, a trigger saved, enabled or removed. For such a firing, `finished` and
   * `disabled` are taken in with the counts as one message. With `run_delivered`, the only way
   * counts reach the supervisor.
   */
  | { kind: "trigger_counts"; triggerFailures: Record<string, number>; finished?: TriggerFinished; disabled?: TriggerDisabled }
  | { kind: "state"; connected: boolean; deaths: number; reconnects: number; active: string[] };
