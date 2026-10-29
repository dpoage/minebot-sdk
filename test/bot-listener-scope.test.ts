// What `ctx.bot` does with a listener the run did not add through it (B1), and the one thing a built-in routine may
// keep on the bot itself across runs: the late merchant window trade watches for (B2). The body's real runner and
// `routineContext` are used — not createHarness, which hands routines the bot directly — over a hand-built bot of the
// members the routines read.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Connection } from "../src/host/connection.ts";
import { routineContext, type GlobalsDeps } from "../src/host/globals.ts";
import { Notes } from "../src/notes.ts";
import { ProgramRunner } from "../src/program/runner.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";
import * as trade from "../src/routines/trade.ts";
import { JsonStore } from "../src/store.ts";
import type { WikiAccess } from "../src/wiki/access.ts";

const FEATURES: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: ["trade", "move"] };
const SOURCE_DIR = "/nonexistent/routines";

/** The bot under test: an event emitter with what the tests drive it by. Its members are the runtime ones, not the Mineflayer typings'. */
type Fake = EventEmitter & {
  currentWindow: unknown;
  rawOpen: (() => void) | undefined;
  installRaw(): void;
  installTwoRaw(event: string): void;
};

/** What a body wires into a run's context, over the bot under test. */
function depsFor(bot: Bot): GlobalsDeps {
  return {
    connection: { requireBot: () => bot } as unknown as Connection,
    wiki: {} as WikiAccess,
    notes: new Notes(JsonStore.memory()),
    store: () => JsonStore.memory(),
    observe: () => () => {},
    features: () => FEATURES,
    status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
  };
}

/** A bare event emitter as the bot: the removal paths under test need nothing else. */
function plainBot(): Fake {
  const bot = new EventEmitter() as unknown as Fake;
  Object.assign(bot, {
    currentWindow: null,
    rawOpen: undefined as (() => void) | undefined,
    installRaw() {
      const handler = () => {};
      bot.rawOpen = handler;
      bot.once("windowOpen", handler);
    },
    installTwoRaw(event: string) {
      bot.on(event, () => {});
      bot.on(event, () => {});
    },
  });
  return bot;
}

/** A bot of what `trade.offers` reads on its way to an open: one merchant where the player stands, a pathfinder that arrives at once, and an open whose listener stays on the bot (as Mineflayer's own do). */
function merchantBot(): { bot: Fake; opened: PromiseWithResolvers<void> } {
  const bot = plainBot();
  const opened = Promise.withResolvers<void>();
  const never = Promise.withResolvers<unknown>();
  const position = new Vec3(0.5, 64, 0.5);
  const merchant = { id: 9, name: "villager", position: new Vec3(0.5, 64, 0.5) };
  Object.assign(bot, {
    username: "scope",
    health: 20,
    food: 20,
    oxygenLevel: undefined,
    entity: { id: 1, position, effects: {} },
    entities: { 9: merchant },
    targetDigBlock: null,
    registry: { entitiesByName: { villager: { id: 120 } } },
    pathfinder: { movements: {}, goal: null, setGoal: () => {}, setMovements: () => {}, goto: async () => {}, isMoving: () => false },
    blockAt: () => null,
    setControlState: () => {},
    clearControlStates: () => {},
    inventory: { inventoryStart: 0, inventoryEnd: 36, items: () => [] },
    _client: Object.assign(new EventEmitter(), { write: () => {} }),
    // Mineflayer's openEntity registers its window listener on the bot itself; the routine removes it through the
    // view it was given, with `opening.remove()`.
    openVillager: (_view: unknown) => {
      const handler = () => {};
      bot.rawOpen = handler;
      bot.once("windowOpen", handler);
      opened.resolve();
      return never.promise;
    },
  });
  return { bot, opened };
}

describe("(B1) ctx.bot's removal methods work on the bot, not only on what the run registered", () => {
  it("removeListener removes a listener the run did not add through the view", { timeout: 20_000 }, async () => {
    const bot = plainBot();
    const run = await new ProgramRunner({ halt: () => {} }).call(
      async (scope) => {
        const view = routineContext(scope, depsFor(bot as unknown as Bot)).bot as unknown as Fake;
        view.installRaw();
        const before = view.listenerCount("windowOpen");
        const handler = view.listeners("windowOpen")[0] as () => void;
        view.removeListener("windowOpen", handler);
        return { before, after: view.listenerCount("windowOpen") };
      },
      { sourceDir: SOURCE_DIR },
    );
    assert.deepEqual(run.result, { before: 1, after: 0 });
    assert.equal(bot.listenerCount("windowOpen"), 0);
  });

  it("removeAllListeners(event) removes the bot's listeners of that event", { timeout: 20_000 }, async () => {
    const bot = plainBot();
    const run = await new ProgramRunner({ halt: () => {} }).call(
      async (scope) => {
        const view = routineContext(scope, depsFor(bot as unknown as Bot)).bot as unknown as Fake;
        view.installTwoRaw("scope-x");
        const before = view.listenerCount("scope-x");
        view.removeAllListeners("scope-x");
        return { before, after: view.listenerCount("scope-x") };
      },
      { sourceDir: SOURCE_DIR },
    );
    assert.deepEqual(run.result, { before: 2, after: 0 });
    assert.equal(bot.listenerCount("scope-x"), 0);
  });
});

describe("(B2) trade's late merchant-window watch outlives the failed open, on the bot itself", () => {
  for (const end of ["stopped", "timeout"] as const) {
    it(`${end}: the failed open's listener is gone, and a window arriving within LATE_WINDOW_MS is closed`, { timeout: 30_000 }, async () => {
      const { bot, opened } = merchantBot();
      const runner = new ProgramRunner({ halt: () => {} });
      const running = runner.call(async (scope) => trade.offers(routineContext(scope, depsFor(bot as unknown as Bot)), { radius: 8 }), {
        sourceDir: SOURCE_DIR,
        ...(end === "timeout" && { timeoutMs: 100 }),
      });
      await opened.promise;
      if (end === "stopped") assert.equal(runner.stop(), true);
      const run = await running;
      assert.equal(run.status, end, String(run.error));
      // The open's own listener is removed by the routine's cleanup, through the view it holds; the only listener
      // left is the late-window watch, which is the bot's.
      assert.equal(bot.listenerCount("windowOpen"), 1, "the failed open's listener stayed on the bot");
      assert.notEqual(bot.listeners("windowOpen")[0], bot.rawOpen, "the open's own listener is still there");
      // A merchant window the server sends after the call failed is closed, and the watch ends with it.
      const closed: string[] = [];
      bot.currentWindow = { type: "minecraft:villager", close: async () => void closed.push("closed") };
      bot.emit("windowOpen", bot.currentWindow);
      await nextMacrotask();
      assert.deepEqual(closed, ["closed"]);
      assert.equal(bot.listenerCount("windowOpen"), 0, "the late-window watch stayed after it closed the window");
    });
  }
});
