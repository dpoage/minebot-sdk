import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Item } from "minebot-sdk/routine";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as items from "../src/routines/items.ts";

/** The harness inventory, which the harness bot exposes without typing these members. */
interface FakeInventory {
  slots: (Item | null)[];
  items(): Item[];
  make(name: string, count: number): Item;
  set(slot: number, item: Item | null): void;
}

type AnvilWindow = EventEmitter & { id: number; type: string; inventoryStart: number; inventoryEnd: number; slots: (Item | null)[] };

interface Scenario {
  level?: number;
  cost?: number;
  /** What the anvil shows in its output slot after name_item: the wanted name, another name, or nothing. */
  offer?: "named" | "kept" | "none";
  /** What taking the output yields: the renamed stack, or the stack as it was (what a refused click leaves behind). */
  take?: "named" | "unnamed";
  /**
   * The anvil breaks on the take: the server closes the window before the client's click puts the stack down,
   * puts it in the first free hotbar slot itself, and tells the client only about that slot.
   */
  breaks?: boolean;
}

const textOf = (stack: Item | null): string | undefined => {
  const raw: unknown = stack?.customName;
  return typeof raw === "object" && raw !== null && "value" in raw ? String(raw.value) : undefined;
};

/** The inventory as a sorted list of `name x count [custom name]`: the same items and counts, wherever they sit. */
const contents = (h: Harness): string[] =>
  (h.bot.inventory as unknown as FakeInventory)
    .items()
    .map((stack) => `${stack.name} x${stack.count}${textOf(stack) === undefined ? "" : ` [${textOf(stack)}]`}`)
    .sort();

/** Slots 9-44 as `slot: name x count [custom name]`: where each stack sits, for comparing the client with the server. */
const bySlot = (slots: (Item | null)[]): string[] =>
  slots.flatMap((stack, slot) => (slot >= 9 && slot < 45 && stack ? [`${slot}: ${stack.name} x${stack.count}${textOf(stack) === undefined ? "" : ` [${textOf(stack)}]`}`] : []));

/**
 * Gives the harness bot the anvil API the harness lacks, as Mineflayer behaves on 26.1: the window holds a copy of
 * the inventory, the cost arrives as window property 0, a click on the output slot yields what `scenario.take` says,
 * closing copies the window's inventory part back, treating a stack that differs only in its name as unchanged, and
 * `_syncWindow(bot.inventory)` replaces the inventory with the server's. `state.server` is what the server holds,
 * by inventory slot; it can differ from the window, which shows what the client's clicks did.
 */
