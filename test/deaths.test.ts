// The death tracker: the server's death message and the inventory it arrived with, the most recent
// death of the host session, and the spawn point the server confirmed, as the observation reports them.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { brief, observation } from "../src/host/observation.ts";
import { recordDeath, sensesOf, trackDeaths } from "../src/mc/deaths.ts";
import type { Observation } from "../src/protocol/index.ts";

interface Item {
  name: string;
  count: number;
  slot: number;
}

type FakeBot = EventEmitter & {
  username: string;
  entity: { id: number; position: Vec3; effects: Record<string, unknown>; onGround: boolean };
  game: { gameMode: string; dimension: string; minY: number; height: number };
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  foodSaturation: number;
  oxygenLevel: number;
  experience: { level: number };
  time: { timeOfDay: number; isDay: boolean };
  heldItem: { name: string; count: number } | null;
  isRaining: boolean;
  entities: Record<number, unknown>;
  inventory: { slots: Record<number, unknown>; items: () => Item[] };
  world: { getBiome: () => number };
  registry: { biomes: Record<number, { name: string }>; effects: Record<number, unknown>; language: Record<string, string> };
  getEquipmentDestSlot: (destination: string) => number;
  blockAt: (position: Vec3) => { name: string; boundingBox: string; light: number; skyLight: number };
  blockAtCursor: (range: number) => null;
  _client: EventEmitter;
  /** Defined by Mineflayer's plugins after createBot returns, as the bed and block-action plugins are. */
  sleep?: (bedBlock: { position: Vec3 }) => Promise<void>;
  activateBlock?: (block: { name: string; position: Vec3 }) => Promise<void>;
};

/** A player with everything the tracker and the observation read; the language table stands in for the game's. */
function fakeBot(): FakeBot {
  const bot = Object.assign(new EventEmitter(), {
    username: "Fartmastery",
    entity: { id: 1, position: new Vec3(5.5, 64, 7.5), effects: {}, onGround: true },
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
    entities: {},
    inventory: { slots: {}, items: () => [] },
    world: { getBiome: () => 0 },
    registry: {
      biomes: {},
      effects: {},
      language: { "death.attack.drown": "%1$s drowned", "death.attack.generic": "%1$s died", "block.minecraft.set_spawn": "Respawn point set" },
    },
    getEquipmentDestSlot: (_destination: string) => 0,
    blockAt: (_position: Vec3) => ({ name: "air", boundingBox: "empty", light: 15, skyLight: 15 }),
    blockAtCursor: (_range: number) => null,
    _client: new EventEmitter(),
  });
  return bot as unknown as FakeBot;
}

/** A 26.1 `death_combat_event.message`: an anonymous NBT string tag holding the component as JSON. */
function nbtString(component: object): { type: string; value: string } {
  return { type: "string", value: JSON.stringify(component) };
}

/** The compound form of the same field: a compound of tags, as a component with fields. */
function nbtCompound(translate: string, withName: string): { type: string; value: Record<string, unknown> } {
  return {
    type: "compound",
    value: {
      translate: { type: "string", value: translate },
      with: { type: "list", value: { type: "compound", value: [{ text: { type: "string", value: withName } }] } },
    },
  };
}

const observed = (bot: FakeBot): Extract<Observation, { connected: true }> => {
  const value = observation(bot as unknown as Bot, { programsWithoutChange: 0, program: { running: false } });
  if (!value.connected) throw new Error("expected a connected observation");
  return value;
};

describe("death_combat_event", () => {
  it("gives the death event the server's message and the inventory that arrived with it", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    bot.inventory.items = () => [
      { name: "diamond_sword", count: 1, slot: 0 },
      { name: "bread", count: 3, slot: 1 },
    ];
    bot._client.emit("death_combat_event", {
      playerId: 1,
      message: nbtString({ translate: "death.attack.drown", with: [{ text: "Fartmastery" }] }),
    });
    bot.entity.position = new Vec3(10, 65, 20);

    const data = recordDeath(bot as unknown as Bot);
    assert.deepEqual(data, {
      position: { x: 10, y: 65, z: 20 },
      cause: "Fartmastery drowned",
      dropped: [
        { name: "diamond_sword", count: 1 },
        { name: "bread", count: 3 },
      ],
    });
    const senses = sensesOf(bot as unknown as Bot);
    assert.deepEqual({ ...senses.lastDeath, time: "now" }, {
      time: "now",
      position: { x: 10, y: 65, z: 20 },
      cause: "Fartmastery drowned",
    });
    assert.match(senses.lastDeath?.time ?? "", /^\d{4}-\d\d-\d\dT/);
  });

  it("reads the compound form of the message too", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    bot._client.emit("death_combat_event", { playerId: 1, message: nbtCompound("death.attack.drown", "Fartmastery") });
    assert.equal(recordDeath(bot as unknown as Bot).cause, "Fartmastery drowned");
  });

  it("ignores another player's death message, and never repeats one for a later death", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    bot._client.emit("death_combat_event", { playerId: 2, message: nbtString({ translate: "death.attack.drown", with: [{ text: "Alice" }] }) });
    assert.deepEqual(recordDeath(bot as unknown as Bot), { position: { x: 5.5, y: 64, z: 7.5 } });
    assert.equal(sensesOf(bot as unknown as Bot).lastDeath?.cause, undefined);

    bot._client.emit("death_combat_event", { playerId: 1, message: nbtString({ translate: "death.attack.drown", with: [{ text: "Fartmastery" }] }) });
    assert.equal(recordDeath(bot as unknown as Bot).cause, "Fartmastery drowned");
    assert.equal(recordDeath(bot as unknown as Bot).cause, undefined);
  });

  it("gives no cause when the server sent no message", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    assert.deepEqual(recordDeath(bot as unknown as Bot), { position: { x: 5.5, y: 64, z: 7.5 } });
  });
});

