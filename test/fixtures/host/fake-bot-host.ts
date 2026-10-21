// The real bot host (src/host/main.ts) with a player that needs no Minecraft server: Mineflayer's
// `createBot` returns an EventEmitter that "spawns" a tick after it is created, so the real
// Connection, Body, world, routes, triggers, and bindings run as they do against a server. The
// fake bot emits whatever the test makes it emit (`ctx.bot.emit("chat", "alice", "hi")` in a
// routine reaches the body's event log as a chat event, through the real Connection).
import { EventEmitter } from "node:events";
import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

// The module objects are CommonJS exports the host reads at call time; the typings do not allow replacing members.
const pathfinder = pathfinderPkg as { Movements: unknown };
const flayer = mineflayer as unknown as { createBot: () => EventEmitter };

// The spawn handler builds Movements from the bot's registry; the fake has none.
pathfinder.Movements = class {};

function fakeBot(): EventEmitter {
  const bot = new EventEmitter();
  const noop = () => {};
  Object.assign(bot, {
    username: "fakebot",
    health: 20,
    food: 20,
    entity: { id: 1, position: new Vec3(1, 64, 2), effects: {} },
    inventory: { items: () => [] },
    entities: {},
    targetDigBlock: null,
    pathfinder: { setMovements: noop, setGoal: noop },
    _client: new EventEmitter(),
    loadPlugin: noop,
    clearControlStates: noop,
    stopDigging: noop,
    deactivateItem: noop,
    quit: noop,
    clickWindow: async () => {},
    dig: async () => {},
    craft: async () => {},
  });
  // After Connection has attached its listeners.
  setTimeout(() => {
    bot.emit("login");
    bot.emit("spawn");
  }, 0);
  return bot;
}

flayer.createBot = fakeBot;

// Not a static import: the host must load after the patches above (static imports are evaluated first).
await import("../../../src/host/main.ts");
