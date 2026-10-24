// The host's side of the supervisor channel, over a `send` function so it runs without a fork:
// the event sink that hands events to the supervisor's log and hears them back with the log's
// seq, the reporter that holds the host's one run slot and has the supervisor record each program
// run before its code starts, and the runner view through which the reflex scheduler sees that slot.
import { DEFAULT_TIMEOUT_MS, type BodyEvent, type RunResult } from "../protocol/index.ts";
import type { EventSink, FiringOf, FromHost, RunPreview, TriggerDisabled, TriggerFinished } from "../protocol/host.ts";
import { BusyError, type RunOutcome } from "../program/runner.ts";
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
  /** Sends a message to the supervisor. `written` is called once the message is written to the channel, or could not be. */
  send: (message: FromHost, written?: () => void) => void;
  /** Aborts the running run; false when none runs. */
  stop: () => boolean;
  /** Whether the runner runs code now (one whose code has started and not settled, its grace included). */
  running: () => boolean;
}

/**
 * The runner as the reflex scheduler sees it. Its `running` is the recorder's `busy`: true while the run slot is taken (a run reserved,
 * running, or in its grace), not only while a run's code executes. A preemption is the recorder's to carry out, so the supervisor's deadline covers the abort. The body and the reflex fixture both wire their Triggers with this.
 */
export function preemptingRunner(recorder: Pick<RunRecorder, "busy" | "preempt">): { readonly running: boolean; stop(): boolean } {
  return {
    get running() {
      return recorder.busy;
    },
    stop: () => recorder.preempt(),
  };
}

/**
 * The host's one run slot. A run takes it at its arrival (`reserved`: its start is sent to the supervisor, its code waits for
 * the ack, and a stop or preemption asked meanwhile waits in `pending`), holds it while its code runs (`running`), and from the
 * ask of its abort (`grace`) until its end. A run that arrives while the slot is taken is refused as busy.
 */
type Slot = { state: "idle" } | { state: "reserved"; runId: number; pending?: "stop" | "preempt" } | { state: "running"; runId: number } | { state: "grace"; runId: number };

const IDLE: Slot = { state: "idle" };

/**
 * Reports program runs and registrations to the supervisor, which writes the history, and holds the run slot: every run (a
 * call, a module run, a reflex firing) goes through `record`, and every event of a run (its arrival, the ack of its start,
 * a stop, a preemption, its end, the end of its grace) acts on the slot by the state it is in.
 */
export class RunReporter implements RunRecorder {
  readonly #options: RunReporterOptions;
  readonly #acks = new Map<number, PromiseWithResolvers<void>>();
  readonly #open = new Set<Promise<unknown>>();
  /** Request id → the run whose end the supervisor holds (recorded or refused), until the answer is sent. */
  readonly #answering = new Map<number, number>();
  /** A reflex run's returned or thrown end → its run, until `deliver`. */
  readonly #delivering = new WeakMap<object, number>();
  readonly #idleListeners: (() => void)[] = [];
  #nextId = 0;
  #slot: Slot = IDLE;

  constructor(options: RunReporterOptions) {
    this.#options = options;
  }

  get busy(): boolean {
    return this.#slot.state !== "idle";
  }

  onIdle(listener: () => void): void {
    this.#idleListeners.push(listener);
  }

  /** The supervisor's answer to a `run_started` or `register`; `error` means the history could not record it. */
  acknowledge(runId: number, error?: string): void {
    const ack = this.#acks.get(runId);
    this.#acks.delete(runId);
    if (error === undefined) ack?.resolve();
    else ack?.reject(new Error(error));
  }

  /** Aborts the run that holds the slot; one whose start the supervisor has not acked yet is aborted as it starts. */
  stop(): void {
    const slot = this.#slot;
    switch (slot.state) {
      case "idle":
        return;
      case "reserved":
        slot.pending = "stop";
        return;
      case "running":
      case "grace":
        this.#slot = { state: "grace", runId: slot.runId };
        this.#options.stop();
    }
  }

