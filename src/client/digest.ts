// The one line of high-signal news that begins every MCP tool response: what happened to the body
// since the previous response. An agent that never reads the event log still learns that it died (and
// of what, and where it woke up), that its reflex was switched off, that the bot host restarted, that
// it was kicked. Nothing else ever appears (hurt, block_broken, low_*, chat and the rest stay in
// get_events).
import type { BodyEvent, EventsResponse } from "../protocol/index.ts";

/** The events a digest reads: what `BodyClient.events` is. */
export interface EventSource {
  events(since: number, limit: number): Promise<EventsResponse>;
}

/**
 * An event as the body's log keeps it. `body` names the body daemon's start: a log that restarted
 * (the daemon restarted) carries another one, and its seq numbers begin again.
 */
type LoggedEvent = BodyEvent & { body?: string };

interface Place {
  x: number;
  y: number;
  z: number;
}

interface Death {
  cause: string | undefined;
  place: Place | undefined;
}

/** What one window of events adds up to, and the death that still awaits its respawn at the window's end. */
interface Summary {
  line: string | undefined;
  awaitingRespawn: Place | undefined;
}

const PAGE = 1000;
const MAX_TEXT = 240;
const HOST_RESTART = "bot host restarted: ";

/** One line of text: whitespace collapsed, bounded. */
function oneLine(value: unknown): string {
  const text = (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function placeOf(value: unknown): Place | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, z } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number" && Number.isFinite(x + y + z) ? { x, y, z } : undefined;
}

/** Whole blocks, truncated toward zero (`-286.5` -> `-286`, never `-0`). */
const whole = (value: number): number => Math.trunc(value) || 0;

const at = (place: Place | undefined): string => (place ? ` at ${whole(place.x)} ${whole(place.y)} ${whole(place.z)}` : "");

/** The server's death message without the player's name: "Fartmastery drowned" -> "drowned". */
function causeOf(value: unknown): string | undefined {
  const text = oneLine(value);
  if (!text) return undefined;
  const space = text.indexOf(" ");
  return space < 0 ? text : text.slice(space + 1);
}

function deathPart(deaths: Death[], respawn: { place: Place; from: Place | undefined } | undefined): string | undefined {
  const parts: string[] = [];
  const last = deaths.at(-1);
  if (last) {
    const counts = new Map<string, number>();
    for (const { cause } of deaths) counts.set(cause ?? "unknown", (counts.get(cause ?? "unknown") ?? 0) + 1);
    if (deaths.length === 1) {
      parts.push(`died once, last:${last.cause ? ` ${last.cause}` : ""}${at(last.place)}`);
    } else {
      const breakdown = counts.size > 1 ? ` (${[...counts].sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause} ${n}`).join(", ")})` : "";
      parts.push(`died ${deaths.length} times${breakdown}, last:${last.cause ? ` ${last.cause}` : ""}${at(last.place)}`);
    }
  }
  if (respawn) {
    // Horizontal blocks: a respawn's height tells nothing about how far the player walked.
    const distance = respawn.from ? Math.round(Math.hypot(respawn.place.x - respawn.from.x, respawn.place.z - respawn.from.z)) : undefined;
    const far = distance === undefined ? "" : ` (${distance} block${distance === 1 ? "" : "s"} away)`;
    parts.push(`respawned${at(respawn.place)}${far}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

/**
 * The digest line of one window of events in log order, or undefined when nothing in it is
 * high-signal. `awaitingRespawn` is where the last window's last death happened when its respawn had
 * not come yet: the first spawn here is that death's respawn.
 */
export function summarize(events: readonly BodyEvent[], awaitingRespawn?: Place): Summary {
  const deaths: Death[] = [];
  let respawn: { place: Place; from: Place | undefined } | undefined;
  let waiting = awaitingRespawn;
  const disabled: string[] = [];
  const restarts: string[] = [];
  const kicks: string[] = [];
  for (const { type, data } of events) {
    if (type === "death") {
      const place = placeOf(data.position);
      deaths.push({ cause: causeOf(data.cause), place });
      waiting = place ?? { x: NaN, y: NaN, z: NaN };
      respawn = undefined;
    } else if (type === "spawn" && waiting) {
      const place = placeOf(data.position);
      if (place) respawn = { place, from: placeOf(waiting) };
      waiting = undefined;
    } else if (type === "reflex_disabled") {
      const reason = oneLine(data.reason);
      disabled.push(`reflex ${oneLine(data.name)} disabled${reason ? `: ${reason}` : ""}`);
    } else if (type === "disconnected" && typeof data.reason === "string" && data.reason.startsWith(HOST_RESTART)) {
      const cause = oneLine(data.reason.slice(HOST_RESTART.length));
      restarts.push(cause ? `bot host restarted: ${cause}` : "bot host restarted");
    } else if (type === "kicked") {
      const reason = oneLine(data.reason);
      kicks.push(reason ? `kicked: ${reason}` : "kicked");
    }
  }
  const parts = [deathPart(deaths, respawn), ...disabled, ...restarts, ...kicks].filter((part): part is string => part !== undefined);
  return { line: parts.length ? `[since your last call] ${parts.join("; ")}` : undefined, awaitingRespawn: placeOf(waiting) };
}

/**
 * Follows one body's event log for one MCP process. `start` marks the log's end at first contact,
 * `take` returns the line for everything logged since the last `take` (or `start`). Neither throws: a
 * body that cannot be reached adds no line and keeps the cursor, so the next call reads the gap.
 */
export class Digest {
  readonly #connect: () => Promise<EventSource>;
  #cursor: number | undefined;
  #body: string | undefined;
  #awaitingRespawn: Place | undefined;

  constructor(connect: () => Promise<EventSource>) {
    this.#connect = connect;
  }

  /** Marks the log's end the first time the body answers; events before it never appear. Does nothing after that. */
  async start(): Promise<void> {
    if (this.#cursor !== undefined) return;
    try {
      await this.#read(await this.#connect(), 0, false);
    } catch {
      // Not in contact yet: the next call tries again.
    }
  }

  /** The line for the events since the previous `take`, or undefined when there are none worth a line. */
  async take(): Promise<string | undefined> {
    try {
      const client = await this.#connect();
      if (this.#cursor === undefined) {
        await this.#read(client, 0, false);
        return undefined;
      }
      const { line, awaitingRespawn } = summarize(await this.#read(client, this.#cursor, true), this.#awaitingRespawn);
      this.#awaitingRespawn = awaitingRespawn;
      return line;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the log from `from` to its end, a page at a time, and moves the cursor there; nothing moves
   * when a page fails. A cursor from before a body restart is answered from the fresh log's first
   * event: the body numbers a new log above every seq the previous one issued. A page whose events
   * name another `body` is dropped and read again from seq 0.
   */
  async #read(client: EventSource, from: number, keep: boolean): Promise<LoggedEvent[]> {
    let since = from;
    let body = this.#body;
    let events: LoggedEvent[] = [];
    for (;;) {
      const page = await client.events(since, PAGE);
      const first = (page.events[0] as LoggedEvent | undefined)?.body;
      if (first !== undefined && body !== undefined && first !== body && since > 0) {
        events = [];
        since = 0;
        body = first;
        this.#awaitingRespawn = undefined;
        continue;
      }
      if (first !== undefined) body = first;
      if (keep) events.push(...(page.events as LoggedEvent[]));
      since = page.next;
      if (page.events.length < PAGE) break;
    }
    this.#cursor = since;
    this.#body = body;
    return events;
  }
}
