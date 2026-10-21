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
  MAX_EVENT_LOGS,
  NOT_CONNECTED_MESSAGE,
  restartedError,
  STOP_GRACE_MS,
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

/** A program the host reported and that the supervisor has not seen delivered. */
interface RunInFlight {
  id: number;
  end: RunEnd;
  finished: PromiseWithResolvers<void>;
  /** When the supervisor acked it: the program's own clock starts here. */
  startedAt: number;
  /** When the program's timeout aborts it, by the supervisor's clock. */
  timeoutAt: number;
  /** When POST /stop reached the supervisor. */
  stopAt?: number;
  /** The API request this run answers, absent for a trigger's. */
  requestId?: number;
  /** The trigger definition the run fires, absent for a program. */
  trigger?: FiringOf;
  /** What the host reported about a program that did not stop: its result, with the logs it held. */
  hung?: RunResult;
  /**
   * The end the host reported and the history recorded. The run stays until the host has delivered
   * it (the response to its request, or its trigger_finished); a host that dies first has the supervisor deliver it.
   */
  reported?: RunResult;
  /** Kills the host when the program neither settles nor is reported hung in time. */
  deadline?: NodeJS.Timeout;
  /** Set when its deadline killed the host: an end that still arrives was late, not hung. */
  overdue?: boolean;
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
  readonly #runs = new Map<number, RunInFlight>();
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
    const running = [...this.#runs.values()].filter((run) => !run.reported);
    if (running.length === 0) return { stopped: false };
    const now = Date.now();
    const ending = running.map((run) => {
      run.stopAt ??= now;
      this.#arm(run);
      return run.finished.promise;
    });
    if (this.#attempt?.child.connected) this.#send(this.#attempt, { kind: "stop" });
    await Promise.all(ending);
    return { stopped: true };
  }

  /** Has the host close the body and exit; kills it when it does not within the grace period. */
  async close(): Promise<void> {
    this.#unsubscribe();
    this.#ending = true;
    clearTimeout(this.#restartTimer);
    for (const run of this.#runs.values()) clearTimeout(run.deadline);
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
   * (Re)arms the run's kill deadline: the program's clock (its timeout, or the stop that reached
   * the supervisor, whichever is first) + the grace + a margin that lets a live host's own report win.
   * It fires through the message chain, so a run_finished already received settles the run first.
   */
  #arm(run: RunInFlight): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    clearTimeout(run.deadline);
    const at = Math.min(run.timeoutAt, run.stopAt ?? Infinity) + this.#graceMs + KILL_MARGIN_MS;
    run.deadline = setTimeout(() => {
      this.#handling = this.#handling.then(() => {
        if (this.#runs.get(run.id) !== run) return;
        run.overdue = true;
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
        // The run it answers is delivered.
        for (const run of this.#runs.values()) if (run.reported && run.requestId === message.id) this.#runs.delete(run.id);
        return;
      case "event":
        this.#events.push(message.type, message.data);
        // A trigger run's end, delivered by its host.
        if (message.type === "trigger_finished") {
          for (const run of this.#runs.values()) if (run.reported && run.trigger?.name === message.data.name) this.#runs.delete(run.id);
        }
        return;
      case "state":
        this.#connected = message.connected;
        this.#carried = { deaths: message.deaths, reconnects: message.reconnects, active: message.active, triggerFailures: message.triggerFailures };
        return;
      case "run_started":
        try {
          const end = await this.#history.begin(message.code, message.kits, message.extra);
          const now = Date.now();
          const run: RunInFlight = {
            id: message.runId,
            end,
            finished: Promise.withResolvers<void>(),
            startedAt: now,
            timeoutAt: now + Math.min(Math.max(message.timeoutMs, 0), MAX_TIMEOUT_MS),
            requestId: message.requestId,
            trigger: message.trigger,
          };
          this.#runs.set(message.runId, run);
          // Armed before the host may run the code: a program that blocks its host is still ended.
          this.#arm(run);
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId });
        } catch (err) {
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        return;
      case "run_finished": {
        const run = this.#runs.get(message.runId);
        if (message.hung) {
          // The program did not stop and the host is alive to say so. Kill it; its death ends the run, with the logs it reported.
          if (run) {
            run.hung = message.result ?? undefined;
            this.#kill(attempt, hungCause(this.#graceMs));
          }
          return;
        }
        if (run) clearTimeout(run.deadline);
        // The deadline killed the host as the program was ending: the restart is not for a hang.
        if (run?.overdue) attempt.cause = LATE_CAUSE;
        let reported: RunResult | undefined;
        try {
          if (run && message.result) {
            await run.end(message.result);
            reported = message.result;
          }
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId });
        } catch (err) {
          // The run fails as it did when the history was written in-process.
          this.#sendIfOpen(attempt, { kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        // The host has yet to deliver the end, after the ack; until it has, its death delivers it.
        if (run && reported && (run.requestId !== undefined || run.trigger)) run.reported = reported;
        else this.#runs.delete(message.runId);
        run?.finished.resolve();
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

    // Everything the dead host could not say: how its runs ended, then that it is gone, then the answers.
    const runs = [...this.#runs.values()];
    this.#runs.clear();
    const results = new Map<RunInFlight, RunResult>();
    for (const run of runs) {
      clearTimeout(run.deadline);
      const result = run.hung ?? run.reported ?? lostRun(run, cause);
      results.set(run, result);
      // A reported end is on disk, and a program's run pushed its program_finished before reporting it.
      if (!run.reported) {
        try {
          await run.end(result);
        } catch (err) {
          console.error("[minebot] could not write the history line of a program its host did not finish:", err);
        }
        if (run.trigger === undefined) this.#events.push("program_finished", { status: result.status, durationMs: result.durationMs });
      }
      if (run.trigger !== undefined) {
        // As the host pushes it; the next host counts the firing in the trigger's failures.
        this.#lostFiring = { ...run.trigger, status: result.status, ...(result.error !== undefined && { error: result.error }), durationMs: result.durationMs };
        this.#events.push("trigger_finished", {
          name: run.trigger.name,
          status: result.status,
          durationMs: result.durationMs,
          ...(result.error !== undefined && { error: result.error }),
          ...(result.logs && { logs: result.logs.slice(0, MAX_EVENT_LOGS) }),
        });
      }
    }
    this.#events.push("disconnected", { reason: `bot host restarted: ${cause}` });
    for (const run of runs) {
      if (run.requestId !== undefined) this.#requests.get(run.requestId)?.resolve({ status: 200, body: results.get(run) });
      if (run.requestId !== undefined) this.#requests.delete(run.requestId);
      run.finished.resolve();
    }
    for (const request of this.#requests.values()) request.resolve(NOT_CONNECTED);
    this.#requests.clear();
    this.#schedule(Date.now() - attempt.readyAt);
  }
}

/** How a run ended that its host could not report: stopped or timed out when it was aborted, else failed with the host. */
function lostRun(run: RunInFlight, cause: string): RunResult {
  const now = Date.now();
  let status: RunStatus = "error";
  if (run.stopAt !== undefined && run.stopAt <= run.timeoutAt) status = "stopped";
  else if (now >= run.timeoutAt) status = "timeout";
  return { status, error: restartedError(cause), logs: "", durationMs: now - run.startedAt };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
