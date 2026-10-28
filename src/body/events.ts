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
 * restart would hide the new log's first events. A seq is therefore the wall clock in milliseconds
 * times this factor: room for a thousand events inside one millisecond, and a number that stays
 * exact (below 2^53) for centuries. Cursors stay one non-negative integer and nothing is persisted.
 */
const SEQS_PER_MS = 1000;
/** The highest seq any log in this process issued; two logs in one process never overlap either. */
let issued = 0;

/** The next seq of a log whose previous one was `previous`: always later than any seq issued before. */
function nextSeq(previous: number): number {
  const seq = Math.max(previous + 1, Date.now() * SEQS_PER_MS, issued + 1);
  issued = seq;
  return seq;
}

/** Bounded, sequence-numbered log of things that happened to a body. */
export class EventLog implements EventSink {
  readonly #capacity: number;
  #ring: BodyEvent[] = [];
  #waiters = new Set<Waiter>();
  #listeners = new Set<(event: BodyEvent) => void>();
  /** The last day or night event logged: the phase that holds now, which a wait for it must answer from at once. */
  #phase: BodyEvent | undefined;
  #seq = 0;

  constructor(capacity = 1000) {
    this.#capacity = capacity;
  }

  push(type: string, data: Record<string, unknown> = {}): void {
    const event = { seq: nextSeq(this.#seq), time: Date.now(), type, data };
    this.#seq = event.seq;
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
   * Without a cursor, a day or night wait whose phase already holds answers at once with the event
   * that announced it: the body may have joined during that phase, so no transition is coming.
   * Does not block programs or other requests; a wait abandoned through `signal` is dropped.
   */
  async wait(options: EventWaitOptions = {}): Promise<WaitResponse> {
    const filter = { types: options.types, from: options.from, match: options.match };
    if (options.since === undefined && this.#phase !== undefined && eventMatches(this.#phase, filter)) {
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
