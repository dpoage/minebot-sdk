import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { EventLog } from "../src/body/events.ts";
import { brief } from "../src/body/observation.ts";
import { watchGame } from "../src/body/watch.ts";
import { explorer, type Place } from "../src/kit/kits/explorer.ts";
import type { KitContext } from "../src/kit/kit.ts";
import { activeEffects, trackEffects } from "../src/mc/effects.ts";
import type { Observation } from "../src/protocol/index.ts";
import { JsonStore } from "../src/store.ts";

type Connected = Extract<Observation, { connected: true }>;

const observed: Connected = {
  connected: true,
  username: "ana",
  gameMode: "survival",
  dimension: "minecraft:overworld",
  position: { x: 1.5, y: 64, z: 3.5 },
  yaw: 0,
  pitch: 0,
  onGround: true,
  health: 20,
  food: 20,
  saturation: 5,
  oxygen: 20,
  experienceLevel: 0,
  timeOfDay: 1000,
  isDay: true,
  isRaining: false,
  heldItem: null,
  armor: { head: null, chest: null, legs: null, feet: null },
  offhand: null,
  effects: [],
  biome: "plains",
  standingOn: "grass_block",
  lookingAt: null,
  inventory: [],
  nearbyEntities: [],
  program: { running: false },
  sky: { open: true, solidAbove: 0, waterAbove: 0 },
  programsWithoutChange: 0,
};

describe("brief", () => {
  it("names the biome and leaves out armor, offhand, and effects while there are none", () => {
    const line = brief(observed);
    assert.match(line, /at 1 64 3 \(plains\)/);
    assert.doesNotMatch(line, /armor|offhand|effects/);
  });

  it("lists worn armor, the offhand item, and effects with their level and time left", () => {
    const line = brief({
      ...observed,
      armor: { head: null, chest: { name: "iron_chestplate", count: 1, slot: 6 }, legs: null, feet: { name: "iron_boots", count: 1, slot: 8 } },
      offhand: { name: "shield", count: 1, slot: 45 },
      effects: [
        { name: "speed", amplifier: 1, remaining: 28 },
        { name: "night_vision", amplifier: 0 },
      ],
    });
    assert.match(line, /holding nothing, offhand shield/);
    assert.match(line, /armor: iron_chestplate, iron_boots/);
    assert.match(line, /effects: speed 2 \(28s\), night_vision/);
  });
});

/** A bot with the parts watchGame and the effect tracker read. */
function fakeBot() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {} as Record<number, { id: number; amplifier: number; duration: number }> },
    entities: {} as Record<number, unknown>,
    health: 20,
    food: 20,
    _client: new EventEmitter(),
    registry: { effects: { 17: { name: "Hunger" }, 11: { name: "MiningFatigue" } }, items: {} },
  });
  return bot;
}

describe("activeEffects", () => {
  it("counts the remaining seconds down from when the effect arrived and names effects like commands do", () => {
    const bot = fakeBot();
    trackEffects(bot as unknown as Bot);
    const hunger = { id: 17, amplifier: 255, duration: 600 };
    const endless = { id: 11, amplifier: 0, duration: -1 };
    bot.entity.effects = { 17: hunger, 11: endless };
    bot.emit("entityEffect", bot.entity, hunger);
    bot.emit("entityEffect", bot.entity, endless);
    const now = Date.now();
    assert.deepEqual(activeEffects(bot as unknown as Bot, now), [
      { name: "mining_fatigue", amplifier: 0 },
      { name: "hunger", amplifier: 255, remaining: 30 },
    ]);
    assert.equal(activeEffects(bot as unknown as Bot, now + 12_000)[1]?.remaining, 18);
    assert.equal(activeEffects(bot as unknown as Bot, now + 99_000)[1]?.remaining, 0);
  });
});

