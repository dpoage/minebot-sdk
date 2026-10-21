// The supervisor's side of the bot host: forks the child process that holds the Minecraft player
// and runs agent programs, forwards API requests to it, and turns what it reports into the event
// log and the program history. Callers do not know the body lives in another process that may
// crash, hang, or be killed: the supervisor is the only killer, and it forks a replacement that
// reconnects as the same player.
import { fork, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { MAX_TIMEOUT_MS, type RunResult, type RunStatus } from "../protocol/index.ts";
import {
  hostArguments,
  hungCause,
  KILL_MARGIN_MS,
  NOT_CONNECTED_MESSAGE,
  programFinished,
  restartedError,
  STOP_GRACE_MS,
  triggerFinished,
  type FinishedEnd,
  type FromHost,
  type HostInit,
  type FiringOf,
  type LostFiring,
  type ToHost,
} from "../protocol/host.ts";
import type { EventLog } from "./events.ts";
import type { ForwardedRequest } from "./http.ts";
import type { ProgramHistory, RunEnd } from "./history.ts";

/** How long the host gets to run its shutdown before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** How long after a host's exit the supervisor waits for its channel to drain, so the host's last messages are handled before its death is. */
const CHANNEL_DRAIN_MS = 500;

const RESTART_BASE_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
/** A host that stays up this long was not crashing: the next restart starts the schedule over. */
export const STABLE_UP_MS = 60_000;

/**
 * How long to wait before the next host is forked: 1 s, doubling per consecutive restart up to
 * 60 s. `consecutive` counts the restarts since a host last stayed up for STABLE_UP_MS, and
 * `upMs` is how long the host that just ended was up.
 */
export function restartDelay(consecutive: number, upMs: number): number {
  const streak = upMs >= STABLE_UP_MS ? 0 : consecutive;
  return Math.min(RESTART_BASE_MS * 2 ** streak, RESTART_MAX_MS);
}

/** The host's entry, with this module's own extension: `.ts` from source, `.js` from a build. */
const DEFAULT_ENTRY = fileURLToPath(new URL(`../host/main${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url));

type Answer = PromiseWithResolvers<{ status: number; body: unknown }>;

const NOT_CONNECTED = { status: 503, body: { error: NOT_CONNECTED_MESSAGE } };

/** Why a host was killed whose program's end reached the supervisor just after the deadline had killed it: not a hang. */
const LATE_CAUSE = "the program ended just as its deadline to stop ran out";

/**
 * A run the host reported starting whose end has not reached where it goes. Its state, and nothing
 * else, decides what its deadline, a stop, and its host's death do with it; once the host has
 * delivered its end the record is removed.
 */
interface Run {
  id: number;
  end: RunEnd;
  /** Resolves when the run is no longer in flight: its end reported, or ended with its host. */
  finished: PromiseWithResolvers<void>;
  /** When the supervisor acked it: the program's own clock starts here. */
  startedAt: number;
  /** When the program's timeout aborts it, by the supervisor's clock. */
  timeoutAt: number;
  /** The API request this run answers, absent for a trigger's. */
  requestId?: number;
  /** The trigger definition the run fires, absent for a program. */
  trigger?: FiringOf;
  state: InFlight | Reported;
}

/** Acked, and no end handled yet: the only state a deadline kills, a stop waits for, and a death owes everything. */
interface InFlight {
  kind: "in-flight";
  /** When POST /stop reached the supervisor. */
  stopAt?: number;
  /** Kills the host when the program neither settles nor is reported hung in time. */
  deadline?: NodeJS.Timeout;
  /** What the host reported about a program that did not stop: its result, with the logs it held. */
  hung?: RunResult;
  /** Set when its deadline killed the host: an end that still arrives was late, not hung. */
  overdue?: boolean;
}

/**
 * Its end was reported and answered (the history wrote it, or refused it), and the host has yet to
 * deliver it: answer its request, log its trigger_finished. A death owes it only that delivery: the
 * end the host would have delivered.
 */
interface Reported {
  kind: "reported";
  /** The answer its request gets: the run's result, or the 500 of a write the history refused. */
  answer: { status: number; body: unknown };
  /** How its firing ended, for a trigger's run: the run's result, or the error of that write. */
  end: FinishedEnd;
}

/** One forked host. */
interface Attempt {
  child: ChildProcess;
  /** Settles when the host is ready, or fails to be. */
  ready: PromiseWithResolvers<void>;
  /** Resolves when the process has exited. */
  exited: Promise<void>;
  built: boolean;
  /** When it reported ready. */
  readyAt: number;
  /** Why the supervisor killed it, when it did. */
  cause?: string;
}

export class HostProcess {
  readonly #init: HostInit;
  readonly #events: EventLog;
  readonly #history: ProgramHistory;
  readonly #entry: string;
  readonly #graceMs: number;
  readonly #unsubscribe: () => void;
  readonly #requests = new Map<number, Answer>();
  /** Requests that arrived while no host was ready; the next host answers them. */
  #queued: { request: ForwardedRequest; answer: Answer }[] = [];
  readonly #runs = new Map<number, Run>();
  #attempt: Attempt | undefined;
  #nextRequest = 0;
  #connected = false;
  #joined = false;
  /** Set when the supervisor ends the host on purpose, so its exit is not a failure. */
  #ending = false;
  /** The latest restart attempt failed before its host was ready: requests answer 503 until one is. */
  #attemptFailed = false;
  /** Restarts since a host last stayed up for STABLE_UP_MS. */
  #consecutive = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  /** What the host last reported of what a replacement carries over. */
  #carried: { deaths: number; reconnects: number; active?: string[]; triggerFailures?: Record<string, number> };
  /** The trigger firing the last host ended in, until a replacement is ready, having counted it. */
  #lostFiring: LostFiring | undefined;
  /** The host's messages are handled one at a time, in order: a history line is on disk before the response that follows it is relayed. */
  #handling = Promise.resolve();

  constructor(o: { init: HostInit; events: EventLog; history: ProgramHistory; entry?: string /* tests only */; graceMs?: number /* tests only */ }) {
    this.#init = o.init;
    this.#events = o.events;
    this.#history = o.history;
    this.#entry = o.entry ?? DEFAULT_ENTRY;
    this.#graceMs = o.graceMs ?? STOP_GRACE_MS;
    this.#carried = { deaths: o.init.deaths, reconnects: o.init.reconnects, active: o.init.active, triggerFailures: o.init.triggerFailures };
    // The host's own copy of the log: its triggers hear events with the seq the log gave them.
    this.#unsubscribe = o.events.subscribe((event) => {
      if (this.#attempt?.child.connected) this.#send(this.#attempt, { kind: "event", event });
    });
  }

  /** Whether the host's player is in the world. */
  get connected(): boolean {
    return this.#connected;
  }

  /** How many runs the supervisor holds, in flight or with their end not yet delivered. Test-facing: a run whose end reached where it goes leaves none. */
  get openRuns(): number {
    return this.#runs.size;
  }

  /** Forks the first host and resolves once it has built its world; rejects with the reason it could not. A host that dies later is replaced, not reported here. */
  start(): Promise<void> {
    return this.#fork(this.#init).ready.promise;
  }

  /** Tells the host to join the server, and every host that replaces it. */
  join(): void {
    this.#joined = true;
    if (this.#readyAttempt()) this.#send(this.#attempt!, { kind: "start" });
  }

  /** Relays one API request the supervisor does not answer itself; a host that is down answers it when it is back. */
  forward(r: ForwardedRequest): Promise<{ status: number; body: unknown }> {
    if (this.#ending) return Promise.reject(new Error("the body is shutting down"));
    const answer: Answer = Promise.withResolvers();
    if (this.#readyAttempt()) this.#dispatch(r, answer);
    else if (this.#attemptFailed) answer.resolve(NOT_CONNECTED);
    else this.#queued.push({ request: r, answer });
    return answer.promise;
  }

  /** Aborts the running program, if there is one, and resolves once it has ended: settled, or the host killed after the grace. */
  async stop(): Promise<{ stopped: boolean }> {
    const now = Date.now();
    const ending: Promise<void>[] = [];
    for (const run of this.#runs.values()) {
      // A run whose end was reported has stopped, even while the host is delivering it.
      if (run.state.kind !== "in-flight") continue;
      run.state.stopAt ??= now;
      this.#arm(run, run.state);
      ending.push(run.finished.promise);
    }
    if (ending.length === 0) return { stopped: false };
    if (this.#attempt?.child.connected) this.#send(this.#attempt, { kind: "stop" });
    await Promise.all(ending);
    return { stopped: true };
  }

  /** Has the host close the body and exit; kills it when it does not within the grace period. */
  async close(): Promise<void> {
    this.#unsubscribe();
    this.#ending = true;
    clearTimeout(this.#restartTimer);
    for (const run of this.#runs.values()) if (run.state.kind === "in-flight") clearTimeout(run.state.deadline);
    await this.#terminate(this.#attempt);
    for (const run of this.#runs.values()) run.finished.resolve();
    this.#runs.clear();
    const err = new Error("the body is shutting down");
    for (const request of this.#requests.values()) request.reject(err);
    this.#requests.clear();
    for (const { answer } of this.#queued) answer.reject(err);
    this.#queued = [];
  }

  #readyAttempt(): boolean {
    return this.#attempt !== undefined && this.#attempt.built && this.#attempt.child.connected;
  }

  #send(attempt: Attempt, message: ToHost): void {
    // A send to a host that is dying fails: what its exit does (end its runs, answer its requests, restart) covers the message lost.
    attempt.child.send(message, () => {});
  }

  #fork(init: HostInit): Attempt {
    // The host watches this pid: it exits when its supervisor is gone, even with its main thread blocked.
    const child = fork(this.#entry, hostArguments(process.pid));
    const exited = Promise.withResolvers<void>();
    child.once("exit", () => exited.resolve());
    const attempt: Attempt = { child, ready: Promise.withResolvers(), exited: exited.promise, built: false, readyAt: 0 };
    attempt.ready.promise.catch(() => {}); // whoever forked it reports its failure
    this.#attempt = attempt;
    child.on("message", (message: FromHost) => {
      this.#handling = this.#handling.then(() => this.#handle(attempt, message)).catch((err: unknown) => console.error("[minebot] bot host message failed:", err));
    });
    child.once("exit", (code, signal) => void this.#onExit(attempt, signal ? `signal ${signal}` : `code ${code}`));
    child.once("error", (err) => attempt.ready.reject(err));
    this.#send(attempt, { kind: "init", init });
    return attempt;
  }

  /** Forks the replacement host, carrying over what the old one last reported. */
  async #restart(): Promise<void> {
    if (this.#ending) return;
    const { deaths, reconnects, active, triggerFailures } = this.#carried;
    // A restart is a reconnect of the same player; milestones the agent may have changed since the first start are kept.
    // Its triggers go on counting failures, the firing the old host ended in included.
    const init: HostInit = {
      ...this.#init,
      deaths,
      reconnects: reconnects + 1,
      ...(active && { active }),
      ...(triggerFailures && { triggerFailures }),
      ...(this.#lostFiring && { lostFiring: this.#lostFiring }),
      applyMilestones: false,
    };
    try {
      await this.#fork(init).ready.promise;
    } catch (err) {
      if (this.#ending) return;
      console.error(`[minebot] the replacement bot host did not start: ${errorText(err)}`);
      this.#attemptFailed = true;
      for (const { answer } of this.#queued) answer.resolve(NOT_CONNECTED);
      this.#queued = [];
      this.#schedule(0);
    }
  }

  #schedule(upMs: number): void {
    const delay = restartDelay(this.#consecutive, upMs);
    this.#consecutive = upMs >= STABLE_UP_MS ? 1 : this.#consecutive + 1;
    console.error(`[minebot] restarting the bot host in ${delay} ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#restart();
    }, delay);
  }

  #dispatch(r: ForwardedRequest, answer: Answer): void {
    const id = ++this.#nextRequest;
    this.#requests.set(id, answer);
    this.#send(this.#attempt!, { kind: "request", id, method: r.method, url: r.url, body: r.body?.toString("utf8") ?? null, tooLarge: r.tooLarge });
  }

  async #terminate(attempt: Attempt | undefined): Promise<void> {
    if (!attempt) return;
    if (attempt.child.connected) this.#send(attempt, { kind: "shutdown" });
    const killer = setTimeout(() => attempt.child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
    await attempt.exited;
    clearTimeout(killer);
  }

  /** The only place a host is killed on the supervisor's say-so besides shutdown. */
  #kill(attempt: Attempt, cause: string): void {
    attempt.cause ??= cause;
    attempt.child.kill("SIGKILL");
  }

  /**
   * (Re)arms the kill deadline of a run in flight: the program's clock (its timeout, or the stop that
   * reached the supervisor, whichever is first) + the grace + a margin that lets a live host's own report win.
   * It fires through the message chain and kills only while the run is still in this flight: a
   * run_finished handled before it, even one whose delivery is pending, has ended the run.
   */
  #arm(run: Run, flight: InFlight): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    clearTimeout(flight.deadline);
    const at = Math.min(run.timeoutAt, flight.stopAt ?? Infinity) + this.#graceMs + KILL_MARGIN_MS;
    flight.deadline = setTimeout(() => {
      this.#handling = this.#handling.then(() => {
        if (this.#runs.get(run.id) !== run || run.state !== flight) return;
        flight.overdue = true;
        this.#kill(attempt, hungCause(this.#graceMs));
      });
    }, Math.max(0, at - Date.now()));
  }

  async #handle(attempt: Attempt, message: FromHost): Promise<void> {
    // A host that was replaced or is gone has nothing to say.
    if (attempt !== this.#attempt) return;
    switch (message.kind) {
      case "ready":
        attempt.built = true;
        attempt.readyAt = Date.now();
        this.#attemptFailed = false;
        attempt.ready.resolve();
        this.#lostFiring = undefined;
        if (this.#joined) this.#send(attempt, { kind: "start" });
        for (const { request, answer } of this.#queued.splice(0)) this.#dispatch(request, answer);
        return;
      case "failed":
        // The host exits on its own after reporting; wait for it so nothing outlives the failed start.
        await this.#terminate(attempt);
        attempt.ready.reject(new Error(message.message));
        return;
      case "response":
        this.#requests.get(message.id)?.resolve({ status: message.status, body: message.body });
        this.#requests.delete(message.id);
        return;
      case "event":
        this.#events.push(message.type, message.data);
        return;
      case "run_delivered": {
        // Taken in with the delivery in one step: a host that dies after this owes nothing for the run, and it was counted once.
        if (message.finished) this.#events.push("trigger_finished", message.finished);
        if (message.disabled) this.#events.push("trigger_disabled", message.disabled);
        if (message.triggerFailures) this.#carried = { ...this.#carried, triggerFailures: message.triggerFailures };
        const run = this.#runs.get(message.runId);
        if (run?.state.kind === "reported") this.#runs.delete(run.id);
        return;
      }
      case "state":
        this.#connected = message.connected;
        this.#carried = { deaths: message.deaths, reconnects: message.reconnects, active: message.active, triggerFailures: message.triggerFailures };
        return;
      case "run_started":
        try {
          const end = await this.#history.begin(message.code, message.kits, message.extra);
          const now = Date.now();
          const flight: InFlight = { kind: "in-flight" };
          const run: Run = {
            id: message.runId,
            end,
            finished: Promise.withResolvers<void>(),
            startedAt: now,
            timeoutAt: now + Math.min(Math.max(message.timeoutMs, 0), MAX_TIMEOUT_MS),
            requestId: message.requestId,
            trigger: message.trigger,
            state: flight,
          };
          this.#runs.set(message.runId, run);
          // Armed before the host may run the code: a program that blocks its host is still ended.
          this.#arm(run, flight);
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId });
        } catch (err) {
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        return;
      case "run_finished": {
        const run = this.#runs.get(message.runId);
        // A run's end is handled once, while it is in flight.
        const flight = run?.state.kind === "in-flight" ? run.state : undefined;
        if (message.hung) {
          // The program did not stop and the host is alive to say so. Kill it; its death ends the run, with the logs it reported.
          if (flight) {
            flight.hung = message.result ?? undefined;
            this.#kill(attempt, hungCause(this.#graceMs));
          }
          return;
        }
        if (flight) {
          clearTimeout(flight.deadline);
          // The deadline killed the host as the program was ending: the restart is not for a hang.
          if (flight.overdue) attempt.cause = LATE_CAUSE;
        }
        let owed: Reported | undefined;
        try {
          if (run && flight && message.result) {
            const result = message.result;
            owed = { kind: "reported", answer: { status: 200, body: result }, end: result };
            await run.end(result);
          }
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId });
        } catch (err) {
          // The run fails as it did when the history was written in-process: its request answers 500, its firing ends in error.
          const error = errorText(err);
          if (owed && run) owed = { kind: "reported", answer: { status: 500, body: { error } }, end: { status: "error", error, durationMs: Date.now() - run.startedAt } };
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId, error });
        }
        if (!run || !flight) return;
        // The host delivers the end after the ack (its request's answer, its trigger_finished); until it has, its death delivers it.
        // A run that produced no result, or has nowhere to deliver one, is over.
        if (owed && (run.requestId !== undefined || run.trigger !== undefined)) run.state = owed;
        else this.#runs.delete(run.id);
        run.finished.resolve();
        return;
      }
      case "register":
        try {
          await this.#history.register(message.code, message.kits, message.extra);
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId });
        } catch (err) {
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        return;
    }
  }

  #sendIfOpen(attempt: Attempt, message: ToHost): void {
    if (attempt.child.connected) this.#send(attempt, message);
  }

  /** A host's process ended. Its last messages are handled before its death. */
  async #onExit(attempt: Attempt, how: string): Promise<void> {
    if (attempt.child.connected) {
      const drained = Promise.withResolvers<void>();
      attempt.child.once("disconnect", () => drained.resolve());
      await Promise.race([drained.promise, sleep(CHANNEL_DRAIN_MS, undefined, { ref: false })]);
    }
    this.#handling = this.#handling.then(() => this.#gone(attempt, how)).catch((err: unknown) => console.error("[minebot] handling the bot host's exit failed:", err));
  }

  async #gone(attempt: Attempt, how: string): Promise<void> {
    if (this.#attempt === attempt) this.#attempt = undefined;
    if (this.#ending) return;
    if (!attempt.built) {
      // startDaemon rejects with this for the first host; a replacement's failure is handled where it was forked.
      attempt.ready.reject(new Error(`the bot host exited before it was ready (${how})`));
      return;
    }
    const cause = attempt.cause ?? `the bot host exited (${how})`;
    this.#connected = false;

    // What the dead host still owed its runs: how they ended, then that it is gone, then the answers.
    // A run in flight is owed all of its end; a reported one only its delivery; a delivered one is no longer here.
    const runs = [...this.#runs.values()];
    this.#runs.clear();
    const answers = new Map<number, { status: number; body: unknown }>();
    for (const run of runs) {
      const { state } = run;
      let end: FinishedEnd;
      let answer: { status: number; body: unknown };
      if (state.kind === "in-flight") {
        clearTimeout(state.deadline);
        const result = state.hung ?? lostRun(run, state, cause);
        try {
          await run.end(result);
        } catch (err) {
          console.error("[minebot] could not write the history line of a program its host did not finish:", err);
        }
        if (run.trigger === undefined) this.#events.push("program_finished", programFinished(result));
        end = result;
        answer = { status: 200, body: result };
      } else {
        // Its end went to the history, and a program's run pushed its program_finished before reporting it.
        ({ end, answer } = state);
      }
      if (run.trigger !== undefined) {
        // As the host pushes it; the next host counts the firing in the trigger's failures.
        this.#lostFiring = { ...run.trigger, status: end.status, ...(end.error !== undefined && { error: end.error }), durationMs: end.durationMs };
        this.#events.push("trigger_finished", triggerFinished(run.trigger.name, end));
      }
      if (run.requestId !== undefined) answers.set(run.requestId, answer);
    }
    this.#events.push("disconnected", { reason: `bot host restarted: ${cause}` });
    // A request the host already answered is not waiting any more.
    for (const [id, answer] of answers) {
      this.#requests.get(id)?.resolve(answer);
      this.#requests.delete(id);
    }
    for (const run of runs) run.finished.resolve();
    for (const request of this.#requests.values()) request.resolve(NOT_CONNECTED);
    this.#requests.clear();
    this.#schedule(Date.now() - attempt.readyAt);
  }
}

/** How a run ended that its host could not report: stopped or timed out when it was aborted, else failed with the host. */
function lostRun(run: Run, flight: InFlight, cause: string): RunResult {
  const now = Date.now();
  let status: RunStatus = "error";
  if (flight.stopAt !== undefined && flight.stopAt <= run.timeoutAt) status = "stopped";
  else if (now >= run.timeoutAt) status = "timeout";
  return { status, error: restartedError(cause), logs: "", durationMs: now - run.startedAt };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
