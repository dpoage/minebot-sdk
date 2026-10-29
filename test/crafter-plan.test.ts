import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smeltOutput } from "minebot-sdk/routine";
import { createHarness } from "minebot-sdk/testing";
import * as crafter from "../src/routines/crafter.ts";
import * as items from "../src/routines/items.ts";

type Inventory = Record<string, number>;

/** Where the crafting table stands, as blocks of the harness: none, 20 blocks away (inside make's 32-block search), or 40 (outside it). */
const STATIONS = { none: [], "20": [{ name: "crafting_table", at: [20, 64, 0] }], "40": [{ name: "crafting_table", at: [40, 64, 0] }] } as const;

/** The harness the plan and the make run in: flat ground, `inventory` in the bag, the table where `station` says. */
function world(inventory: Inventory, station: keyof typeof STATIONS) {
  return createHarness({ inventory, blocks: [...STATIONS[station]] });
}

async function planOf(inventory: Inventory, station: keyof typeof STATIONS, item: string, count?: number) {
  return world(inventory, station).run(crafter.plan, count === undefined ? { item } : { item, count });
}

function add(inventory: Inventory, more: Inventory): Inventory {
  const sum = { ...inventory };
  for (const [name, n] of Object.entries(more)) sum[name] = (sum[name] ?? 0) + n;
  return sum;
}

describe("items.recipes returns every variant (P1)", () => {
  it("lists one summary per recipe the registry has, in its order, with no cut", async () => {
    const h = createHarness();
    for (const item of ["stick", "wooden_pickaxe", "stone_pickaxe", "iron_ingot", "crafting_table", "white_bed"]) {
      const all = h.bot.recipesAll(h.bot.registry.itemsByName[item]!.id, null, true);
      const listed = await h.run(items.recipes, { item });
      assert.equal(listed.length, all.length, item);
      assert.deepEqual(
        listed.map((r) => r.ingredients),
        all.map((r) => Object.fromEntries(r.delta.filter((d) => d.count < 0).map((d) => [h.bot.registry.items[d.id]!.name, -d.count]))),
        `${item} in order`,
      );
    }
    assert.equal((await h.run(items.recipes, { item: "stick" })).length, 13);
    const pickaxe = (await h.run(items.recipes, { item: "stone_pickaxe" })).flatMap((r) => Object.keys(r.ingredients));
    for (const stone of ["cobblestone", "blackstone", "cobbled_deepslate"]) assert.ok(pickaxe.includes(stone), `stone_pickaxe lists ${stone}`);
  });
});

describe("crafter.plan changes nothing (P2)", () => {
  it("leaves the inventory, position, held item, window, goal, world, and routine calls as they were", async () => {
    const h = world({ oak_log: 5, raw_iron: 3, cobblestone: 8, stick: 2 }, "20");
    await h.bot.equip(h.bot.inventory.items().find((i) => i.name === "stick")!, "hand");
    const snapshot = () => ({
      inventory: { ...h.inventory },
      position: h.position.toString(),
      held: h.bot.heldItem?.name,
      window: h.bot.currentWindow,
      goal: h.bot.pathfinder.goal,
      stations: ["crafting_table", "furnace"].map((block) => h.bot.findBlocks({ matching: h.bot.registry.blocksByName[block]!.id, maxDistance: 64, count: 10 }).map(String)),
    });
    const before = snapshot();
    const plan = await h.run(crafter.plan, { item: "iron_pickaxe" });
    assert.deepEqual(plan.missing, {});
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(
      h.calls.map((c) => `${c.kit}.${c.action}`),
      ["crafter.plan"],
      "no routine ran under it: nothing moved, placed, crafted, or smelted",
    );
  });
});

/** The goals the closing property is checked for. */
const GOALS = ["stick", "crafting_table", "wooden_pickaxe", "stone_pickaxe", "furnace", "torch", "iron_ingot", "iron_pickaxe", "chest", "bucket", "lantern"];
const INVENTORIES: Record<string, Inventory> = {
  empty: {},
  "1 log": { oak_log: 1 },
  "3 logs": { oak_log: 3 },
  "stone and a cobblestone": { cobblestone: 1, stone: 10, stick: 2 },
};