function anvilServer(h: Harness, scenario: Scenario = {}) {
  const inventory = h.bot.inventory as unknown as FakeInventory;
  const state = { level: scenario.level ?? 5, opened: 0, closed: 0, synced: 0, written: [] as string[], taken: 0, window: undefined as AnvilWindow | undefined, server: [] as (Item | null)[] };
  const cost = scenario.cost ?? 1;
  const copy = (stack: Item, name = textOf(stack)) => {
    const made = inventory.make(stack.name, stack.count);
    if (name !== undefined) made.customName = { type: "string", value: name } as unknown as string;
    return made;
  };
  /** Puts `stack` in `slots` the way a click does: onto a stack of the same item and name with room first, then into the first empty slot, in `order`. */
  const place = (slots: (Item | null)[], order: number[], stack: Item) => {
    for (const i of order) {
      const there = slots[i];
      if (!there || there.type !== stack.type || textOf(there) !== textOf(stack) || there.count >= 64) continue;
      const moved = Math.min(stack.count, 64 - there.count);
      there.count += moved;
      stack.count -= moved;
      if (stack.count === 0) return;
    }
    const empty = order.find((i) => !slots[i]);
    if (empty === undefined) throw new Error("the inventory is full");
    slots[empty] = stack;
  };
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  /** The window's inventory part, in the order a click fills it: the main grid (3-29), then the hotbar (30-38). */
  const windowOrder = range(3, 39);
  /** The server's inventory slots in the order the window shows them, so a click lands on the server where it lands in the window. */
  const serverOrder = range(9, 45);
  /** The order the server puts back what a window it closed held: the hotbar first. */
  const hotbarFirst = [...range(36, 45), ...range(9, 36)];
  const client = Object.assign(new EventEmitter(), {
    write(packet: string, data: { name: string }) {
      assert.equal(packet, "name_item");
      state.written.push(data.name);
      const window = state.window!;
      const input = window.slots[0];
      if (!input) return;
      const offer = scenario.offer ?? "named";
      if (offer !== "none") window.slots[2] = copy(input, offer === "named" ? data.name : `${data.name}?`);
      client.emit("craft_progress_bar", { windowId: window.id, property: 0, value: cost });
    },
  });
  Object.assign(h.bot, {
    _client: client,
    experience: {
      get level() {
        return state.level;
      },
    },
    async openBlock() {
      state.opened++;
      const window = Object.assign(new EventEmitter(), { id: 7, type: "minecraft:anvil", inventoryStart: 3, inventoryEnd: 39, slots: new Array<Item | null>(39).fill(null) });
      for (let i = 0; i < 27; i++) window.slots[3 + i] = inventory.slots[9 + i] ? copy(inventory.slots[9 + i]!) : null;
      for (let i = 0; i < 9; i++) window.slots[30 + i] = inventory.slots[36 + i] ? copy(inventory.slots[36 + i]!) : null;
      state.server = inventory.slots.map((stack) => (stack ? copy(stack) : null));
      state.window = window;
      h.bot.currentWindow = window as never;
      return window;
    },
    async moveSlotItem(source: number, dest: number) {
      assert.equal(dest, 0, "the stack goes into the anvil's input slot");
      const window = state.window!;
      if (!window.slots[source]) throw new Error(`nothing in slot ${source}`);
      window.slots[dest] = window.slots[source];
      window.slots[source] = null;
      state.server[source + 6] = null;
    },
    async putAway(slot: number) {
      const window = state.window!;
      const stack = window.slots[slot];
      if (!stack) throw new Error(`nothing in slot ${slot}`);
      if (slot === 2) {
        state.taken++;
        const input = window.slots[0]!;
        window.slots[0] = null;
        window.slots[2] = null;
        const yielded = scenario.take === "unnamed" ? copy(input) : stack;
        if (scenario.take !== "unnamed") state.level -= cost;
        if (scenario.breaks) {
          const before = state.server.map((s) => (s ? `${s.count}` : ""));
          place(state.server, hotbarFirst, copy(yielded));
          place(window.slots, windowOrder, yielded);
          h.bot.currentWindow = null;
          for (const i of hotbarFirst) if (`${state.server[i]?.count ?? ""}` !== before[i]) inventory.set(i, copy(state.server[i]!));
          return;
        }
        place(state.server, serverOrder, copy(yielded));
        place(window.slots, windowOrder, yielded);
        return;
      }
      window.slots[slot] = null;
      place(state.server, serverOrder, copy(stack));
      place(window.slots, windowOrder, stack);
    },
    closeWindow(window: AnvilWindow) {
      state.closed++;
      h.bot.currentWindow = null;
      for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
        const slot = i + 6;
        const shown = window.slots[i] ?? null;
        const held = inventory.slots[slot] ?? null;
        const same = shown === held || (shown !== null && held !== null && shown.type === held.type && shown.count === held.count);
        if (!same) inventory.set(slot, shown);
      }
    },
    async _syncWindow(window: unknown) {
      assert.equal(window, h.bot.inventory, "the sync reads the player's inventory, not the anvil's");
      state.synced++;
      for (let slot = 9; slot < 45; slot++) {
        const held = state.server[slot];
        inventory.set(slot, held ? copy(held) : null);
      }
    },
  });
  return state;
}

const NAME_36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAME_50 = `${NAME_36}ABCDEFGHIJKLMN`;

/** A stack of `item` carrying the custom name `name`, as Mineflayer reads one on 26.1. */
const namedStack = (h: Harness, item: string, count: number, name: string): Item => {
  const stack = (h.bot.inventory as unknown as FakeInventory).make(item, count);
  stack.customName = { type: "string", value: name } as unknown as string;
  return stack;
};

