// The IPC contract between the supervisor (src/body/) and the bot host it forks (src/host/): the
// messages each side sends over the child-process channel. Types only, and not re-exported from
// the protocol index: clients of the body API never see it.
import type { DaemonOptions } from "../body/daemon.ts";
import type { BodyEvent, RunResult } from "./types.ts";

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
  /** Answers `run_started` or `register` once the history line is written; `error` means it could not be, and the program must not run. */
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
  /** A program is about to run; user code starts only after the matching `run_ack`. */
  | { kind: "run_started"; runId: number; code: string; timeoutMs: number; extra: object; kits: string[] }
  /** The run ended. `result: null` means it threw before producing one (not connected, busy): the run is over and leaves no final history line. */
  | { kind: "run_finished"; runId: number; result: RunResult | null }
  /** Code the body will run later (a trigger), for the history's audit; answered by `run_ack` like a run. */
  | { kind: "register"; runId: number; code: string; extra: object; kits: string[] }
  | { kind: "state"; connected: boolean; deaths: number; reconnects: number; active: string[] };
