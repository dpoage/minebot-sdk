// Dropped items are entities named "item": the observation, the brief line, and items.drops all carry the
// stack's item name and count, while an items.drops entry still reads as a point {x,y,z} (P2.1, C2).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createHarness } from "minebot-sdk/testing";
import { brief, observation } from "../src/host/observation.ts";
import { droppedStack } from "../src/mc/drops.ts";
import { drops } from "../src/routines/items.ts";
import { universe } from "../src/testing/universe.ts";

/** A player with everything the observation reads; the registry tables stand in for the game's. */
function fakeBot(entities: Record<number, unknown> = {}) {
  return {
    username: "ana",
    entity: { id: 1, position: new Vec3(5.5, 64, 7.5), effects: {} as Record<number, unknown>, onGround: true, height: 1.8 },
    game: { gameMode: "survival", dimension: "minecraft:overworld", minY: 0, height: 64 },
    yaw: 0,
    pitch: 0,
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    experience: { level: 0 },
    time: { timeOfDay: 1000, isDay: true },
    heldItem: null,
    isRaining: false,
    entities,
    inventory: { slots: {}, items: () => [] },
    world: { getBiome: () => 0 },
    registry: { biomes: {}, effects: {}, language: {} },
    getEquipmentDestSlot: () => 0,
    blockAt: () => ({ name: "air", boundingBox: "empty", light: 15, skyLight: 15 }),
    blockAtCursor: () => null,
  };
}

/** A dropped stack at `at`: the entity Mineflayer spawns, with the stack its metadata holds. */
const stack = (id: number, item: string, count: number, at: [number, number, number]) => ({
  id,
  name: "item",
  type: "other",
  position: new Vec3(...at),
  getDroppedItem: () => ({ name: item, count }),
});

/**
 * A real Prismarine entity, as Mineflayer builds it on the spawn packet: named "item", with empty metadata
 * until the later `entity_metadata` packet. `fill` sends that packet's stack into slot 8 (`metadataIxOfItem`).
 */
function spawnedDrop(id = 9) {
  const { registry, Entity: EntityClass } = universe();
  const entity = new EntityClass(id);
  Object.assign(entity, { name: "item", type: "other", kind: "UNKNOWN" });
  entity.position = new Vec3(3.5, 64.25, 0.5);
  return {
    entity,
    fill: () => {
      const oakLog = registry.itemsByName.oak_log;
      if (!oakLog) throw new Error("the 26.1 registry has no oak_log");
      entity.metadata[8] = { present: true, itemId: oakLog.id, itemCount: 3 };
    },
  };
}

/** The player at (5.5, 64, 7.5): the origin of every distance in these tests. */
const connected = (bot: unknown) => {
  const value = observation(bot as Bot, { programsWithoutChange: 0, program: { running: false } });
  if (!value.connected) throw new Error("expected a connected observation");
  return value;
};

describe("dropped items in the observation", () => {
  it("lists an item entity with the stack it holds", () => {
    const bot = fakeBot({ 9: stack(9, "oak_log", 3, [3.5, 64, 7.5]) });
    assert.deepEqual(
      connected(bot).nearbyEntities.map((e) => [e.type, e.name, e.item]),
      [["other", "item", { name: "oak_log", count: 3 }]],
    );
  });

  it("names dropped stacks in the brief line, grouping them by item and counting every stack", () => {
    const bot = fakeBot({
      9: stack(9, "oak_log", 3, [3.5, 64, 7.5]),
      10: stack(10, "oak_log", 2, [5.5, 64, 9.5]),
      11: { id: 11, name: "cow", type: "animal", position: new Vec3(7.5, 64, 7.5) },
    });
    assert.match(brief(connected(bot)), /cow 2m, oak_log x5 2m/);
  });

  it("never throws for a drop whose metadata has not arrived, and names it once it does", () => {
    const { entity, fill } = spawnedDrop();
    entity.position = new Vec3(3.5, 64, 7.5);
    const bot = fakeBot({ 9: entity });
    assert.equal(droppedStack(entity), null, "empty metadata reads as no stack");
    const before = connected(bot);
    assert.deepEqual(before.nearbyEntities.map((e) => [e.name, e.item]), [["item", undefined]], "listed, without a stack");
    assert.doesNotMatch(brief(before), /oak_log/, "the brief leaves the stack out until it is readable");
    fill();
    const after = connected(bot);
    assert.deepEqual(after.nearbyEntities.map((e) => e.item), [{ name: "oak_log", count: 3 }]);
    assert.match(brief(after), /oak_log x3 2m/);
  });
});

describe("items.drops", () => {
  it("names and counts every dropped stack, nearest first", async () => {
    const h = createHarness({
      entities: [
        { name: "item", item: "oak_log", count: 2, at: [3.5, 64.25, 0.5] },
        { name: "item", item: "oak_log", count: 1, at: [1.5, 64.25, 0.5] },
        { name: "cow", at: [2, 64, 2] },
      ],
    });
    assert.deepEqual(await h.run(drops, { radius: 8 }), [
      { x: 1, y: 64, z: 0, name: "oak_log", count: 1 },
      { x: 3, y: 64, z: 0, name: "oak_log", count: 2 },
    ]);
  });

  it("keeps an entry usable as a point", async () => {
    const h = createHarness({ entities: [{ name: "item", item: "oak_log", at: [3.5, 64.25, 0.5] }] });
    const [drop] = await h.run(drops, {});
    assert.deepEqual({ x: drop?.x, y: drop?.y, z: drop?.z }, { x: 3, y: 64, z: 0 });
  });

  it("leaves a drop out until its metadata arrives, and reports it with name and count once it does", async () => {
    const h = createHarness();
    const { entity, fill } = spawnedDrop();
    h.bot.entities[9] = entity;
    assert.deepEqual(await h.run(drops, {}), [], "nothing to report while the stack is unreadable");
    fill();
    assert.deepEqual(await h.run(drops, {}), [{ x: 3, y: 64, z: 0, name: "oak_log", count: 3 }]);
  });
});
