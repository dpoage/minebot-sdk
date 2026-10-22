import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, type Vec3 } from "minebot-sdk/routine";
import { createHarness, type Harness } from "minebot-sdk/testing";
import { burnTicks, fuelItemsFor, pickFuel, smeltInputs, smeltOutput, withoutReserved } from "../src/mc/smelting.ts";
import { roomFor } from "../src/routines/container.ts";
import * as crafter from "../src/routines/crafter.ts";
import { armorSlotOf, armorTier, canSleep, chooseFood } from "../src/routines/survival.ts";

describe("smelting table", () => {
  it("maps inputs to furnace outputs", () => {
    assert.equal(smeltOutput("raw_iron"), "iron_ingot");
    assert.equal(smeltOutput("minecraft:sand"), "glass");
    assert.equal(smeltOutput("cobblestone"), "stone");
    assert.equal(smeltOutput("beef"), "cooked_beef");
    assert.equal(smeltOutput("oak_log"), "charcoal");
    assert.equal(smeltOutput("stripped_pale_oak_wood"), "charcoal");
    assert.equal(smeltOutput("crimson_stem"), undefined);
    assert.equal(smeltOutput("light_blue_terracotta"), "light_blue_glazed_terracotta");
    assert.equal(smeltOutput("iron_ingot"), undefined);
  });

  it("lists the candidates that smelt into an output", () => {
    const names = ["iron_ore", "raw_iron", "iron_ingot", "sand", "gold_ore", "deepslate_iron_ore"];
    assert.deepEqual(smeltInputs("iron_ingot", names), ["iron_ore", "raw_iron", "deepslate_iron_ore"]);
    assert.deepEqual(smeltInputs("glass", names), ["sand"]);
    assert.deepEqual(smeltInputs("diamond", names), []);
  });
});

describe("fuel", () => {
  it("knows how long fuels burn", () => {
    assert.equal(burnTicks("coal"), 1600);
    assert.equal(burnTicks("charcoal"), 1600);
    assert.equal(burnTicks("oak_planks"), 300);
    assert.equal(burnTicks("birch_log"), 300);
    assert.equal(burnTicks("stick"), 100);
    assert.equal(burnTicks("wooden_pickaxe"), 200);
    assert.equal(burnTicks("crimson_planks"), 0);
    assert.equal(burnTicks("iron_ingot"), 0);
  });

  it("rounds the fuel needed up", () => {
    assert.equal(fuelItemsFor("coal", 3 * 200), 1);
    assert.equal(fuelItemsFor("coal", 9 * 200), 2);
    assert.equal(fuelItemsFor("oak_planks", 2 * 200), 2);
    assert.throws(() => fuelItemsFor("dirt", 200), /not a furnace fuel/);
  });

  it("prefers charcoal and coal, then planks, logs, and sticks", () => {
    assert.deepEqual(pickFuel({ coal: 2, oak_planks: 9 }, 600), { item: "coal", count: 1 });
    assert.deepEqual(pickFuel({ charcoal: 1, coal: 1 }, 200), { item: "charcoal", count: 1 });
    assert.deepEqual(pickFuel({ oak_planks: 9, oak_log: 9 }, 600), { item: "oak_planks", count: 2 });
    assert.deepEqual(pickFuel({ oak_log: 9, stick: 9 }, 400), { item: "oak_log", count: 2 });
    assert.deepEqual(pickFuel({ stick: 9 }, 400), { item: "stick", count: 4 });
  });

  it("skips a fuel the inventory holds too little of", () => {
    assert.deepEqual(pickFuel({ coal: 1, oak_planks: 9 }, 2400), { item: "oak_planks", count: 8 });
    assert.equal(pickFuel({ coal: 1, oak_planks: 2 }, 2400), undefined);
  });

  it("never picks buckets, blocks, tools, or nether planks on its own", () => {
    assert.equal(pickFuel({ lava_bucket: 1, coal_block: 1, wooden_axe: 1, crimson_planks: 9, dirt: 9 }, 200), undefined);
  });

  it("never burns the input it is about to smelt", () => {
    // 10 logs smelting 8 into charcoal: 2 logs left cannot cover 1600 ticks.
    assert.equal(pickFuel(withoutReserved({ oak_log: 10 }, "oak_log", 8), 1600), undefined);
    // 16 logs leave 8, which burn 2400 ticks.
    assert.deepEqual(pickFuel(withoutReserved({ oak_log: 16 }, "oak_log", 8), 1600), { item: "oak_log", count: 6 });
    assert.deepEqual(pickFuel(withoutReserved({ oak_log: 10, coal: 1 }, "oak_log", 8), 1600), { item: "coal", count: 1 });
    assert.deepEqual(withoutReserved({ sand: 3 }, "oak_log", 8), { sand: 3 });
    assert.deepEqual(withoutReserved({ oak_log: 3 }, "oak_log", 8), { oak_log: 0 });
  });

  it("uses a named fuel as given", () => {
    assert.deepEqual(pickFuel({ coal: 5, lava_bucket: 1 }, 2000, "lava_bucket"), { item: "lava_bucket", count: 1 });
    assert.equal(pickFuel({ coal: 5 }, 200, "oak_planks"), undefined);
  });
});