/** What a plugin's `bot.sleep` and `bot.activateBlock` were called with. */
interface UseCalls {
  beds: { x: number; y: number; z: number }[];
  activated: string[];
}

/**
 * Installs the use methods when the bot logs in, as Mineflayer's plugins do after createBot returns:
 * `bot.sleep` and `bot.activateBlock` do not exist yet when trackDeaths runs. `failed` makes a call
 * throw, as a refused sleep or a refused click does.
 */
function pluginUse(bot: FakeBot, failed: { sleep?: boolean; activate?: boolean } = {}): UseCalls {
  const calls: UseCalls = { beds: [], activated: [] };
  bot.once("login", () => {
    bot.sleep = async (bedBlock) => {
      calls.beds.push({ x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z });
      if (failed.sleep) throw new Error("there's only half bed");
    };
    bot.activateBlock = async (block) => {
      calls.activated.push(block.name);
      if (failed.activate) throw new Error("the block refused the click");
    };
  });
  return calls;
}

/** A tracked bot whose plugins have loaded, as Connection has it a tick after createBot. */
function tracked(failed: { sleep?: boolean; activate?: boolean } = {}): { bot: FakeBot; calls: UseCalls } {
  const bot = fakeBot();
  const calls = pluginUse(bot, failed);
  trackDeaths(bot as unknown as Bot);
  bot.emit("login");
  return { bot, calls };
}

