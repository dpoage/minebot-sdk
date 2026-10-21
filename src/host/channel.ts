// The host's side of the supervisor channel, over a `send` function so it runs without a fork:
// the event sink that hands events to the supervisor's log and hears them back with the log's
// seq, and the reporter that has the supervisor record each program run before its code starts.
import { DEFAULT_TIMEOUT_MS, type BodyEvent, type RunResult } from "../protocol/index.ts";
import type { EventSink, FromHost } from "../protocol/host.ts";
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

  async record(run: { code: string; timeoutMs?: number; extra?: object }, execute: () => Promise<RunResult>): Promise<RunResult> {
    const runId = this.#nextId++;
    this.#starting++;
    try {
      await this.#acked(runId, { kind: "run_started", runId, code: run.code, timeoutMs: run.timeoutMs ?? DEFAULT_TIMEOUT_MS, extra: run.extra ?? {}, kits: this.#options.kits() });
    } catch (err) {
      this.#starting--;
      throw err;
    }
    // The program starts synchronously inside `execute`, in this same turn.
    let running: Promise<RunResult>;
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
    const finished = this.#finish(runId, running);
    this.#open.add(finished);
    try {
      return await finished;
    } finally {
      this.#open.delete(finished);
    }
  }

  async register(code: string, extra: object): Promise<void> {
    const runId = this.#nextId++;
    await this.#acked(runId, { kind: "register", runId, code, extra, kits: this.#options.kits() });
  }

  /** Resolves once every reported run has reported its end. */
  async drained(): Promise<void> {
    await Promise.allSettled([...this.#open]);
  }

  async #finish(runId: number, running: Promise<RunResult>): Promise<RunResult> {
    try {
      const result = await running;
      this.#options.send({ kind: "run_finished", runId, result });
      return result;
    } catch (err) {
      // It threw before producing a result (not connected, busy): the run is over, with nothing to record.
      this.#options.send({ kind: "run_finished", runId, result: null });
      throw err;
    }
  }

  #acked(runId: number, message: FromHost): Promise<void> {
    const ack = Promise.withResolvers<void>();
    this.#acks.set(runId, ack);
    this.#options.send(message);
    return ack.promise;
  }
}
