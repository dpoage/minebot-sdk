// The crafter routines: plan recipe chains and make sure a crafting table or a furnace is there to
// craft and smelt them at — built from the move, sense, place, inventory, craft, items, and
// furnace primitives.
import { type Block, defineRoutine, isAir, type RoutineContext, smeltInputs, Vec3, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as inventory from "minebot-sdk/routines/inventory";
import * as craft from "minebot-sdk/routines/craft";
import * as furnace from "minebot-sdk/routines/furnace";

export const description = "Craft and smelt item chains from the inventory, finding or placing a crafting table or furnace when needed.";
export const uses = ["move", "sense", "place", "inventory", "craft", "items", "furnace"] as const;

const MAX_MAKE_DEPTH = 4;
const TABLE_SEARCH_RADIUS = 32;
const FURNACE_SEARCH_RADIUS = 32;

function countOf(ctx: RoutineContext, name: string): Promise<number> {
  return inventory.count(ctx, { items: name });
}

function itemId(ctx: RoutineContext, name: string): number {
  const item = ctx.bot.registry.itemsByName[name.replace(/^minecraft:/, "")];
  if (!item) throw new Error(`unknown item "${name}"`);
  return item.id;
}

/** Holds `name` from the inventory, confirming the hand actually changed. */
async function holdItem(ctx: RoutineContext, name: string): Promise<void> {
  const { bot } = ctx;
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new Error(`no ${name} in inventory`);
    await bot.equip(item, "hand");
    if (bot.heldItem?.name === name) return;
    await ctx.sleep(250);
  }
  throw new Error(`could not hold the ${name}`);
}