describe("crafter.plan agrees with crafter.make (P3)", () => {
  for (const station of Object.keys(STATIONS) as (keyof typeof STATIONS)[]) {
    for (const [label, inventory] of Object.entries(INVENTORIES)) {
      it(`for every goal, make succeeds once the plan's missing is added and the plan then names nothing: ${label}, table ${station}`, async () => {
        for (const goal of GOALS) {
          const { missing } = await planOf(inventory, station, goal);
          const stocked = add(inventory, missing);
          assert.deepEqual((await planOf(stocked, station, goal)).missing, {}, `${goal}: the plan on ${JSON.stringify(stocked)} is empty before the make`);
          const h = world(stocked, station);
          assert.ok((await h.run(crafter.make, { item: goal })) >= 1, `${goal} made from ${JSON.stringify(stocked)}`);
          assert.equal(h.count(goal) >= 1, true, `${goal} held`);
        }
      });
    }
  }

  it("names the exact row: an iron_ingot from one log with a table 20 blocks away needs one raw_iron and 8 cobblestone, the log being its fuel", async () => {
    const plan = await planOf({ oak_log: 1 }, "20", "iron_ingot");
    assert.deepEqual(plan.missing, { raw_iron: 1, cobblestone: 8 });
    assert.deepEqual(plan.alternatives.cobblestone, ["cobbled_deepslate", "blackstone"]);
  });

  it("counts a log once: a crafting table, 2 sticks, and fuel for 3 ingots out of 3 logs leave one log short", async () => {
    const plan = await planOf({ oak_log: 3 }, "none", "iron_pickaxe");
    assert.equal(plan.missing.oak_log, 1);
    assert.equal(plan.missing.coal, undefined, "the logs burn, no coal");
  });

  it("sends a table 40 blocks away to its own logs: make searches 32 blocks", async () => {
    assert.deepEqual((await planOf({}, "40", "wooden_pickaxe")).missing, (await planOf({}, "none", "wooden_pickaxe")).missing);
    assert.notDeepEqual((await planOf({}, "20", "wooden_pickaxe")).missing, (await planOf({}, "none", "wooden_pickaxe")).missing);
  });
});

describe("crafter.make burns no fuel a later step needs (P4.3)", () => {
  /** The stations the property names: a crafting table and a furnace within reach. */
  const NEAR = [
    { name: "crafting_table", at: [3, 64, 0] as const },
    { name: "furnace", at: [4, 64, 0] as const },
  ];

  /** A harness with `inventory` in the bag and `blocks` in the world. */
  const bench = (inventory: Inventory, blocks: readonly { name: string; at: readonly [number, number, number] }[] = []) => createHarness({ inventory, blocks: blocks.map((block) => ({ name: block.name, at: block.at })) });

  it("makes the iron_pickaxe from a {raw_iron:3, oak_log:3} inventory, with the fuel the plan names added", async () => {
    const start: Inventory = { raw_iron: 3, oak_log: 3 };
    const { missing } = await bench(start, NEAR).run(crafter.plan, { item: "iron_pickaxe" });
    const stocked = add(start, missing);
    assert.deepEqual((await bench(stocked, NEAR).run(crafter.plan, { item: "iron_pickaxe" })).missing, {}, "the plan is complete before the make");
    const h = bench(stocked, NEAR);
    assert.equal(await h.run(crafter.make, { item: "iron_pickaxe" }), 1, `made from ${JSON.stringify(stocked)}`);
    assert.equal(h.count("iron_pickaxe"), 1);
  });

  it("makes the composter from four logs, a goal the plan calls complete", async () => {
    const start: Inventory = { oak_log: 4 };
    const plan = await bench(start).run(crafter.plan, { item: "composter" });
    assert.deepEqual(plan.missing, {}, "the plan names nothing for four logs");
    assert.equal(await bench(start).run(crafter.make, { item: "composter" }), 1, "make reached a recipe the plan reached");
  });

  it("keeps the planks for the table and names the coal: iron_bars from iron, two cherry logs and four oak planks", async () => {
    const start: Inventory = { raw_iron: 6, cherry_log: 2, oak_planks: 4, cobblestone: 16, stone: 4 };
    const blocks = [{ name: "furnace", at: [4, 64, 0] as const }];
    // The four oak planks are the fuel six ingots need; the table can come from a cherry log instead.
    const plan = await bench(start, blocks).run(crafter.plan, { item: "iron_bars" });
    assert.deepEqual(plan.missing, { coal: 1 }, "the plan must not count as fuel what the table consumes");
    const h = bench(add(start, plan.missing), blocks);
    assert.ok((await h.run(crafter.make, { item: "iron_bars" })) >= 1);
  });

  it("burns the coal and not the one log: iron_shovel from one ingot, one log and one coal", async () => {
    // The make of an inventory the plan calls complete must not burn as fuel the only wood the sticks
    // need: a shovel is one iron ingot and two sticks, and the coal covers the ingot's smelt.
    const start: Inventory = { cobblestone: 6, raw_iron: 1, coal: 1, oak_log: 1 };
    const plan = await bench(start, NEAR).run(crafter.plan, { item: "iron_shovel" });
    assert.deepEqual(plan.missing, {}, "the plan names nothing for this inventory");
    const h = bench(start, NEAR);
    assert.equal(await h.run(crafter.make, { item: "iron_shovel" }), 1);
    assert.equal(h.count("iron_shovel"), 1);
    assert.equal(h.count("coal"), 0, "the coal is the fuel");
    assert.equal(h.count("oak_log"), 0, "the log became the shovel's sticks");
  });
});

