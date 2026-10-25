import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as craft from "../src/routines/craft.ts";
import { InventoryFullError } from "../src/routines/craft.ts";
import * as crafter from "../src/routines/crafter.ts";

const TABLE = [{ name: "crafting_table", at: [1, 64, 0] as const }];
/** The server answers, but the crafted item reaches the inventory this many ticks after bot.craft resolved (20 ticks = 1 s). */
const LAG = 5;

describe("the harness's late crafted item", () => {
  it("lands in the inventory after bot.craft resolved, when the clock passes the delay, and tells the inventory's listeners", async () => {
    const h = createHarness({ inventory: { oak_planks: 3, stick: 2 }, blocks: TABLE, craftResultDelay: LAG });
    const recipe = h.bot.recipesFor(h.bot.registry.itemsByName.wooden_axe!.id, null, 1, true)[0]!;
    const slots: number[] = [];
    h.bot.inventory.on("updateSlot", (slot: number) => slots.push(slot));
    await h.bot.craft(recipe, 1, h.blockAt([1, 64, 0]));
    assert.equal(h.count("wooden_axe"), 0, "bot.craft resolved before the result arrived");
    slots.length = 0;
    h.advance(LAG - 1);
    assert.equal(h.count("wooden_axe"), 0);
    h.advance(1);
    assert.equal(h.count("wooden_axe"), 1);
    assert.equal(slots.length, 1, "one updateSlot for the arrival");
  });
});

describe("craft.craft on a server whose result arrives late", () => {
  it("counts a 2x2 recipe after the result lands", async () => {
    const h = createHarness({ inventory: { oak_planks: 4 }, craftResultDelay: LAG });
    assert.equal(await h.run(craft.craft, { item: "crafting_table" }), 1);
    assert.equal(h.count("crafting_table"), 1);
    assert.deepEqual(h.logs, ["crafted 1 crafting_table"]);
  });

  it("counts a table recipe after the result lands", async () => {
    const h = createHarness({ inventory: { oak_planks: 3, stick: 2 }, blocks: TABLE, craftResultDelay: LAG });
    assert.equal(await h.run(craft.craft, { item: "wooden_axe" }), 1);
    assert.equal(h.count("wooden_axe"), 1);
    assert.deepEqual(h.logs, ["crafted 1 wooden_axe"]);
  });

  it("counts every craft of a repeated recipe, not the first to land", async () => {
    const h = createHarness({ inventory: { oak_log: 2 }, craftResultDelay: LAG });
    assert.equal(await h.run(craft.craft, { item: "oak_planks", count: 8 }), 8);
    assert.equal(h.count("oak_planks"), 8);
  });

  it("restarts the wait at every inventory update: the 1500 ms are without one", async () => {
    const h = createHarness({ inventory: { oak_planks: 4 }, craftResultDelay: 40 });
    const start = h.bot.time.age;
    const run = h.run(craft.craft, { item: "crafting_table" });
    let ended = false;
    const end = () => {
      ended = true;
    };
    void run.then(end, end);
    // An unrelated pickup 25 ticks in: the wait restarts, so the result at tick 40 is still in time (a 1500 ms wait from the start would have ended at tick 30).
    // A run that ends before then did not wait, and the assertions below fail it.
    while (!ended && h.bot.time.age < start + 25) await new Promise<void>((resolve) => setImmediate(resolve));
    h.give("dirt");
    assert.equal(await run, 1);
    assert.equal(h.count("crafting_table"), 1);
  });

  it("waits no longer than 1500 ms without an inventory update, and then fails as the craft that made nothing", async () => {
    const lagging = createHarness({ inventory: { oak_planks: 4 }, craftResultDelay: 29 });
    assert.equal(await lagging.run(craft.craft, { item: "crafting_table" }), 1, "29 ticks is 1450 ms");
    const lost = createHarness({ inventory: { oak_planks: 4 }, craftResultDelay: 40 });
    await assert.rejects(lost.run(craft.craft, { item: "crafting_table" }), /crafted 0 of 1 crafting_table/);
  });

  it("lets crafter.make build a wooden pickaxe from logs when every craft lands late", async () => {
    const h = createHarness({ inventory: { oak_log: 7 }, craftResultDelay: LAG });
    assert.equal(await h.run(crafter.make, { item: "wooden_pickaxe" }), 1);
    assert.equal(h.count("wooden_pickaxe"), 1);
  });
});

describe("craft.craft on a recipe whose result is also an input", () => {
  const TEMPLATE = { netherite_upgrade_smithing_template: 1, diamond: 7, netherrack: 1 };

  it("does not wait when the net gain (2 templates from 1 is +1) is already in the inventory", async () => {
    const h = createHarness({ inventory: TEMPLATE, blocks: TABLE });
    const start = h.bot.time.age;
    assert.equal(await h.run(craft.craft, { item: "netherite_upgrade_smithing_template" }), 1);
    assert.equal(h.bot.time.age - start, 0, "no sleep");
    assert.equal(h.count("netherite_upgrade_smithing_template"), 2);
  });

  it("stops waiting when the late template lands, not 1500 ms later", async () => {
    const h = createHarness({ inventory: TEMPLATE, blocks: TABLE, craftResultDelay: LAG });
    const start = h.bot.time.age;
    assert.equal(await h.run(craft.craft, { item: "netherite_upgrade_smithing_template" }), 1);
    assert.equal(h.bot.time.age - start, LAG);
  });
});