/** Places a `name` block (crafting_table or furnace) from the inventory on open natural ground within 8 blocks. */
async function placeNearby(ctx: RoutineContext, name: string): Promise<Block> {
  const { bot } = ctx;
  const blockId = bot.registry.blocksByName[name]!.id;
  const nearby = bot.findBlock({ matching: blockId, maxDistance: 4 });
  if (nearby) return nearby;
  if ((await countOf(ctx, name)) === 0) throw new Error(`no ${name} in inventory`);
  // Only air is safe: thin blocks such as leaf_litter have no collision box, but the server
  // does not replace them, so placing into them fails.
  const free = (b: Block | null) => b !== null && isAir(b);
  // Solid, non-tree ground with room for the block and a player beside it.
  const grounds = bot
    .findBlocks({
      matching: (b: Block) => b.boundingBox === "block" && !/_leaves$|_log$/.test(b.name),
      maxDistance: 8,
      count: 200,
    })
    .filter((p) => free(bot.blockAt(p.offset(0, 1, 0))) && free(bot.blockAt(p.offset(0, 2, 0))))
    .filter((p) => !bot.entity.position.floored().equals(p.offset(0, 1, 0)));
  for (const groundPos of grounds.slice(0, 8)) {
    const spot = groundPos.offset(0, 1, 0);
    try {
      await holdItem(ctx, name);
      await bot.placeBlock(bot.blockAt(groundPos)!, new Vec3(0, 1, 0));
      const placed = bot.blockAt(spot);
      if (placed?.name === name) return placed;
    } catch (err) {
      ctx.log(`placeNearby: ${spot} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`found no open ground within 8 blocks to place a ${name}; move to flat ground and retry`);
}

/**
 * A crafting table within reach: an existing one nearby, else one placed (and made if needed,
 * from planks the inventory holds or the logs it holds). Callers that go on to make ingredients
 * ensure the table first: its 4 planks would otherwise come out of the ingredients' planks.
 */
async function ensureTable(ctx: RoutineContext, depth: number): Promise<Block> {
  const { bot } = ctx;
  const tableId = bot.registry.blocksByName.crafting_table!.id;
  const near = bot.findBlock({ matching: tableId, maxDistance: 4 });
  if (near) return near;
  const known = bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH_RADIUS });
  if (known) {
    await move.to(ctx, { position: known.position, range: 2, timeoutMs: 30_000 });
    return bot.blockAt(known.position) ?? known;
  }
  if ((await countOf(ctx, "crafting_table")) === 0) await makeItem(ctx, "crafting_table", 1, depth + 1);
  return placeNearby(ctx, "crafting_table");
}

/** A furnace to smelt at: an existing one within 32 blocks, else one placed from the inventory, else one crafted from cobblestone. */
async function ensureFurnace(ctx: RoutineContext, depth: number): Promise<Block> {
  const { bot } = ctx;
  const furnaceId = bot.registry.blocksByName.furnace!.id;
  const near = bot.findBlock({ matching: furnaceId, maxDistance: 4 });
  if (near) return near;
  const known = bot.findBlock({ matching: furnaceId, maxDistance: FURNACE_SEARCH_RADIUS });
  if (known) {
    await move.to(ctx, { position: known.position, range: 2, timeoutMs: 30_000 });
    return bot.blockAt(known.position) ?? known;
  }
  if ((await countOf(ctx, "furnace")) === 0) await makeItem(ctx, "furnace", 1, depth + 1);
  return placeNearby(ctx, "furnace");
}

/** The held items that smelt into `name`, most plentiful first. */
async function heldSmeltInputs(ctx: RoutineContext, name: string): Promise<{ input: string; count: number }[]> {
  const held = await Promise.all(smeltInputs(name, Object.keys(ctx.bot.registry.itemsByName)).map(async (input) => ({ input, count: await countOf(ctx, input) })));
  return held.filter((h) => h.count > 0).sort((a, b) => b.count - a.count);
}

/**
 * Smelts up to `missing` of `name` from the inputs the inventory holds, one smelt per input
 * kind, at a furnace it finds, places, or crafts. Smelting is one item for one item.
 */
async function smeltMissing(ctx: RoutineContext, name: string, missing: number, depth: number): Promise<void> {
  let left = missing;
  for (const { input, count } of await heldSmeltInputs(ctx, name)) {
    if (left <= 0) return;
    const n = Math.min(left, count);
    const block = await ensureFurnace(ctx, depth);
    await furnace.smelt(ctx, { item: input, count: n, at: block.position });
    left -= n;
  }
}

/**
 * Makes sure the inventory holds at least `count` of `name`: smelting it from inputs the
 * inventory holds when it is a furnace output, and crafting missing intermediate items
 * recursively from what the inventory holds. Does not gather raw materials.
 */
export async function makeItem(ctx: RoutineContext, name: string, count = 1, depth = 0): Promise<number> {
  const { bot } = ctx;
  const have = await countOf(ctx, name);
  if (have >= count) return have;
  const id = itemId(ctx, name);
  const failures: string[] = [];
  // Smelting first: a smelted item such as iron_ingot also has a crafting recipe (from nuggets or a block) that the inventory rarely satisfies.
  const smeltable = smeltInputs(name, Object.keys(bot.registry.itemsByName));
  if (smeltable.length > 0 && (await heldSmeltInputs(ctx, name)).length > 0) {
    try {
      await smeltMissing(ctx, name, count - have, depth);
      if ((await countOf(ctx, name)) >= count) return countOf(ctx, name);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  const recipes = bot.recipesAll(id, null, true);
  if (recipes.length === 0) {
    if (smeltable.length === 0) throw new Error(`need ${count - have} more ${name}, which cannot be crafted; gather it`);
    // An input that is itself a furnace output (stone for smooth_stone) can be smelted in turn.
    if (depth < MAX_MAKE_DEPTH && failures.length === 0) {
      for (const input of smeltable.filter((i) => smeltInputs(i, Object.keys(bot.registry.itemsByName)).length > 0)) {
        try {
          await makeItem(ctx, input, count - (await countOf(ctx, name)), depth + 1);
          await smeltMissing(ctx, name, count - (await countOf(ctx, name)), depth);
          if ((await countOf(ctx, name)) >= count) return countOf(ctx, name);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    const reason = failures.length > 0 ? `: ${[...new Set(failures)].slice(0, 3).join("; ")}` : `; the inventory holds none of them, gather some`;
    throw new Error(`need ${count - (await countOf(ctx, name))} more ${name}, which a furnace makes from ${smeltable.slice(0, 4).join(", ")}${reason}`);
  }
  if (depth >= MAX_MAKE_DEPTH) throw new Error(`gave up making ${name}: recipe chain deeper than ${MAX_MAKE_DEPTH}`);
  // Tagged ingredients expand to one recipe per variant (oak planks, birch planks, ...).
  // Try first the recipes whose ingredients the inventory holds or can craft directly.
  const ranked = (
    await Promise.all(
      recipes.map(async (recipe) => {
        const times = Math.ceil((count - have) / recipe.result.count);
        let shortfall = 0;
        for (const d of recipe.delta) {
          if (d.count >= 0) continue;
          const ingredient = bot.registry.items[d.id]?.name ?? `#${d.id}`;
          const missing = -d.count * times - (await countOf(ctx, ingredient));
          if (missing <= 0) continue;
          const smeltHeld = (await heldSmeltInputs(ctx, ingredient)).reduce((n, held) => n + held.count, 0);
          shortfall += bot.recipesFor(d.id, null, missing, true).length > 0 || smeltHeld >= missing ? 1 : 10 + missing;
        }
        return { recipe, times, shortfall };
      }),
    )
  ).sort((a, b) => a.shortfall - b.shortfall);
  for (const { recipe, times } of ranked.slice(0, 4)) {
    try {
      const ingredients = recipe.delta
        .filter((d) => d.count < 0)
        .map((d) => ({ name: bot.registry.items[d.id]?.name ?? `#${d.id}`, need: -d.count * times }));
      // The table comes first: making it uses planks, and making the ingredients first would
      // leave it short of the planks they used (a wooden pickaxe from 7 logs needs 3 + 2 + 4 planks).
      if (recipe.requiresTable) await ensureTable(ctx, depth);
      // Making one ingredient can consume another (sticks use planks), so repeat until all are present at once.
      for (let pass = 0; pass < 3; pass++) {
        const short: typeof ingredients = [];
        for (const i of ingredients) if ((await countOf(ctx, i.name)) < i.need) short.push(i);
        if (short.length === 0) break;
        for (const i of short) await makeItem(ctx, i.name, i.need, depth + 1);
      }
      // Making ingredients can walk away from the table (to a furnace), so bring it back within reach.
      if (recipe.requiresTable) await ensureTable(ctx, depth);
      await craft.craft(ctx, { item: name, count: count - (await countOf(ctx, name)) });
      return countOf(ctx, name);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  const hint = smeltable.length > 0 && (await heldSmeltInputs(ctx, name)).length === 0 ? `a furnace makes it from ${smeltable.slice(0, 3).join(", ")}, which the inventory lacks; ` : "";
  throw new Error(`cannot make ${count} ${name}: ${hint}${[...new Set(failures)].slice(0, 3).join("; ")}`);
}

export const make = defineRoutine(
  {
    name: "crafter.make",
    description: "Make sure the inventory holds at least `count` (default 1) of `item`, crafting intermediate items (planks, sticks, tables) as needed and finding or placing a crafting table. An item that a furnace makes (iron_ingot, glass, stone, charcoal, cooked food) is smelted from the matching input the inventory holds, at a furnace within 32 blocks, else one placed from the inventory, else one crafted from 8 cobblestone; fuel is coal, charcoal, planks, or logs from the inventory. Fails with the missing raw material, which you must gather. Returns the count held.",
    args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.number(),
  },
  (ctx, { item, count }) => makeItem(ctx, item, count),
);