describe("spawn point", () => {
  const confirm = (bot: FakeBot) => bot.emit("message", { json: { translate: "block.minecraft.set_spawn" } }, "system");

  it("wraps the plugin's sleep, which exists only after login, and reports the bed the sleep succeeded in", async () => {
    const bot = fakeBot();
    const calls = pluginUse(bot);
    trackDeaths(bot as unknown as Bot);
    assert.equal(bot.sleep, undefined);
    bot.emit("login");
    await bot.sleep!({ position: new Vec3(3, 64, 4) });
    assert.deepEqual(calls.beds, [{ x: 3, y: 64, z: 4 }]);
    assert.equal(sensesOf(bot as unknown as Bot).spawnPoint, undefined);
    confirm(bot);
    assert.deepEqual(sensesOf(bot as unknown as Bot).spawnPoint, { x: 3, y: 64, z: 4 });
    assert.match(brief(observed(bot)), /respawn: bed at 3 64 4/);
  });

  it("holds the server's confirmation, which arrives before the sleep resolves, until the sleep succeeds", async () => {
    const bot = fakeBot();
    bot.once("login", () => {
      // The server answers while Mineflayer is still waiting for the sleep event.
      bot.sleep = async () => {
        confirm(bot);
      };
    });
    trackDeaths(bot as unknown as Bot);
    bot.emit("login");
    await bot.sleep!({ position: new Vec3(3, 64, 4) });
    assert.deepEqual(sensesOf(bot as unknown as Bot).spawnPoint, { x: 3, y: 64, z: 4 });
  });

  it("does not remember a use that failed, even when the server confirmed it meanwhile", async () => {
    const bot = fakeBot();
    bot.once("login", () => {
      bot.sleep = async () => {
        confirm(bot);
        throw new Error("there's only half bed");
      };
    });
    trackDeaths(bot as unknown as Bot);
    bot.emit("login");
    await assert.rejects(bot.sleep!({ position: new Vec3(3, 64, 4) }));
    assert.equal("spawnPoint" in sensesOf(bot as unknown as Bot), false);
  });

  it("does not remember a bed whose sleep failed", async () => {
    const { bot } = tracked({ sleep: true });
    await assert.rejects(bot.sleep!({ position: new Vec3(3, 64, 4) }));
    confirm(bot);
    assert.equal("spawnPoint" in sensesOf(bot as unknown as Bot), false);
  });

  it("is the respawn anchor the bot activated, and not another block", async () => {
    const { bot } = tracked();
    await bot.activateBlock!({ name: "chest", position: new Vec3(1, 64, 1) });
    await bot.activateBlock!({ name: "respawn_anchor", position: new Vec3(-5, 70, 8) });
    confirm(bot);
    assert.deepEqual(sensesOf(bot as unknown as Bot).spawnPoint, { x: -5, y: 70, z: 8 });
  });

  it("does not remember an anchor that glowstone charged, and does not remember a click that failed", async () => {
    const charged = tracked();
    charged.bot.heldItem = { name: "glowstone", count: 1 };
    await charged.bot.activateBlock!({ name: "respawn_anchor", position: new Vec3(-5, 70, 8) });
    confirm(charged.bot);
    assert.equal("spawnPoint" in sensesOf(charged.bot as unknown as Bot), false);

    const refused = tracked({ activate: true });
    await assert.rejects(refused.bot.activateBlock!({ name: "respawn_anchor", position: new Vec3(-5, 70, 8) }));
    confirm(refused.bot);
    assert.equal("spawnPoint" in sensesOf(refused.bot as unknown as Bot), false);
  });

  it("stays unknown for a confirmation the bot cannot place", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    bot.emit("login");
    confirm(bot);
    assert.equal("spawnPoint" in sensesOf(bot as unknown as Bot), false);
  });

  it("is the world spawn after the server reset it", async () => {
    const { bot } = tracked();
    await bot.sleep!({ position: new Vec3(3, 64, 4) });
    confirm(bot);
    bot.emit("spawnReset");
    assert.equal(sensesOf(bot as unknown as Bot).spawnPoint, null);
  });

  it("survives a reconnection, which carries the senses into the new bot's tracker", () => {
    const first = fakeBot();
    trackDeaths(first as unknown as Bot);
    first._client.emit("death_combat_event", { playerId: 1, message: nbtString({ translate: "death.attack.generic", with: [{ text: "Fartmastery" }] }) });
    recordDeath(first as unknown as Bot);
    first.emit("spawnReset");

    const second = fakeBot();
    trackDeaths(second as unknown as Bot, sensesOf(first as unknown as Bot));
    assert.equal(sensesOf(second as unknown as Bot).lastDeath?.cause, "Fartmastery died");
    assert.equal(sensesOf(second as unknown as Bot).spawnPoint, null);
  });
});

describe("observation of the senses", () => {
  it("reports the last death and the spawn point, and the brief names both", async () => {
    const { bot } = tracked();
    bot._client.emit("death_combat_event", { playerId: 1, message: nbtString({ translate: "death.attack.drown", with: [{ text: "Fartmastery" }] }) });
    recordDeath(bot as unknown as Bot);
    await bot.sleep!({ position: new Vec3(3, 64, 4) });
    bot.emit("message", { json: { translate: "block.minecraft.set_spawn" } }, "system");

    const value = observed(bot);
    assert.deepEqual({ ...value.lastDeath, time: "now" }, {
      time: "now",
      position: { x: 5.5, y: 64, z: 7.5 },
      cause: "Fartmastery drowned",
    });
    assert.deepEqual(value.spawnPoint, { x: 3, y: 64, z: 4 });
    const line = brief(value);
    assert.match(line, /last death 0m ago at 5 64 7 \(drowned\)/);
    assert.match(line, /respawn: bed at 3 64 4/);
  });

  it("says the minutes since the last death, rounded down", () => {
    const bot = fakeBot();
    const seen = new Date(Date.now() - (5 * 60_000 + 40_000)).toISOString();
    trackDeaths(bot as unknown as Bot, { lastDeath: { time: seen, position: { x: 1, y: 2, z: 3 } } });
    assert.match(brief(observed(bot)), /last death 5m ago at 1 2 3(?!\s*\()/);
  });

  it("leaves both out while nothing has been sensed", () => {
    const value = observed(fakeBot());
    assert.equal("lastDeath" in value, false);
    assert.equal("spawnPoint" in value, false);
    const line = brief(value);
    assert.doesNotMatch(line, /last death|respawn/);
  });

  it("names the world spawn after a reset and leaves out a cause the server did not send", () => {
    const bot = fakeBot();
    trackDeaths(bot as unknown as Bot);
    recordDeath(bot as unknown as Bot);
    bot.emit("spawnReset");
    const line = brief(observed(bot));
    assert.match(line, /last death 0m ago at 5 64 7(?!\s*\()/);
    assert.match(line, /respawn: world spawn/);
  });
});
