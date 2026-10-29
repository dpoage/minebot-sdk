import { DEFAULT_TIMEOUT_MS, type BodyEvent, type EventsResponse, type WaitResponse } from "../protocol/index.ts";
import { eventMatches, type EventFilter } from "../protocol/event-filter.ts";
import type { EventSink } from "../protocol/host.ts";

interface Waiter {
  /** Events up to this seq were already scanned when the waiter subscribed; only newer ones can match. */
  since: number;
  filter: EventFilter;
  resolve: (result: WaitResponse) => void;
  timer: NodeJS.Timeout;
}

export interface EventWaitOptions extends EventFilter {
  /** Only events after this cursor. Default: the current end of the log, so only new events match. */
  since?: number;
  timeoutMs?: number;
  /** Aborting settles the wait without a result; used when a client hangs up on a pending wait. */
  signal?: AbortSignal;
}

/**
 * A fresh log must number above any seq an earlier daemon's log issued, or a cursor held across the
 * restart would hide the new log's first events. The seed is the wall clock's next second times 1000,
 * so a log created in any later second seeds above an earlier log's seqs as long as no log sustains a
 * thousand events a second, and each log counts up by one: seqs stay one small integer per event,
 * gap-free within a log. Nothing is persisted for it. Assumes the wall clock never moves back (a step
 * back could let a fresh log reuse an old cursor's range) and a body pushes fewer than 1000 events a
 * second on average.
 */
const SEQS_PER_SECOND = 1000;
/** The highest seq any log in this process issued or started from; two logs here never overlap either. */
let issued = 0;

/** The seq a new log starts from: the clock's next second times 1000, or above this process's latest log. */
function seed(): number {
  const start = Math.max((Math.floor(Date.now() / 1000) + 1) * SEQS_PER_SECOND, issued);
  issued = start;
  return start;
}

/** Bounded, sequence-numbered log of things that happened to a body. */
export class EventLog implements EventSink {
  readonly #capacity: number;
  #ring: BodyEvent[] = [];
  #waiters = new Set<Waiter>();
  #listeners = new Set<(event: BodyEvent) => void>();
  /** The last day or night event logged: the phase that holds now, which a wait for it must answer from at once. */
  #phase: BodyEvent | undefined;
  #seq: number;

  constructor(capacity = 1000) {
    this.#capacity = capacity;
    this.#seq = seed();
  }

  push(type: string, data: Record<string, unknown> = {}): void {
    const event = { seq: ++this.#seq, time: Date.now(), type, data };
    issued = this.#seq;
    this.#ring.push(event);
    if (this.#ring.length > this.#capacity) this.#ring.splice(0, this.#ring.length - this.#capacity);
    // The newest day or night event is the phase that holds now; see `wait`.
    if (type === "day" || type === "night") this.#phase = event;
    // A waiter consumes no event: every wait pending on the event's arrival is settled with it.
    for (const waiter of [...this.#waiters]) {
      if (eventMatches(event, waiter.filter)) this.#settle(waiter, { event, next: event.seq, timedOut: false });
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not reach whatever pushed the event.
      }
    }
  }

  /** Calls `listener` with every event as it is pushed. Returns the function that stops it. */
  subscribe(listener: (event: BodyEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Returns at most `limit` buffered events, oldest first. Without `since` that is the newest
   * `limit` of them, and `next` is the log's newest seq: what a caller asking for "the events"
   * wants, so a stale buffer's oldest events cannot crowd out the newest. With `since` it is the
   * oldest `limit` events whose seq is greater; a cursor ahead of the log starts from the beginning.
   * `latest` always names the log's newest seq.
   */
  since(since?: number, limit = 200): EventsResponse {
    const latest = this.#seq;
    if (since === undefined) {
      const events = this.#ring.slice(-limit);
      return { events, next: events.at(-1)?.seq ?? latest, latest };
    }
    const from = since > latest ? 0 : since;
    const events = this.#ring.filter((e) => e.seq > from).slice(0, limit);
    return { events, next: events.at(-1)?.seq ?? from, latest };
  }

  /**
   * Resolves with the first event after the cursor that matches every filter, or with `timedOut`.
   * Without a cursor, a wait for exactly one of day or night answers at once while that phase holds
   * with the event that announced it: the body may have joined during that phase, so no transition is
   * coming. A wait naming both, neither, or no event types is answered only by events pushed after
   * the call. Other types may be listed alongside the phase.
   * Does not block programs or other requests; a wait abandoned through `signal` is dropped.
   */
  async wait(options: EventWaitOptions = {}): Promise<WaitResponse> {
    const filter = { types: options.types, from: options.from, match: options.match };
    const phases = (options.types ?? []).filter((type) => type === "day" || type === "night");
    if (
      options.since === undefined &&
      phases.length === 1 &&
      this.#phase !== undefined &&
      this.#phase.type === phases[0] &&
      eventMatches(this.#phase, filter)
    ) {
      return { event: this.#phase, next: this.#phase.seq, timedOut: false };
    }
    // A cursor ahead of the log means the body restarted; like `since()`, the wait starts over.
    const from = options.since === undefined ? this.#seq : options.since > this.#seq ? 0 : options.since;
    const found = this.#ring.find((e) => e.seq > from && eventMatches(e, filter));
    if (found) return { event: found, next: found.seq, timedOut: false };
    const { promise, resolve } = Promise.withResolvers<WaitResponse>();
    const waiter: Waiter = {
      since: this.#seq,
      filter,
      resolve,
      timer: setTimeout(() => {
        // Everything buffered by now was examined and did not match; the next wait can start past it.
        this.#settle(waiter, { event: null, next: this.#seq, timedOut: true });
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    this.#waiters.add(waiter);
    options.signal?.addEventListener(
      "abort",
      () => this.#settle(waiter, { event: null, next: this.#seq, timedOut: false }),
      { once: true },
    );
    return promise;
  }

  #settle(waiter: Waiter, result: WaitResponse): void {
    if (!this.#waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }
}
