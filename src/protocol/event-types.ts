// The catalog of every event type the body pushes, with what each one means. The tool descriptions
// that list event types are generated from it, and a test fails when a push in src/ names a type the
// table lacks or the table names a type nothing pushes, so the documentation cannot drift.
//
// A push site names its type as a string literal: the supervisor's relay of a host event is the one
// non-literal `.push(type, data)`, and the host's own pushes are literal.

import { isReflexEvent } from "./event-filter.ts";

/** Every event type the body can push, by type: one line saying what it means and what its data holds. */
export const EVENT_TYPES: Readonly<Record<string, string>> = {
  binding_error: "a stored action binding could not be applied when the body started, and why",
  block_broken: "the player broke a block: { block, position }",
  block_placed: "the player placed a block: { block, position }",
  chat: "a public chat message from another player: { from, message }",
  connected: "the player joined the server: { username, host, port }",
  day: "it is day (time of day below 12542); the first time packet after a join announces the phase the body joined in",
  entity_appeared:
    "a creature hostile_near does not cover came within 32 blocks (animals, villagers, wandering traders, golems, allays; not bats, fish or squid), once until it is beyond 48 blocks or gone: { name, id, distance, position }",
  death: "the player died: { cause, position, drops } as the server's death message and the inventory at that moment show it",
  disconnected: "the player lost the connection: { reason }",
  error: "the Minecraft client raised an error: { message }",
  hostile_near: "a hostile creature came within 16 blocks, once per creature: { name, id, distance }",
  hurt: "the player's health dropped: { health, food }",
  item_crafted: "the player crafted an item: { item, count }",
  item_picked_up: "the player picked items up: { item, count }",
  kicked: "the server kicked the player: { reason }",
  low_food: "food fell below 6: { food }, once until it is back at 6",
  low_health: "health fell below 8: { health }, once until it is back at 8",
  low_oxygen: "air fell below 10: { oxygen }, once until it is back at 10",
  night: "it is night (time of day at or after 12542); the first time packet after a join announces the phase the body joined in",
  player_joined: "another player joined the server: { username }",
  player_left: "another player left the server: { username }",
  program_finished: "a run or a call ended: { status, durationMs, run, call?, error?, result? }; `run` is the seq get_run takes",
  reconnect_scheduled: "the body will reconnect after a delay: { inMs, attempt }",
  reflex_disabled: "a reflex is off after repeated failures: { name, failures, reason }",
  reflex_error: "a stored reflex could not be loaded and was skipped: { name, error }",
  reflex_fired: "a reflex started for an event: { name, event: { seq, type } }",
  reflex_finished: "a reflex firing ended: { name, status, durationMs, error?, logs? }",
  spawn: "the player spawned or respawned: { position }",
  spawn_reset: "the server reset the spawn point to the world spawn: {}",
  system: "a system or game_info message from the server: { message }",
  whisper: "a private message from another player: { from, message }",
};

/**
 * The types a body can push, given whether it offers reflexes: the reflex events exist only there.
 * Every other type is pushed on every body; a new feature-gated type belongs in this filter too.
 */
export function eventTypesFor(reflexes: boolean): string[] {
  return Object.keys(EVENT_TYPES).filter((type) => reflexes || !isReflexEvent(type));
}