/** 36 stacks, every slot: a wooden axe's inputs (with some to spare, so neither stack empties) and 34 single items, six of them logs. */
function fullInventory(): Record<string, number> {
  const inventory: Record<string, number> = { oak_planks: 4, stick: 3 };
  const fillers = ["dirt", "cobblestone", "sand", "gravel", "andesite", "diorite", "granite", "oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "stone", "deepslate", "tuff", "calcite", "clay_ball", "flint", "coal", "raw_iron", "raw_copper", "raw_gold", "wheat_seeds", "wheat", "bone", "string", "feather", "leather", "rotten_flesh", "gunpowder", "arrow", "apple", "bread"];
  for (const filler of fillers) inventory[filler] = 1;
  return inventory;
}

describe("craft.craft when the inventory has no room for the result", () => {
  it("fails with InventoryFullError saying the inventory is full, where the item fell, and how to get it back", async () => {
    const h = createHarness({ inventory: fullInventory(), blocks: TABLE, craftResultDelay: LAG });
    const start = h.bot.time.age;
    await assert.rejects(h.run(craft.craft, { item: "wooden_axe" }), (err: Error) => {
      assert.ok(err instanceof InventoryFullError, err.message);
      assert.match(err.message, /^crafted 0 of 1 wooden_axe: the inventory is full, so the 1 wooden_axe crafted fell to the ground near \(0, 64, 0\)/);
      assert.match(err.message, /free a slot \(inventory\.toss an item you can spare\), then pick it up with gatherer\.collectDrops/);
      return true;
    });
    assert.equal(h.bot.time.age - start, LAG, "stops waiting when the axe is on the ground");
    assert.deepEqual(h.entities.filter((e) => e.name === "item").map((e) => `${e.getDroppedItem()?.count} ${e.getDroppedItem()?.name}`), ["1 wooden_axe"]);
  });

  it("makes crafter.make stop at the first axe on the ground, spending no logs on another", async () => {
    const h = createHarness({ inventory: fullInventory(), blocks: TABLE, craftResultDelay: LAG });
    await assert.rejects(h.run(crafter.make, { item: "wooden_axe" }), /the inventory is full, so the 1 wooden_axe crafted fell to the ground/);
    for (const log of ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"]) assert.equal(h.count(log), 1, log);
    assert.deepEqual(h.entities.filter((e) => e.name === "item").map((e) => `${e.getDroppedItem()?.count} ${e.getDroppedItem()?.name}`), ["1 wooden_axe"]);
    assert.deepEqual([h.count("oak_planks"), h.count("stick")], [1, 1], "the inputs of one axe, no more");
  });
});

/** A server that drops the clicks of all but the first `kept` of the crafts bot.craft is asked for. */
function dropClicks(h: Harness, kept: number): void {
  const craftOnServer = h.bot.craft;
  h.bot.craft = async (recipe, times, table) => {
    await craftOnServer(recipe, Math.min(times ?? 1, kept), table);
  };
}

describe("craft.craft when the craft did not happen", () => {
  it("throws 'crafted 0 of <count> <item>' naming the recipe's inputs when the window click was dropped", async () => {
    const h = createHarness({ inventory: { oak_planks: 3, stick: 2 }, blocks: TABLE });
    dropClicks(h, 0);
    await assert.rejects(h.run(craft.craft, { item: "wooden_axe" }), (err: Error) => {
      assert.match(err.message, /crafted 0 of 1 wooden_axe/);
      assert.match(err.message, /inputs: 3 oak_planks, 2 stick|inputs: 2 stick, 3 oak_planks/);
      assert.match(err.message, /crafting table is within reach/);
      return true;
    });
    assert.deepEqual(h.logs, []);
  });

  it("returns what arrived and logs the shortfall when only some of the crafts took effect", async () => {
    const h = createHarness({ inventory: { oak_log: 2 } });
    dropClicks(h, 1);
    assert.equal(await h.run(craft.craft, { item: "oak_planks", count: 8 }), 4);
    assert.deepEqual(h.logs, ["crafted 4 oak_planks, 4 short of the 8 asked for"]);
  });

  it("returns the delta with no shortfall when the recipe makes more than asked for", async () => {
    const h = createHarness({ inventory: { oak_log: 1 } });
    assert.equal(await h.run(craft.craft, { item: "oak_planks", count: 1 }), 4);
    assert.deepEqual(h.logs, ["crafted 4 oak_planks"]);
  });
});
