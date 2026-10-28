// The entity_appeared event: a notable creature — a registry animal, passive creature, or non-hostile
// mob — raises it once on coming within 32 blocks, and again only after it was beyond 48 blocks or gone.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { EventLog } from "../src/body/events.ts";
import { watchGame } from "../src/host/watch.ts";

/** A bot with the parts watchGame reads, and its own physics ticks to advance the watcher. */
function fakeBot() {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {} as Record<number, unknown> },
    entities: {} as Record<number, unknown>,
    health: 20,
    food: 20,
    _client: new EventEmitter(),
    registry: { effects: {}, items: {} },
  });
}

/** A creature as Mineflayer builds it: `type` is the registry type and `kind` the registry category. */
const creature = (id: number, name: string, type: string, kind: string, at: [number, number]) => ({
  id,
  name,
  type,
  kind,
  position: new Vec3(at[0], 64, at[1]),
});

/** Watches `bot` with an empty log, plus the looks (twice a second) and the event data they produced. */
function watch(bot: ReturnType<typeof fakeBot>) {
  const events = new EventLog();
  watchGame(bot as unknown as Bot, events);
  return {
    events,
    look: () => {
      for (let i = 0; i < 10; i++) bot.emit("physicsTick");
    },
    raised: () => events.since().events.filter((e) => e.type === "entity_appeared"),
  };
}

describe("entity_appeared", () => {
  it("fires once when an animal comes within 32 blocks, and again only after it was 48 blocks away", () => {
    const bot = fakeBot();
    const { look, raised } = watch(bot);
    const cow = creature(7, "cow", "animal", "Passive mobs", [40, 0]);
    bot.entities = { 7: cow };
    look();
    assert.deepEqual(raised().map((e) => e.data), [], "40 blocks away");
    cow.position = new Vec3(33, 64, 0);
    look();
    assert.deepEqual(raised().map((e) => e.data), [], "33 blocks away");
    cow.position = new Vec3(32, 64, 0);
    look();
    assert.deepEqual(raised().map((e) => e.data), [{ name: "cow", id: 7, distance: 32, position: { x: 32, y: 64, z: 0 } }], "32 blocks away");
    look();
    look();
    assert.equal(raised().length, 1, "standing close does not repeat");
    cow.position = new Vec3(40, 64, 0);
    look();
    cow.position = new Vec3(10, 64, 0);
    look();
    assert.equal(raised().length, 1, "40 blocks away is inside the 48-block re-arm");
    cow.position = new Vec3(49, 64, 0);
    look();
    cow.position = new Vec3(10, 64, 0);
    look();
    assert.deepEqual(
      raised()[1]?.data,
      { name: "cow", id: 7, distance: 10, position: { x: 10, y: 64, z: 0 } },
      "back within 32 after leaving",
    );
  });

  it("fires again for a creature that left the world and came back with the same id", () => {
    const bot = fakeBot();
    const { look, raised } = watch(bot);
    const cow = creature(7, "cow", "animal", "Passive mobs", [10, 0]);
    bot.entities = { 7: cow };
    look();
    assert.equal(raised().length, 1);
    delete bot.entities[7];
    look();
    bot.entities = { 7: creature(7, "cow", "animal", "Passive mobs", [5, 0]) };
    look();
    assert.deepEqual(raised().map((e) => e.data.distance), [10, 5]);
  });

  it("covers passive creatures and mobs that are not hostile: villagers, traders, golems, allays", () => {
    const bot = fakeBot();
    const { look, raised } = watch(bot);
    bot.entities = {
      11: creature(11, "villager", "passive", "Passive mobs", [31, 0]),
      12: creature(12, "wandering_trader", "passive", "Passive mobs", [20, 0]),
      13: creature(13, "iron_golem", "mob", "Passive mobs", [10, 0]),
      14: creature(14, "allay", "mob", "Passive mobs", [5, 0]),
    };
    look();
    assert.deepEqual(
      raised().map((e) => e.data.name),
      ["villager", "wandering_trader", "iron_golem", "allay"],
    );
  });

  it("leaves out hostile, ambient, water, player, and item entities", () => {
    const bot = fakeBot();
    const { look, events, raised } = watch(bot);
    bot.entities = {
      5: creature(5, "zombie", "hostile", "Hostile mobs", [5, 0]),
      6: creature(6, "slime", "mob", "Hostile mobs", [6, 0]),
      7: creature(7, "bat", "ambient", "Passive mobs", [7, 0]),
      8: creature(8, "cod", "water_creature", "Passive mobs", [8, 0]),
      9: creature(9, "squid", "passive", "Passive mobs", [9, 0]),
      10: creature(10, "ana", "player", "UNKNOWN", [3, 0]),
      11: creature(11, "item", "other", "UNKNOWN", [2, 0]),
    };
    look();
    assert.deepEqual(raised().map((e) => e.data), [], "none of them is a notable creature");
    assert.deepEqual(
      events.since().events.map((e) => e.type),
      ["hostile_near", "hostile_near"],
      "the hostile ones still raise hostile_near",
    );
  });
});