describe("items.rename", () => {
  for (const [kind, name] of [
    ["anvil", "A"],
    ["chipped_anvil", NAME_36],
    ["damaged_anvil", NAME_50],
  ] as const) {
    it(`renames the stack at a ${kind} with a ${name.length}-character name, whole, for the levels it cost`, async () => {
      const h = createHarness({ inventory: { stone: 64, oak_planks: 5 }, blocks: [{ name: kind, at: [1, 64, 0] }] });
      const server = anvilServer(h, { level: 12 });
      const result = await h.run(items.rename, { item: "stone", name });
      assert.deepEqual(result, { item: "stone", name, count: 64, levelsSpent: 1 });
      assert.deepEqual(contents(h), [`oak_planks x5`, `stone x64 [${name}]`]);
      assert.equal(server.level, 11);
      assert.deepEqual(server.written, [name], "the whole name goes out in one name_item packet");
      assert.equal(server.closed, 1);
      assert.deepEqual(server.window!.slots.slice(0, 3), [null, null, null], "nothing is left in the anvil");
      assert.deepEqual(bySlot(h.bot.inventory.slots), bySlot(server.server), "the inventory is the server's");
    });
  }

  it("throws, naming what the inventory holds, when taking the output leaves the stack unrenamed (a refused click resolves too)", async () => {
    const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    anvilServer(h, { take: "unnamed" });
    await assert.rejects(h.run(items.rename, { item: "stone", name: "Guild" }), /the stone did not come out of the anvil renamed to "Guild"/);
    assert.deepEqual(contents(h), ["stone x64"]);
  });

  it("leaves the inventory showing the new name when the renamed stack lands in the slot the old one left", async () => {
    const h = createHarness({ blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const inventory = h.bot.inventory as unknown as FakeInventory;
    inventory.set(9, inventory.make("stone", 64));
    anvilServer(h);
    assert.deepEqual(await h.run(items.rename, { item: "stone", name: "Ledger" }), { item: "stone", name: "Ledger", count: 64, levelsSpent: 1 });
    assert.equal(textOf(inventory.slots[9] ?? null), "Ledger");
    assert.deepEqual(contents(h), ["stone x64 [Ledger]"]);
  });

  it("returns the stack from the anvil and throws, naming the cost and the level, when the levels fall short", async () => {
    const h = createHarness({ inventory: { stone: 64, oak_planks: 5 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const before = contents(h);
    const server = anvilServer(h, { level: 0, cost: 3 });
    await assert.rejects(h.run(items.rename, { item: "stone", name: "Broke" }), /renaming the stone costs 3 levels and you have 0 levels: earn 3 levels more, then call items.rename again/);
    assert.deepEqual(contents(h), before);
    assert.deepEqual(server.window!.slots.slice(0, 2), [null, null], "the input is back out of the anvil");
    assert.equal(server.taken, 0);
    assert.equal(server.closed, 1);
    assert.equal(server.level, 0);
    assert.deepEqual(bySlot(h.bot.inventory.slots), bySlot(server.server), "the inventory is the server's");
  });

  it("throws, naming the name the server kept, when it changes the name; the stack goes back", async () => {
    const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    anvilServer(h, { offer: "kept" });
    await assert.rejects(h.run(items.rename, { item: "stone", name: "Guild" }), /the anvil kept the name "Guild\?" instead of "Guild"/);
    assert.deepEqual(contents(h), ["stone x64"]);
  });

  it("throws, saying what the anvil does when it offers nothing; the stack goes back", async () => {
    const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const server = anvilServer(h, { offer: "none" });
    await assert.rejects(h.run(items.rename, { item: "stone", name: "Guild" }), /the anvil offered no renamed stone: it offers nothing when the item already has that name/);
    assert.deepEqual(contents(h), ["stone x64"]);
    assert.equal(server.taken, 0);
  });

  it("answers a stack that already has the name without opening the anvil or spending levels", async () => {
    const h = createHarness({ blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const inventory = h.bot.inventory as unknown as FakeInventory;
    const stack = inventory.make("stone", 9);
    stack.customName = { type: "string", value: "Ledger" } as unknown as string;
    inventory.set(9, stack);
    const server = anvilServer(h);
    assert.deepEqual(await h.run(items.rename, { item: "stone", name: "Ledger" }), { item: "stone", name: "Ledger", count: 9, levelsSpent: 0 });
    assert.equal(server.opened, 0);
  });

  it("answers at once, needing no anvil, when every stack of the item already has the name", async () => {
    const h = createHarness({ blocks: [{ name: "anvil", at: [20, 64, 0] }] });
    const inventory = h.bot.inventory as unknown as FakeInventory;
    inventory.set(9, namedStack(h, "stone", 9, "Ledger"));
    inventory.set(40, namedStack(h, "stone", 5, "Ledger"));
    const server = anvilServer(h);
    assert.deepEqual(await h.run(items.rename, { item: "stone", name: "Ledger" }), { item: "stone", name: "Ledger", count: 9, levelsSpent: 0 });
    assert.equal(server.opened, 0);
    assert.equal(server.level, 5);
  });

  it("renames the next stack that lacks the name when an earlier stack already has it", async () => {
    const h = createHarness({ blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const inventory = h.bot.inventory as unknown as FakeInventory;
    inventory.set(9, namedStack(h, "bread", 64, "Guild Bread"));
    inventory.set(10, inventory.make("bread", 7));
    const server = anvilServer(h);
    assert.deepEqual(await h.run(items.rename, { item: "bread", name: "Guild Bread" }), { item: "bread", name: "Guild Bread", count: 7, levelsSpent: 1 });
    assert.deepEqual(contents(h), ["bread x64 [Guild Bread]", "bread x7 [Guild Bread]"]);
    assert.deepEqual(bySlot(inventory.slots), bySlot(server.server), "the inventory is the server's");
  });

  it("counts the renamed items that join a stack already carrying the name, whole or split", async () => {
    for (const [had, after] of [
      [20, ["cobblestone x30 [Brand]"]],
      [60, ["cobblestone x6 [Brand]", "cobblestone x64 [Brand]"]],
    ] as const) {
      const h = createHarness({ blocks: [{ name: "anvil", at: [1, 64, 0] }] });
      const inventory = h.bot.inventory as unknown as FakeInventory;
      inventory.set(9, inventory.make("cobblestone", 10));
      inventory.set(10, namedStack(h, "cobblestone", had, "Brand"));
      const server = anvilServer(h, { level: 30 });
      assert.deepEqual(await h.run(items.rename, { item: "cobblestone", name: "Brand" }), { item: "cobblestone", name: "Brand", count: 10, levelsSpent: 1 }, `onto ${had}`);
      assert.deepEqual(contents(h), after);
      assert.deepEqual(bySlot(inventory.slots), bySlot(server.server), "the inventory is the server's");
    }
  });

  it("leaves the inventory as the server holds it when the anvil breaks on the take and the server puts the stack elsewhere", async () => {
    const h = createHarness({ inventory: { oak_planks: 5 }, blocks: [{ name: "damaged_anvil", at: [1, 64, 0] }] });
    const inventory = h.bot.inventory as unknown as FakeInventory;
    inventory.set(9, inventory.make("stone", 64));
    const server = anvilServer(h, { breaks: true });
    assert.deepEqual(await h.run(items.rename, { item: "stone", name: "Ledger" }), { item: "stone", name: "Ledger", count: 64, levelsSpent: 1 });
    assert.deepEqual(bySlot(server.server), ["36: oak_planks x5", "37: stone x64 [Ledger]"], "the server put the stack in the hotbar, not where the click went");
    assert.deepEqual(bySlot(inventory.slots), bySlot(server.server), "the inventory is the server's");
    assert.equal(server.closed, 0, "the window the server closed is not closed again");
    assert.equal(h.bot.currentWindow, null);
  });

  describe("without an anvil within reach", () => {
    it("names the nearest anvil within 16 blocks, its position and distance, and says to walk first; it never walks", async () => {
      const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "chipped_anvil", at: [10, 64, 0] }] });
      const server = anvilServer(h);
      const start = h.position.clone();
      await assert.rejects(h.run(items.rename, { item: "stone", name: "Far" }), /no anvil within reach \(4\.5 blocks\): the nearest is the chipped_anvil at \(10, 64, 0\), 10\.\d blocks away; walk within reach first \(for example move\.to/);
      assert.ok(h.position.equals(start), "the bot stayed where it was");
      assert.equal(server.opened, 0);
      assert.deepEqual(contents(h), ["stone x64"]);
    });

    it("says none is within 16 blocks", async () => {
      const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [30, 64, 0] }] });
      anvilServer(h);
      await assert.rejects(h.run(items.rename, { item: "stone", name: "Far" }), /no anvil within 16 blocks: place one \(place\.place with item "anvil"\) or walk to one \(move\.to\)/);
    });
  });

  it("names an item the inventory lacks, and an item that does not exist", async () => {
    const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    const server = anvilServer(h);
    await assert.rejects(h.run(items.rename, { item: "emerald", name: "Coin" }), /no emerald in the inventory/);
    await assert.rejects(h.run(items.rename, { item: "stoen", name: "Coin" }), /unknown item "stoen"/);
    assert.equal(server.opened, 0);
    assert.deepEqual(contents(h), ["stone x64"]);
  });

  it("refuses names outside 1-50 characters, or of spaces, naming the limit", async () => {
    const h = createHarness({ inventory: { stone: 64 }, blocks: [{ name: "anvil", at: [1, 64, 0] }] });
    anvilServer(h);
    await assert.rejects(h.run(items.rename, { item: "stone", name: `${NAME_50}O` }), /name must be 1-50 characters: an anvil accepts at most 50/);
    await assert.rejects(h.run(items.rename, { item: "stone", name: "" }), /name must be 1-50 characters/);
    await assert.rejects(h.run(items.rename, { item: "stone", name: "   " }), /name must contain more than spaces/);
  });
});
