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

/** Bounded, sequence-numbered log of things that happened to a body. */
export class EventLog implements EventSink {
  readonly #capacity: number;
  #events: BodyEvent[] = [];
  #waiters = new Set<Waiter>();
  #listeners = new Set<(event: BodyEvent) => void>();
  #seq = 0;

  constructor(capacity = 1000) {
    this.#capacity = capacity;
  }

  push(type: string, data: Record<string, unknown> = {}): void {
    const event = { seq: ++this.#seq, time: Date.now(), type, data };
    this.#events.push(event);
    if (this.#events.length > this.#capacity) this.#events.splice(0, this.#events.length - this.#capacity);
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
   * Returns events with seq > since, oldest first, at most `limit` of them.
   * A cursor ahead of the log (the body restarted) restarts from the beginning.
   */
  since(since = 0, limit = 200): EventsResponse {
    const from = since > this.#seq ? 0 : since;
    const events = this.#events.filter((e) => e.seq > from).slice(0, limit);
    return { events, next: events.at(-1)?.seq ?? from };
  }

  /**
   * Resolves with the first event after the cursor that matches every filter, or with `timedOut`.
   * Does not block programs or other requests; a wait abandoned through `signal` is dropped.
   */
  async wait(options: EventWaitOptions = {}): Promise<WaitResponse> {
    const filter = { types: options.types, from: options.from, match: options.match };
    // A cursor ahead of the log means the body restarted; like `since()`, the wait starts over.
    const from = options.since === undefined ? this.#seq : options.since > this.#seq ? 0 : options.since;
    const found = this.#events.find((e) => e.seq > from && eventMatches(e, filter));
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