function stack(type: number, count: number): Item {
  return { type, count } as Item;
}

describe("container room", () => {
  it("counts empty slots as whole stacks and partial stacks of the same item", () => {
    assert.equal(roomFor([null, null], 5, 64), 128);
    assert.equal(roomFor([stack(5, 60), stack(6, 3), null], 5, 64), 4 + 64);
    assert.equal(roomFor([stack(5, 64), stack(6, 1)], 5, 64), 0);
    assert.equal(roomFor([undefined, stack(5, 1)], 5, 16), 16 + 15);
  });
});

describe("food", () => {
  const foods = [
    { name: "apple", foodPoints: 4, saturation: 2.4 },
    { name: "bread", foodPoints: 5, saturation: 6 },
    { name: "cooked_beef", foodPoints: 8, saturation: 12.8 },
    { name: "rotten_flesh", foodPoints: 4, saturation: 0.8 },
  ];

  it("picks the food that restores the most without overshooting", () => {
    assert.equal(chooseFood(foods, 20)?.name, "cooked_beef");
    assert.equal(chooseFood(foods, 6)?.name, "bread");
    assert.equal(chooseFood(foods, 4)?.name, "apple");
  });

  it("picks the least wasteful food when all overshoot", () => {
    assert.equal(chooseFood(foods, 1)?.name, "apple");
  });

  it("breaks ties by saturation", () => {
    const tied = [
      { name: "a", foodPoints: 6, saturation: 1 },
      { name: "b", foodPoints: 6, saturation: 9 },
    ];
    assert.equal(chooseFood(tied, 20)?.name, "b");
  });

  it("never picks harmful or special foods on its own", () => {
    for (const name of ["rotten_flesh", "spider_eye", "pufferfish", "poisonous_potato", "chicken", "chorus_fruit", "golden_apple"]) {
      assert.equal(chooseFood([{ name, foodPoints: 4, saturation: 1 }], 20), undefined, name);
    }
  });
});

describe("sleep window", () => {
  it("allows dusk to dawn, and any time in a thunderstorm", () => {
    assert.equal(canSleep(1000, false), false);
    assert.equal(canSleep(12540, false), false);
    assert.equal(canSleep(12541, false), true);
    assert.equal(canSleep(23458, false), true);
    assert.equal(canSleep(23459, false), false);
    assert.equal(canSleep(6000, true), true);
  });
});

describe("armor", () => {
  it("ranks materials and finds slots", () => {
    assert.equal(armorSlotOf("iron_helmet"), "head");
    assert.equal(armorSlotOf("netherite_chestplate"), "torso");
    assert.equal(armorSlotOf("golden_leggings"), "legs");
    assert.equal(armorSlotOf("turtle_helmet"), "head");
    assert.equal(armorSlotOf("elytra"), undefined);
    assert.ok(armorTier("netherite_boots") > armorTier("diamond_boots"));
    assert.ok(armorTier("diamond_boots") > armorTier("iron_boots"));
    assert.ok(armorTier("iron_boots") > armorTier("chainmail_boots"));
    assert.ok(armorTier("chainmail_boots") > armorTier("golden_boots"));
    assert.ok(armorTier("golden_boots") > armorTier("copper_boots"));
    assert.ok(armorTier("copper_boots") > armorTier("leather_boots"));
    assert.equal(armorTier("elytra"), -1);
    assert.equal(armorTier("stick"), -1);
  });
});

