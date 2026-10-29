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
 * restart would hide its first events. The seed is the wall clock's next second times 1000, so that
 * holds unless the clock steps back or a log sustains 1000 events a second; seqs then count up by one.
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
   * At most `limit` buffered events, oldest first: the newest `limit` without `since`, else the
   * oldest `limit` after it. `next` is the newest seq returned, `latest` the log's newest; a cursor
   * ahead of the log starts from the beginning.
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
   * The first event after the cursor that matches every filter, else `timedOut`. Without a cursor,
   * a wait whose `types` are exactly one phase (day or night) answers at once while that phase
   * holds: the body may have joined during it, so no transition is coming. Any other list sees only
   * events pushed after the call. A wait abandoned through `signal` is dropped.
   */
  async wait(options: EventWaitOptions = {}): Promise<WaitResponse> {
    const filter = { types: options.types, from: options.from, match: options.match };
    const named = options.types ?? [];
    const phases = named.filter((type) => type === "day" || type === "night");
    const onePhaseOnly = named.length > 0 && phases.length === named.length && phases.every((type) => type === phases[0]);
    if (
      options.since === undefined &&
      onePhaseOnly &&
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
