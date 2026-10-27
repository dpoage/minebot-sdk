import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as craft from "../src/routines/craft.ts";

const TABLE = [{ name: "crafting_table", at: [1, 64, 0] as const }];
/** What a craft over another open window ends in on a live server (Mineflayer waits 20 s for an inventory update the server never sends). */
const TIMEOUT = "Event updateSlot:0 did not fire within timeout of 20000ms";

interface StubWindow {
  type: string;
}

/**
 * The harness has no windows (no openBlock, no closeWindow): the test gives the bot a `currentWindow`
 * and a `closeWindow` that ends it, and makes bot.craft fail as a server does while a window is open.
 */
function withStrayWindow(h: Harness, type: string): { events: string[]; window: StubWindow } {
  const bot = h.bot as unknown as { currentWindow: StubWindow | null; closeWindow: (window: StubWindow) => void; craft: (...args: unknown[]) => Promise<void> };
  const events: string[] = [];
  const window = { type };
  bot.currentWindow = window;
  bot.closeWindow = (closing) => {
    assert.equal(closing, window, "closes the window that is open");
    events.push("close");
    bot.currentWindow = null;
  };
  const craftAtServer = bot.craft;
  bot.craft = async (...args) => {
    events.push("craft");
    if (bot.currentWindow) throw new Error(TIMEOUT);
    await craftAtServer(...args);
  };
  return { events, window };
}

describe("craft.craft with a window left open", () => {
  it("closes a crafting table window before a 2x2 craft, says so, and leaves no window open", async () => {
    const h = createHarness({ inventory: { oak_log: 1 } });
    const { events } = withStrayWindow(h, "minecraft:crafting");
    assert.equal(await h.run(craft.craft, { item: "oak_planks" }), 4);
    assert.deepEqual(events, ["close", "craft"], "the close comes before the craft");
    assert.deepEqual(h.logs, ["closed the open crafting_table window first", "crafted 4 oak_planks"]);
    assert.equal(h.bot.currentWindow, null);
  });

  it("closes a chest window before a 2x2 craft, naming its type", async () => {
    const h = createHarness({ inventory: { oak_log: 1 } });
    const { events } = withStrayWindow(h, "minecraft:generic_9x3");
    assert.equal(await h.run(craft.craft, { item: "oak_planks" }), 4);
    assert.deepEqual(events, ["close", "craft"]);
    assert.deepEqual(h.logs, ["closed the open generic_9x3 window first", "crafted 4 oak_planks"]);
    assert.equal(h.bot.currentWindow, null);
  });

  it("closes a chest window before a table recipe, which crafts as it does without one", async () => {
    const h = createHarness({ inventory: { oak_planks: 3, stick: 2 }, blocks: TABLE });
    const { events } = withStrayWindow(h, "minecraft:generic_9x3");
    assert.equal(await h.run(craft.craft, { item: "wooden_pickaxe" }), 1);
    assert.deepEqual(events, ["close", "craft"]);
    assert.equal(h.count("wooden_pickaxe"), 1);
    assert.equal(h.bot.currentWindow, null);
  });

  it("closes nothing when no window is open", async () => {
    const h = createHarness({ inventory: { oak_log: 1 } });
    const { events } = withStrayWindow(h, "minecraft:crafting");
    h.bot.currentWindow = null;
    assert.equal(await h.run(craft.craft, { item: "oak_planks" }), 4);
    assert.deepEqual(events, ["craft"]);
    assert.deepEqual(h.logs, ["crafted 4 oak_planks"]);
  });

  it("closes the window even when the call then fails, so it leaves none open either way", async () => {
    const h = createHarness({ inventory: {} });
    const { events } = withStrayWindow(h, "minecraft:generic_9x3");
    await assert.rejects(h.run(craft.craft, { item: "oak_planks" }), /not enough ingredients for 1 oak_planks/);
    assert.deepEqual(events, ["close"], "no craft, but the window is gone");
    assert.deepEqual(h.logs, ["closed the open generic_9x3 window first"]);
    assert.equal(h.bot.currentWindow, null);
  });
});
