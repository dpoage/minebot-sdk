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

/**
 * Gives the harness bot the anvil API the harness lacks, as Mineflayer behaves on 26.1: the window holds a copy of
 * the inventory, the cost arrives as window property 0, a click on the output slot yields what `scenario.take` says,
 * and closing copies the window's inventory part back, treating a stack that differs only in its name as unchanged.
 */
function anvilServer(h: Harness, scenario: Scenario = {}) {
  const inventory = h.bot.inventory as unknown as FakeInventory;
  const state = { level: scenario.level ?? 5, opened: 0, closed: 0, written: [] as string[], taken: 0, window: undefined as AnvilWindow | undefined };
  const cost = scenario.cost ?? 1;
  const named = (stack: Item, name: string) => {
    const copy = inventory.make(stack.name, stack.count);
    copy.customName = { type: "string", value: name } as unknown as string;
    return copy;
  };
  const firstEmpty = (window: AnvilWindow) => {
    for (let i = window.inventoryStart; i < window.inventoryEnd; i++) if (!window.slots[i]) return i;
    throw new Error("the inventory is full");
  };
  const client = Object.assign(new EventEmitter(), {
    write(packet: string, data: { name: string }) {
      assert.equal(packet, "name_item");
      state.written.push(data.name);
      const window = state.window!;
      const input = window.slots[0];
      if (!input) return;
      const offer = scenario.offer ?? "named";
      if (offer !== "none") window.slots[2] = named(input, offer === "named" ? data.name : `${data.name}?`);
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
      for (let i = 0; i < 27; i++) window.slots[3 + i] = inventory.slots[9 + i] ?? null;
      for (let i = 0; i < 9; i++) window.slots[30 + i] = inventory.slots[36 + i] ?? null;
      state.window = window;
      return window;
    },
    async transfer(options: { itemType: number; sourceStart: number; sourceEnd: number; destStart: number }) {
      const window = state.window!;
      for (let i = options.sourceStart; i < options.sourceEnd; i++) {
        const stack = window.slots[i];
        if (stack?.type !== options.itemType) continue;
        window.slots[options.destStart] = stack;
        window.slots[i] = null;
        return;
      }
      throw new Error("Can't find the item in the window");
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
        window.slots[firstEmpty(window)] = scenario.take === "unnamed" ? inventory.make(input.name, input.count) : stack;
        if (scenario.take !== "unnamed") state.level -= cost;
        return;
      }
      window.slots[slot] = null;
      window.slots[firstEmpty(window)] = stack;
    },
    closeWindow(window: AnvilWindow) {
      state.closed++;
      for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
        const slot = i + 6;
        const shown = window.slots[i] ?? null;
        const held = inventory.slots[slot] ?? null;
        const same = shown === held || (shown !== null && held !== null && shown.type === held.type && shown.count === held.count);
        if (!same) inventory.set(slot, shown);
      }
    },
  });
  Object.assign(inventory, { updateSlot: (slot: number, stack: Item | null) => inventory.set(slot, stack) });
  return state;
}

const NAME_36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAME_50 = `${NAME_36}ABCDEFGHIJKLMN`;

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