  /**
   * Asks the run that holds the slot to stop because a preempting firing is waiting; true when that firing is to wait for the
   * run's end (the slot frees then), false when no run holds the slot or the one that does runs no program at this moment.
   * The supervisor learns of the preemption (and so arms its kill deadline for the run) before the program is aborted:
   * a program that blocks the host right after its abort would otherwise keep that message queued behind the host's
   * frozen thread. The abort follows once the message is written, and only if the run still holds the slot in its grace:
   * a run that ended meanwhile is not followed by an abort of its successor. A run whose start is not acked yet is preempted as it starts.
   */
  preempt(): boolean {
    const slot = this.#slot;
    switch (slot.state) {
      case "idle":
        return false;
      case "reserved":
        slot.pending ??= "preempt";
        return true;
      case "grace":
        // Its abort is asked already.
        return true;
      case "running": {
        // Its code failed to start, or settled and its end is not handled yet: the slot frees without an abort.
        if (!this.#options.running()) return false;
        const { runId } = slot;
        this.#slot = { state: "grace", runId };
        this.#options.send({ kind: "preempt", runId }, () => {
          const now = this.#slot;
          if (now.state === "grace" && now.runId === runId) this.#options.stop();
        });
        return true;
      }
    }
  }

  async record(run: { code: string; timeoutMs?: number; extra?: object; requestId?: number; trigger?: FiringOf }, execute: () => Promise<RunOutcome & RunPreview>): Promise<RunResult> {
    // Its arrival: the run takes the slot, or is refused before the supervisor hears of it.
    if (this.#slot.state !== "idle") throw new BusyError();
    const runId = this.#nextId++;
    const reserved: Slot & { state: "reserved" } = { state: "reserved", runId };
    this.#slot = reserved;
    try {
      await this.#acked(runId, {
        kind: "run_started",
        runId,
        code: run.code,
        timeoutMs: run.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        extra: run.extra ?? {},
        ...(run.requestId !== undefined && { requestId: run.requestId }),
        ...(run.trigger && { trigger: run.trigger }),
      });
    } catch (err) {
      // The history refused its start: its code never starts, and what was pending for it goes with it.
      this.#release();
      throw err;
    }
    // The program starts synchronously inside `execute`, in this same turn.
    this.#slot = { state: "running", runId };
    let running: Promise<RunOutcome>;
    try {
      running = execute();
    } catch (err) {
      running = Promise.reject(err);
    }
    if (reserved.pending === "stop") this.stop();
    else if (reserved.pending === "preempt") this.preempt();
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
    await this.#acked(runId, { kind: "register", runId, code, extra });
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
  async #finish(runId: number, running: Promise<RunOutcome & RunPreview>, owes: (end: object) => void): Promise<RunResult> {
    let outcome: RunOutcome & RunPreview;
    try {
      outcome = await running;
    } catch (err) {
      // It threw before producing a result (not connected, no routines): the run is over, with nothing to record.
      this.#release();
      await this.#acked(runId, { kind: "run_finished", runId, result: null });
      throw err;
    }
    const { hung, errorLine, resultPreview, ...result } = outcome;
    // The end of its grace with the program unsettled (hung): the runner is free, but the supervisor kills this host on the report
    // below, so no waiting firing is woken; a run that arrives meanwhile has its start reach the supervisor behind that report.
    if (hung) this.#slot = IDLE;
    else this.#release();
    try {
      await this.#acked(runId, { kind: "run_finished", runId, result, ...(hung && { hung }), ...(errorLine !== undefined && { errorLine }), ...(resultPreview !== undefined && { resultPreview }) });
    } catch (err) {
      owes(err as object);
      throw err;
    }
    owes(result);
    return result;
  }

  /** The run that held the slot has ended: the slot is free, and whoever waits for it (the reflex scheduler) is told, before the end is reported. */
  #release(): void {
    this.#slot = IDLE;
    for (const listener of this.#idleListeners) listener();
  }

  #acked(runId: number, message: FromHost): Promise<void> {
    const ack = Promise.withResolvers<void>();
    this.#acks.set(runId, ack);
    this.#options.send(message);
    return ack.promise;
  }
}