/** A harness with a furnace at (1, 64, 3), within reach of the bot's start. */
function smeltingHarness(inventory: Record<string, number>) {
  return createHarness({ inventory, blocks: [{ name: "furnace", at: [1, 64, 3], properties: { lit: false } }] });
}

/** The furnace.smelt calls the crafter made, in order. */
function smelts(h: Harness): { item: string; count: number; at: unknown }[] {
  return h.calls
    .filter((call) => call.kit === "furnace" && call.action === "smelt")
    .map(({ args }) => {
      const { item, count, at } = args as { item: string; count: number; at: Vec3 };
      return { item, count, at: { x: at.x, y: at.y, z: at.z } };
    });
}

describe("crafter.make smelting", () => {
  it("smelts a furnace output from the inputs the inventory holds", async () => {
    const h = smeltingHarness({ raw_iron: 2, iron_ore: 1, coal: 1 });
    assert.equal(await h.run(crafter.make, { item: "iron_ingot", count: 3 }), 3);
    assert.deepEqual(smelts(h), [
      { item: "raw_iron", count: 2, at: { x: 1, y: 64, z: 3 } },
      { item: "iron_ore", count: 1, at: { x: 1, y: 64, z: 3 } },
    ]);
    assert.equal(h.count("iron_ingot"), 3);
  });

  it("smelts only what is missing", async () => {
    const h = smeltingHarness({ raw_iron: 5, iron_ingot: 1, coal: 1 });
    assert.equal(await h.run(crafter.make, { item: "iron_ingot", count: 3 }), 3);
    assert.deepEqual(smelts(h).map((s) => s.count), [2]);
    assert.equal(h.count("raw_iron"), 3);
  });

  it("names the inputs to gather when the inventory holds none", async () => {
    const h = smeltingHarness({});
    await assert.rejects(h.run(crafter.make, { item: "iron_ingot" }), /a furnace makes it from (?=.*\braw_iron\b)(?=.*\biron_ore\b).*, which the inventory lacks/);
    assert.deepEqual(smelts(h), []);
  });

  it("reports an item that nothing makes as one to gather", async () => {
    const h = smeltingHarness({});
    await assert.rejects(h.run(crafter.make, { item: "cobblestone" }), /which cannot be crafted; gather it/);
  });

  it("names the inputs to gather for an item only a furnace makes, when the inventory holds none", async () => {
    const h = smeltingHarness({});
    await assert.rejects(h.run(crafter.make, { item: "glass" }), /need 1 more glass, which a furnace makes from .*\bsand\b.*the inventory holds none of them, gather some/);
    assert.deepEqual(smelts(h), []);
  });
});

describe("crafter.make crafting table", () => {
  it("pays for the table's planks before it makes the ingredients (a wooden pickaxe from 7 logs)", async () => {
    const h = createHarness({ inventory: { oak_log: 7 } });
    assert.equal(await h.run(crafter.make, { item: "wooden_pickaxe" }), 1);
    assert.equal(h.bot.findBlock({ matching: h.bot.registry.blocksByName.crafting_table!.id, maxDistance: 8 })?.name, "crafting_table");
    assert.equal(h.count("crafting_table"), 0);
  });

  it("makes the table from planks it already holds", async () => {
    const h = createHarness({ inventory: { oak_planks: 9 } });
    assert.equal(await h.run(crafter.make, { item: "wooden_pickaxe" }), 1);
    assert.equal(h.bot.findBlock({ matching: h.bot.registry.blocksByName.crafting_table!.id, maxDistance: 8 })?.name, "crafting_table");
  });

  it("fails when the table and the pickaxe together need more logs than it holds", async () => {
    const h = createHarness({ inventory: { oak_log: 1 } });
    await assert.rejects(h.run(crafter.make, { item: "wooden_pickaxe" }), /cannot make 1 wooden_pickaxe/);
  });
});
