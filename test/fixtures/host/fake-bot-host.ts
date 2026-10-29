// The real bot host (src/host/main.ts) with a player that needs no Minecraft server: Mineflayer's
// `createBot` returns an EventEmitter that "spawns" a tick after it is created, so the real
// Connection, Body, world, routes, triggers, and bindings run as they do against a server. The
// fake bot emits whatever the test makes it emit (`ctx.bot.emit("chat", "alice", "hi")` in a
// routine reaches the body's event log as a chat event, through the real Connection).
// `init.dropEchoes` (the test's own field, read from the init message) lists event types whose echo
// from the supervisor's log never reaches the host's triggers, so a firing that waits for the runner
// can start only when something tells the triggers the runner is idle, not when an echo does.
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
  /** The controls a run or the body's float holds, and every value jump was given, in order (a run reads them back through `ctx.bot`). */
  const controlState: Record<string, boolean> = {};
  const jumps: boolean[] = [];
  /** The block at the player's eyes: a run sets `ctx.bot.eye.name = "water"` to put the player under water. */
  const eye = { name: null as string | null };
  const setControlState = (control: string, state: boolean) => {
    controlState[control] = state;
    if (control === "jump") jumps.push(state);
  };
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
    controlState,
    jumps,
    eye,
    setControlState,
    clearControlStates: () => {
      for (const [control, held] of Object.entries(controlState)) if (held) setControlState(control, false);
    },
    blockAt: () => (eye.name === null ? null : { name: eye.name, getProperties: () => ({}) }),
    stopDigging: noop,
    deactivateItem: noop,
    quit: noop,
    clickWindow: async () => {},
    dig: async () => {},
    craft: async () => {},
    // Real members a run's "did you mean" line names: a suggestion is shown only when the member it names exists.
    equip: async () => {},
    isRaining: false,
    // A plugin's listener is the host's, not a run's: this installs the tick model on the real bot, outside any run's
    // scope, and ticks it, as mineflayer-pathfinder installs and ticks its own physicsTick listener when it loads.
    installPathfinderTick: (listener: () => void) => {
      bot.on("physicsTick", listener);
      setInterval(() => bot.emit("physicsTick"), 20).unref();
    },
  });
  // After Connection has attached its listeners.
  setTimeout(() => {
    bot.emit("login");
    bot.emit("spawn");
  }, 0);
  return bot;
}

flayer.createBot = fakeBot;

/** Event types whose echoes the host does not hear (see the top of this file). */
let dropped: string[] = [];
const listen = process.on.bind(process) as (event: string, listener: (message: unknown) => void) => unknown;
(process as unknown as { on: typeof listen }).on = (event, listener) =>
  listen(event, (message) => {
    if (event === "message" && typeof message === "object" && message !== null) {
      if ("kind" in message && message.kind === "init" && "init" in message && typeof message.init === "object" && message.init !== null && "dropEchoes" in message.init) {
        dropped = message.init.dropEchoes as string[];
      }
      if ("kind" in message && message.kind === "event" && "event" in message && typeof message.event === "object" && message.event !== null && "type" in message.event && dropped.includes(message.event.type as string)) return;
    }
    listener(message);
  });

// Not a static import: the host must load after the patches above (static imports are evaluated first).
await import("../../../src/host/main.ts");
