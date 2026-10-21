// Which events a filter selects: the rule a wait on the supervisor's event log and a trigger in
// the bot host both match events by. Not re-exported from the protocol index.
import type { BodyEvent } from "./types.ts";

/** The filters of one wait: every given filter must match the same event. */
export interface EventFilter {
  types?: string[];
  from?: string;
  match?: RegExp;
}

/** Whether an event passes every given filter of a wait. */
export function eventMatches(event: BodyEvent, filter: EventFilter): boolean {
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  // `from` and `match` filter the content events carry; an event without that content cannot match.
  const sender = event.data.from;
  if (filter.from !== undefined && (typeof sender !== "string" || sender.toLowerCase() !== filter.from.toLowerCase())) return false;
  const message = event.data.message;
  return filter.match === undefined || (typeof message === "string" && filter.match.test(message));
}
