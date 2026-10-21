// The host's side of the supervisor channel, over a `send` function so it runs without a fork:
// the event sink that hands events to the supervisor's log and hears them back with the log's
// seq, and the reporter that has the supervisor record each program run before its code starts.
import { DEFAULT_TIMEOUT_MS, type BodyEvent, type RunResult } from "../protocol/index.ts";
import type { EventSink, FiringOf, FromHost, TriggerDisabled, TriggerFinished } from "../protocol/host.ts";
import type { RunOutcome } from "../program/runner.ts";
import type { RunRecorder } from "./body.ts";

/**
 * Events pushed here go to the supervisor, which logs them (assigning seq and time) and echoes
 * each back through `hear`. Subscribers get the echo, so what they see carries the log's seq.
 */
export class HostEvents implements EventSink {
  readonly #send: (message: FromHost) => void;
  readonly #listeners = new Set<(event: BodyEvent) => void>();

  constructor(send: (message: FromHost) => void) {
    this.#send = send;
  }

  push(type: string, data: Record<string, unknown> = {}): void {
    this.#send({ kind: "event", type, data });
  }

  subscribe(listener: (event: BodyEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Delivers an event the supervisor's log recorded. */
  hear(event: BodyEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not reach the channel.
      }
    }
  }
}

export interface RunReporterOptions {
  send: (message: FromHost) => void;
  /** The kits the body is running now. */
  kits: () => string[];
  /** Aborts the running program; false when none runs. */
  stop: () => boolean;
}

/** Reports program runs and registrations to the supervisor, which writes the history. */
export class RunReporter implements RunRecorder {
  readonly #options: RunReporterOptions;
  readonly #acks = new Map<number, PromiseWithResolvers<void>>();
  readonly #open = new Set<Promise<unknown>>();
  /** Requests answered by a run whose end the supervisor holds (recorded, or refused by the history): the request id → that run, until the answer is sent. */
  readonly #answering = new Map<number, number>();
  /** What trigger runs whose end the supervisor holds returned or threw → their run, until `deliver`. */
  readonly #delivering = new WeakMap<object, number>();
  #nextId = 0;
  /** Runs reported whose code has not started yet. */
  #starting = 0;
  /** A stop that arrived after the supervisor acked a run but before its code started. */
  #stopPending = false;

  constructor(options: RunReporterOptions) {
    this.#options = options;
  }

  /** The supervisor's answer to a `run_started` or `register`; `error` means the history could not record it. */
  acknowledge(runId: number, error?: string): void {
    const ack = this.#acks.get(runId);
    this.#acks.delete(runId);
    if (error === undefined) ack?.resolve();
    else ack?.reject(new Error(error));
  }

  /** Aborts the running program. A run the supervisor has acked but that has not started yet is aborted as it starts. */
  stop(): void {
    if (!this.#options.stop() && this.#starting > 0) this.#stopPending = true;
  }

  async record(run: { code: string; timeoutMs?: number; extra?: object; requestId?: number; trigger?: FiringOf }, execute: () => Promise<RunOutcome>): Promise<RunResult> {
    const runId = this.#nextId++;
    this.#starting++;
    try {
      await this.#acked(runId, {
        kind: "run_started",
        runId,
        code: run.code,
        timeoutMs: run.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        extra: run.extra ?? {},
        kits: this.#options.kits(),
        ...(run.requestId !== undefined && { requestId: run.requestId }),
        ...(run.trigger && { trigger: run.trigger }),
      });
    } catch (err) {
      // The run never starts; a stop meant for it must not abort the next one.
      if (--this.#starting === 0) this.#stopPending = false;
      throw err;
    }
    // The program starts synchronously inside `execute`, in this same turn.
    let running: Promise<RunOutcome>;
    try {
      running = execute();
    } catch (err) {
      running = Promise.reject(err);
    }
    this.#starting--;
    if (this.#stopPending) {
      this.#stopPending = false;
      this.#options.stop();
    }
    // The supervisor holds a reported end, recorded or refused, until this host delivers it: the answer to its request, or `deliver`.
    const owes = (end: object) => {
      if (run.requestId !== undefined) this.#answering.set(run.requestId, runId);
      else if (run.trigger) this.#delivering.set(end, runId);
    };
    const finished = this.#finish(runId, running, owes);
    this.#open.add(finished);
    try {
      return await finished;
    } finally {
      this.#open.delete(finished);
    }
  }

  /** Sends the answer to a forwarded request; then the run whose end it carries, if one does, is delivered. */
  answer(response: { id: number; status: number; body: unknown }): void {
    this.#options.send({ kind: "response", ...response });
    const runId = this.#answering.get(response.id);
    if (runId === undefined) return;
    this.#answering.delete(response.id);
    this.#options.send({ kind: "run_delivered", runId });
  }

  deliver(end: unknown, finished: TriggerFinished, disabled: TriggerDisabled | undefined, triggerFailures: Record<string, number>): boolean {
    const runId = typeof end === "object" && end !== null ? this.#delivering.get(end) : undefined;
    // No run of the supervisor's waits for this end: it never started, or never ran.
    if (runId === undefined) return false;
    this.#delivering.delete(end as object);
    // One message: the supervisor logs the events, takes the failures, and drops the run together, so no death can split them.
    this.#options.send({ kind: "run_delivered", runId, finished, ...(disabled && { disabled }), triggerFailures });
    return true;
  }

  counts(triggerFailures: Record<string, number>, ended?: { finished?: TriggerFinished; disabled?: TriggerDisabled }): void {
    // One message: no death can split a firing's events from the counts it leaves.
    this.#options.send({ kind: "trigger_counts", triggerFailures, ...(ended?.finished && { finished: ended.finished }), ...(ended?.disabled && { disabled: ended.disabled }) });
  }

  async register(code: string, extra: object): Promise<void> {
    const runId = this.#nextId++;
    await this.#acked(runId, { kind: "register", runId, code, extra, kits: this.#options.kits() });
  }

  /** Resolves once every reported run has reported its end. */
  async drained(): Promise<void> {
    await Promise.allSettled([...this.#open]);
  }

  /**
   * Reports the run's end and settles once the supervisor has answered; a failure to record fails the run.
   * Either way the supervisor now holds the end, and `owes` is told what the run returned or threw.
   * A hung run is reported as such and never settles: the supervisor kills this host instead of acking.
   */
  async #finish(runId: number, running: Promise<RunOutcome>, owes: (end: object) => void): Promise<RunResult> {
    let outcome: RunOutcome;
    try {
      outcome = await running;
    } catch (err) {
      // It threw before producing a result (not connected, busy): the run is over, with nothing to record.
      await this.#acked(runId, { kind: "run_finished", runId, result: null });
      throw err;
    }
    const { hung, ...result } = outcome;
    try {
      await this.#acked(runId, { kind: "run_finished", runId, result, ...(hung && { hung }) });
    } catch (err) {
      owes(err as object);
      throw err;
    }
    owes(result);
    return result;
  }

  #acked(runId: number, message: FromHost): Promise<void> {
    const ack = Promise.withResolvers<void>();
    this.#acks.set(runId, ack);
    this.#options.send(message);
    return ack.promise;
  }
}
