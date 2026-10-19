import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import minecraftData from "minecraft-data";
import type { Recipe as RecipeClass } from "prismarine-recipe";
import { Vec3 } from "vec3";
import type { Item, KitContext } from "../src/kit/kit.ts";
import { roomFor } from "../src/kit/kits/container.ts";
import { make } from "../src/kit/kits/crafter.ts";
import { armorSlotOf, armorTier, canSleep, chooseFood } from "../src/kit/kits/survival.ts";
import { burnTicks, fuelItemsFor, pickFuel, smeltInputs, smeltOutput, withoutReserved } from "../src/mc/smelting.ts";

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

/** A crafter context over a fake inventory: crafting recipes absent, one furnace at (1,2,3), smelting 1:1. */
function smeltingContext(held: Record<string, number>, options: { furnace: boolean }) {
  const smelts: { item: string; count: number; at: unknown }[] = [];
  const names = ["iron_ingot", "raw_iron", "iron_ore", "deepslate_iron_ore", "coal", "furnace"];
  const itemsByName = Object.fromEntries(names.map((name, id) => [name, { id, name }]));
  const furnacePos = { x: 1, y: 2, z: 3 };
  const ctx = {
    bot: {
      registry: { itemsByName, items: {}, blocksByName: { furnace: { id: 99 }, crafting_table: { id: 98 } } },
      recipesAll: () => [],
      recipesFor: () => [],
      findBlock: ({ matching }: { matching: number }) => (matching === 99 && options.furnace ? { position: furnacePos } : null),
      blockAt: () => null,
    },
    kits: {
      inventory: { count: ({ items }: { items: string }) => held[items] ?? 0 },
      move: { to: async () => furnacePos },
      furnace: {
        smelt: async ({ item, count, at }: { item: string; count: number; at: unknown }) => {
          smelts.push({ item, count, at });
          held[item] = (held[item] ?? 0) - count;
          held.iron_ingot = (held.iron_ingot ?? 0) + count;
        },
      },
    },
    log: () => {},
    sleep: async () => {},
    signal: new AbortController().signal,
  } as unknown as KitContext;
  return { ctx, smelts };
}

describe("crafter.make smelting", () => {
  it("smelts a furnace output from the inputs the inventory holds", async () => {
    const held = { raw_iron: 2, iron_ore: 1 };
    const { ctx, smelts } = smeltingContext(held, { furnace: true });
    assert.equal(await make(ctx, "iron_ingot", 3), 3);
    assert.deepEqual(smelts, [
      { item: "raw_iron", count: 2, at: { x: 1, y: 2, z: 3 } },
      { item: "iron_ore", count: 1, at: { x: 1, y: 2, z: 3 } },
    ]);
  });

  it("smelts only what is missing", async () => {
    const { ctx, smelts } = smeltingContext({ raw_iron: 5, iron_ingot: 1 }, { furnace: true });
    assert.equal(await make(ctx, "iron_ingot", 3), 3);
    assert.deepEqual(smelts.map((s) => s.count), [2]);
  });

  it("names the inputs to gather when the inventory holds none", async () => {
    const { ctx, smelts } = smeltingContext({}, { furnace: true });
    await assert.rejects(make(ctx, "iron_ingot", 1), /which a furnace makes from raw_iron, iron_ore, deepslate_iron_ore/);
    assert.deepEqual(smelts, []);
  });

  it("reports an item that nothing makes as one to gather", async () => {
    const { ctx } = smeltingContext({}, { furnace: true });
    await assert.rejects(make(ctx, "coal", 1), /which cannot be crafted; gather it/);
  });
});

// prismarine-recipe ships CommonJS with a typing that claims a default export.
const loadRecipes = createRequire(import.meta.url)("prismarine-recipe") as (version: string) => { Recipe: typeof RecipeClass };

/**
 * A crafter context over real 26.1 recipes and a one-block world: stone ground at y 63, air above,
 * no crafting table until the kit places one. The inventory is a name -> count map.
 */
function craftingContext(held: Record<string, number>) {
  const registry = minecraftData("26.1");
  const { Recipe } = loadRecipes("26.1");
  const state = { tablePlaced: false, held: undefined as { name: string } | undefined };
  const ground = new Vec3(0, 63, 0);
  const itemId = (name: string) => registry.itemsByName[name]!.id;
  const nameOf = (id: number) => registry.items[id]!.name;
  const enough = (recipe: RecipeClass, times: number) => recipe.delta.every((d) => (held[nameOf(d.id)] ?? 0) + d.count * times >= 0);
  const bot = {
    registry,
    entity: { position: new Vec3(5, 64, 5) },
    get heldItem() {
      return state.held;
    },
    recipesAll: (id: number, _meta: null, table: boolean) => Recipe.find(id, null).filter((r) => !r.requiresTable || table),
    recipesFor: (id: number, _meta: null, min: number, table: boolean) =>
      Recipe.find(id, null).filter((r) => (!r.requiresTable || table) && enough(r, Math.ceil(min / r.result.count))),
    inventory: { items: () => Object.entries(held).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })) },
    findBlock: () => (state.tablePlaced ? { name: "crafting_table", position: new Vec3(0, 64, 0) } : null),
    findBlocks: () => [ground],
    blockAt: (p: Vec3) => {
      if (p.equals(new Vec3(0, 64, 0)) && state.tablePlaced) return { name: "crafting_table", position: p };
      return p.y === 63 ? { name: "stone", boundingBox: "block", position: p } : { name: "air", position: p };
    },
    equip: async (item: { name: string }) => {
      state.held = item;
    },
    placeBlock: async () => {
      assert.equal(state.held?.name, "crafting_table");
      held.crafting_table = (held.crafting_table ?? 0) - 1;
      state.tablePlaced = true;
    },
  };
  const ctx = {
    bot,
    kits: {
      inventory: { count: ({ items }: { items: string }) => held[items] ?? 0 },
      move: { to: async () => bot.entity.position },
      craft: {
        craft: async ({ item, count }: { item: string; count: number }) => {
          const recipe = Recipe.find(itemId(item), null).find((r) => (!r.requiresTable || state.tablePlaced) && enough(r, Math.ceil(count / r.result.count)));
          if (!recipe) throw new Error(`not enough ingredients for ${count} ${item}`);
          const times = Math.ceil(count / recipe.result.count);
          for (const d of recipe.delta) held[nameOf(d.id)] = (held[nameOf(d.id)] ?? 0) + d.count * times;
        },
      },
    },
    log: () => {},
    sleep: async () => {},
    signal: new AbortController().signal,
  } as unknown as KitContext;
  return { ctx, state };
}

describe("crafter.make crafting table", () => {
  it("pays for the table's planks before it makes the ingredients (a wooden pickaxe from 7 logs)", async () => {
    const held: Record<string, number> = { oak_log: 7 };
    const { ctx, state } = craftingContext(held);
    assert.equal(await make(ctx, "wooden_pickaxe"), 1);
    assert.equal(state.tablePlaced, true);
    assert.equal(held.crafting_table, 0);
  });

  it("makes the table from planks it already holds", async () => {
    const held: Record<string, number> = { oak_planks: 9 };
    const { ctx, state } = craftingContext(held);
    assert.equal(await make(ctx, "wooden_pickaxe"), 1);
    assert.equal(state.tablePlaced, true);
  });

  it("fails when the table and the pickaxe together need more logs than it holds", async () => {
    const { ctx } = craftingContext({ oak_log: 1 });
    await assert.rejects(make(ctx, "wooden_pickaxe"), /cannot make 1 wooden_pickaxe/);
  });
});
