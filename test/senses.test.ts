// The body's senses: air running low, and the connection reporting the server's death message and a
// spawn point reset into the event log.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { describe, it } from "node:test";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { EventLog } from "../src/body/events.ts";
import { LOW_OXYGEN, watchGame } from "../src/host/watch.ts";

type AirBot = EventEmitter & {
  entity: { id: number; position: Vec3; effects: Record<string, unknown> };
  entities: Record<number, unknown>;
  health: number;
  food: number;
  oxygenLevel?: number;
  _client: EventEmitter;
  registry: { effects: Record<number, unknown>; items: Record<number, unknown> };
};

/** A player with the parts watchGame reads; one that has not reported air yet has no oxygenLevel. */
function airBot(oxygenLevel?: number): AirBot {
  return Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {} },
    entities: {},
    health: 20,
    food: 20,
    ...(oxygenLevel !== undefined && { oxygenLevel }),
    _client: new EventEmitter(),
    registry: { effects: {}, items: {} },
  }) as AirBot;
}

const types = (events: EventLog) => events.since().events.map((event) => event.type);

describe("low_oxygen", () => {
  const tick = (bot: AirBot, count = 1) => {
    for (let i = 0; i < count; i++) bot.emit("physicsTick");
  };

  it("raises once as air falls below the threshold, and again after it is back at the threshold", () => {
    assert.equal(LOW_OXYGEN, 10);
    const bot = airBot(20);
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    tick(bot, 10);
    assert.deepEqual(types(events), []);

    bot.oxygenLevel = 9;
    tick(bot);
    tick(bot);
    assert.deepEqual(events.since().events.map((event) => [event.type, event.data]), [["low_oxygen", { oxygen: 9 }]]);

    bot.oxygenLevel = 12;
    tick(bot);
    bot.oxygenLevel = 10;
    tick(bot);
    bot.oxygenLevel = 8;
    tick(bot);
    assert.deepEqual(types(events), ["low_oxygen", "low_oxygen"]);
  });

  it("stays quiet for a bot that has not reported air", () => {
    const bot = airBot();
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    tick(bot, 20);
    assert.deepEqual(types(events), []);
  });

  it("treats an undefined air value as no data: it neither raises the event nor re-arms it", () => {
    const bot = airBot(9);
    const events = new EventLog();
    watchGame(bot as unknown as Bot, events);
    tick(bot);
    assert.deepEqual(types(events), ["low_oxygen"]);

    bot.oxygenLevel = undefined;
    tick(bot, 3);
    bot.oxygenLevel = 9;
    tick(bot);
    assert.deepEqual(types(events), ["low_oxygen"]);

    bot.oxygenLevel = 10;
    tick(bot);
    bot.oxygenLevel = 9;
    tick(bot);
    assert.deepEqual(types(events), ["low_oxygen", "low_oxygen"]);
  });
});

type ConnectionBot = EventEmitter & {
  entity: { id: number; position: Vec3; effects: Record<string, unknown>; onGround: boolean };
  inventory: { slots: Record<number, unknown>; items: () => { name: string; count: number; slot: number }[] };
  _client: EventEmitter;
};

// The real Connection over an EventEmitter player, as fixtures/host/fake-bot-host.ts does for the host.
const flayer = mineflayer as unknown as { createBot: () => ConnectionBot };
const pathfinder = pathfinderPkg as { Movements: unknown };
// The spawn handler builds Movements from the bot's registry; the fake has none.
pathfinder.Movements = class {};

let created: ConnectionBot[] = [];
flayer.createBot = () => {
  const bot = Object.assign(new EventEmitter(), {
    username: "Fartmastery",
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {}, onGround: true },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    entities: {},
    inventory: { slots: {}, items: () => [] },
    registry: { effects: {}, items: {}, language: { "death.attack.drown": "%1$s drowned" } },
    targetDigBlock: null,
    pathfinder: { setMovements: () => {}, setGoal: () => {} },
    _client: new EventEmitter(),
    loadPlugin: () => {},
    clearControlStates: () => {},
    stopDigging: () => {},
    deactivateItem: () => {},
    quit: () => {},
    sleep: async () => {},
    activateBlock: async () => {},
    clickWindow: async () => {},
    dig: async () => {},
    craft: async () => {},
  }) as ConnectionBot;
  // After Connection has attached its listeners (as fake-bot-host.ts's fake does), but without a timer.
  queueMicrotask(() => {
    bot.emit("login");
    bot.emit("spawn");
  });
  created.push(bot);
  return bot;
};

// A static import cannot work here: Connection destructures the pathfinder's Movements at module
// load, so the stub has to be installed first (the same reason fixtures/host/fake-bot-host.ts imports
// the host dynamically). The real Connection then runs over an EventEmitter player.
const { Connection } = await import("../src/host/connection.ts");

describe("the connection's death and spawn events", () => {
  it("pushes the death with the server's message and the carried items, and a reset spawn point as spawn_reset", async () => {
    created = [];
    const events = new EventLog();
    const connection = new Connection({ username: "Fartmastery", auth: "offline", authCacheDir: "/tmp", host: "127.0.0.1", port: 25631, events });
    try {
      connection.start();
      const bot = created[0]!;
      await once(bot, "spawn");
      Object.assign(bot, { inventory: { slots: {}, items: () => [{ name: "bread", count: 2, slot: 0 }] } });
      bot.entity.position = new Vec3(1, 64, 2);

      bot._client.emit("death_combat_event", {
        playerId: 1,
        message: { type: "string", value: JSON.stringify({ translate: "death.attack.drown", with: [{ text: "Fartmastery" }] }) },
      });
      bot.emit("death");

      const death = events.since().events.find((event) => event.type === "death");
      assert.deepEqual(death?.data, { position: { x: 1, y: 64, z: 2 }, cause: "Fartmastery drowned", dropped: [{ name: "bread", count: 2 }] });
      assert.equal(connection.deaths, 1);

      bot.emit("spawnReset");
      assert.deepEqual(events.since().events.filter((event) => event.type === "spawn_reset").map((event) => event.data), [{}]);
    } finally {
      connection.close();
    }
  });
});