describe("crafter.plan names the raw material, never the ore or the rare variant (P4)", () => {
  it("Rivet's case: stone and sticks with a table 20 blocks away need 3 cobblestone, and stone is never counted", async () => {
    const plan = await planOf({ stone: 10, stick: 2 }, "20", "stone_pickaxe");
    assert.deepEqual(plan.missing, { cobblestone: 3 });
    assert.equal(plan.have, 0);
    assert.ok(plan.alternatives.cobblestone!.includes("cobbled_deepslate"));
    assert.ok(plan.alternatives.cobblestone!.includes("blackstone"));
  });

  it("from nothing names oak_log for the wooden pickaxe and no ore for any goal", async () => {
    assert.equal((await planOf({}, "20", "wooden_pickaxe")).missing.oak_log, 2);
    const wood = (await planOf({}, "none", "wooden_pickaxe")).missing;
    assert.deepEqual(Object.keys(wood), ["oak_log"]);
    for (const goal of GOALS) {
      const { missing } = await planOf({}, "none", goal);
      for (const item of Object.keys(missing)) assert.ok(!item.endsWith("_ore"), `${goal} names ${item}`);
    }
    assert.ok("raw_iron" in (await planOf({}, "none", "iron_ingot")).missing);
  });

  it("spends the ore it holds and never asks for one", async () => {
    assert.deepEqual((await planOf({ iron_ore: 1, cobblestone: 8, oak_log: 1 }, "20", "iron_ingot")).missing, {});
    assert.deepEqual((await planOf({}, "20", "coal")).missing, { coal: 1 });
    assert.deepEqual((await planOf({ coal_ore: 1, cobblestone: 8 }, "20", "furnace")).missing, {});
  });
});

describe("crafter.plan's raw materials: the storage rule", () => {
  const raw = async (item: string, inventory: Inventory = {}) => (await planOf(inventory, "20", item)).missing;

  it("makes an iron_ingot by smelting, never from nuggets or a block", async () => {
    assert.deepEqual(await raw("iron_ingot"), { raw_iron: 1, cobblestone: 8, coal: 1 });
  });
  it("keeps the 9 ingots of an iron_block, and fuels 9 smelts with 2 coal: a plank does not cover the step", async () => {
    assert.deepEqual(await raw("iron_block"), { raw_iron: 9, cobblestone: 8, coal: 2 });
    assert.deepEqual(await raw("iron_block", { oak_planks: 1 }), { raw_iron: 9, cobblestone: 8, coal: 2 });
  });
  it("keeps the iron_nugget of a lantern, made from an ingot", async () => {
    const lantern = await raw("lantern");
    assert.equal(lantern.raw_iron, 1);
    assert.ok(!("iron_ingot" in lantern) && !("iron_nugget" in lantern) && !("iron_block" in lantern));
  });
  it("treats raw_iron and coal as raw, and keeps the 9 coal of a coal_block", async () => {
    assert.deepEqual(await raw("raw_iron"), { raw_iron: 1 });
    assert.deepEqual(await raw("coal"), { coal: 1 });
    assert.deepEqual(await raw("coal_block"), { coal: 9 });
  });
  it("keeps the bone of bone_meal and excludes the bone_block recipe", async () => {
    assert.deepEqual(await raw("bone_meal"), { bone: 1 });
    assert.deepEqual(await raw("bone_block"), { bone: 3 });
  });
  it("makes planks from oak_log and sticks from planks", async () => {
    assert.deepEqual(await raw("oak_planks"), { oak_log: 1 });
    assert.deepEqual(await raw("stick"), { oak_log: 1 });
  });
});

describe("crafter.plan reports what it is asked about", () => {
  it("returns the item, the count asked, and what the inventory holds", async () => {
    const plan = await planOf({ oak_planks: 6 }, "none", "oak_planks", 5);
    assert.deepEqual(plan, { item: "oak_planks", count: 5, have: 6, missing: {}, alternatives: {} });
  });
  it("names what a bigger count needs and fails for an unknown item", async () => {
    assert.deepEqual((await planOf({ oak_log: 1 }, "none", "oak_planks", 9)).missing, { oak_log: 2 });
    await assert.rejects(planOf({}, "none", "no_such_item"), /unknown item "no_such_item"/);
  });
});

describe("crafter.plan answers for every item (P5)", () => {
  it("returns for every registry item that crafts or smelts, on an empty inventory, each within 500 ms", { timeout: 120_000 }, async () => {
    const h = createHarness();
    const covered = Object.keys(h.bot.registry.itemsByName)
      .sort()
      .filter((name) => h.bot.recipesAll(h.bot.registry.itemsByName[name]!.id, null, true).length > 0 || smeltOutput(name) !== undefined);
    assert.ok(covered.length > 100, `covered only ${covered.length} items`);
    let max = 0;
    let slowest = "";
    for (const name of covered) {
      const started = performance.now();
      const plan = await h.run(crafter.plan, { item: name });
      const took = performance.now() - started;
      assert.equal(plan.item, name);
      assert.ok(took < 500, `${name} took ${took.toFixed(1)} ms`);
      if (took > max) {
        max = took;
        slowest = name;
      }
    }
    console.log(`P5: ${covered.length} items, slowest ${slowest} at ${max.toFixed(1)} ms`);
  });
});