describe("watchGame", () => {
  const types = (events: EventLog) => events.since().events.map((e) => e.type);

  it("raises low_health and low_food once when the value falls below the threshold, and again after recovery", () => {
    const bot = fakeBot();
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    const set = (health: number, food: number) => {
      bot.health = health;
      bot.food = food;
      bot.emit("health");
    };
    set(8, 6);
    assert.deepEqual(types(events), []);
    set(7, 5);
    set(6, 4);
    set(3, 4);
    assert.deepEqual(events.since().events.map((e) => [e.type, e.data]), [
      ["low_health", { health: 7 }],
      ["low_food", { food: 5 }],
    ]);
    set(20, 20);
    set(2, 1);
    assert.deepEqual(types(events), ["low_health", "low_food", "low_health", "low_food"]);
  });

  it("raises block_placed for the player's own placements", () => {
    const bot = fakeBot();
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    bot.emit("blockPlaced", { name: "air" }, { name: "stone", position: new Vec3(1, 2, 3) });
    assert.deepEqual(events.since().events.map((e) => [e.type, e.data]), [["block_placed", { block: "stone", position: { x: 1, y: 2, z: 3 } }]]);
  });

  it("raises item_picked_up only when the player collects a dropped item", () => {
    const bot = fakeBot();
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    bot.entities[7] = { getDroppedItem: () => ({ name: "oak_log" }) };
    bot.entities[8] = { getDroppedItem: () => null };
    bot._client.emit("collect", { collectorEntityId: 99, collectedEntityId: 7, pickupItemCount: 1 });
    bot._client.emit("collect", { collectorEntityId: 1, collectedEntityId: 8, pickupItemCount: 3 });
    bot._client.emit("collect", { collectorEntityId: 1, collectedEntityId: 7, pickupItemCount: 2 });
    assert.deepEqual(events.since().events.map((e) => [e.type, e.data]), [["item_picked_up", { item: "oak_log", count: 2 }]]);
  });

  it("raises hostile_near once per creature within 16 blocks, and again after it left and came back", () => {
    const bot = fakeBot();
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    const zombie = { id: 5, name: "zombie", kind: "Hostile mobs", position: new Vec3(30, 64, 0) };
    const enderman = { id: 6, name: "enderman", kind: "Hostile mobs", position: new Vec3(3, 64, 0) };
    const cow = { id: 7, name: "cow", kind: "Passive mobs", position: new Vec3(2, 64, 0) };
    bot.entities = { 5: zombie, 6: enderman, 7: cow };
    const look = () => {
      for (let i = 0; i < 10; i++) bot.emit("physicsTick");
    };
    look();
    assert.deepEqual(types(events), []);
    zombie.position = new Vec3(12, 64, 0);
    look();
    look();
    assert.deepEqual(events.since().events.map((e) => [e.type, e.data]), [["hostile_near", { name: "zombie", id: 5, distance: 12 }]]);
    // Hovering between the two radii is not a new approach.
    zombie.position = new Vec3(20, 64, 0);
    look();
    zombie.position = new Vec3(10, 64, 0);
    look();
    assert.equal(types(events).length, 1);
    zombie.position = new Vec3(40, 64, 0);
    look();
    zombie.position = new Vec3(10, 64, 0);
    look();
    assert.equal(types(events).length, 2);
  });
});

describe("explorer places", () => {
  const scratch = () => new JsonStore(path.join(mkdtempSync(path.join(tmpdir(), "minebot-places-")), "explorer.json"));
  const at = new Vec3(100, 64, 0);
  type ExplorerContext = Parameters<typeof explorer.actions.scan.invoke>[0];
  const contextOf = (store: JsonStore, dimension = "minecraft:overworld") =>
    ({ store, bot: { entity: { position: at }, game: { dimension } } }) as unknown as ExplorerContext;
  const call = (ctx: ExplorerContext, name: keyof typeof explorer.actions, args: unknown = {}) => explorer.actions[name].invoke(ctx, args, `explorer.${name}`);

  it("converts stored waypoints into places once, and keeps waypoints and travel working on them", () => {
    const store = scratch();
    store.set("waypoints", { home: { x: 5, y: 70, z: 6, dimension: "minecraft:overworld" } });
    const ctx = contextOf(store);
    assert.deepEqual(call(ctx, "waypoints"), { home: { x: 5, y: 70, z: 6, dimension: "minecraft:overworld" } });
    assert.equal(store.get("waypoints"), undefined);
    const [home] = call(ctx, "places") as Place[];
    assert.deepEqual({ ...home, updatedAt: "" }, {
      name: "home",
      kind: "other",
      tags: [],
      note: "",
      position: { x: 5, y: 70, z: 6 },
      dimension: "minecraft:overworld",
      updatedAt: "",
      distance: 95,
    });
  });

  it("remembers typed places across a reload, merges a repeated name, and lists them nearest first", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "minebot-places-")), "explorer.json");
    const ctx = contextOf(new JsonStore(file));
    call(ctx, "remember", { name: "far chest", at: [400, 64, 0], kind: "chest", tags: ["food"], contents: { bread: 5 } });
    call(ctx, "remember", { name: "near chest", at: [110, 64, 0], kind: "chest", note: "tools" });
    call(ctx, "remember", { name: "bed", at: [90, 64, 0], kind: "bed" });
    call(ctx, "remember", { name: "far chest", at: [400, 64, 0], note: "more bread" });
    const reloaded = contextOf(new JsonStore(file));
    const chests = call(reloaded, "places", { kind: "chest" }) as (Place & { distance?: number })[];
    assert.deepEqual(chests.map((p) => [p.name, p.distance]), [["near chest", 10], ["far chest", 300]]);
    assert.deepEqual(chests[1]?.tags, ["food"]);
    assert.deepEqual(chests[1]?.contents, { bread: 5 });
    assert.equal(chests[1]?.note, "more bread");
    assert.deepEqual(call(reloaded, "places", { kind: "chest", radius: 50 }), [chests[0]]);
    assert.deepEqual(call(reloaded, "places", { near: [400, 64, 0], limit: 1 }), [{ ...chests[1], distance: 0 }]);
  });

  it("lists places of another dimension last, without a distance, and never within a radius", () => {
    const store = scratch();
    call(contextOf(store, "minecraft:the_nether"), "remember", { name: "portal", kind: "portal" });
    call(contextOf(store), "remember", { name: "base", kind: "base" });
    const ctx = contextOf(store);
    const all = call(ctx, "places") as (Place & { distance?: number })[];
    assert.deepEqual(all.map((p) => [p.name, p.distance]), [["base", 0], ["portal", undefined]]);
    assert.deepEqual((call(ctx, "places", { radius: 1000 }) as Place[]).map((p) => p.name), ["base"]);
  });
});
