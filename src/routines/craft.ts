// The craft routines: crafting at a table that is already within reach. Finding or placing one,
// and crafting intermediate items, is the crafter routines' work on top of this primitive.
import { type Block, defineRoutine, Point, type RoutineContext, z } from "minebot-sdk/routine";

export const description = "Craft items from the inventory at a table within reach.";
export const uses = [] as const;

const TABLE_SEARCH_RADIUS = 4;

function itemId(ctx: RoutineContext, name: string): number {
  const item = ctx.bot.registry.itemsByName[name.replace(/^minecraft:/, "")];
  if (!item) throw new Error(`unknown item "${name}"`);
  return item.id;
}

/** A crafting table within reach, or null when none is nearby. */
function nearbyTable(ctx: RoutineContext): Block | null {
  const tableId = ctx.bot.registry.blocksByName.crafting_table!.id;
  return ctx.bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH_RADIUS });
}

/**
 * Crafts at least `count` more of `name` from what the inventory holds, using a crafting table
 * within reach when the recipe needs one.
 */
async function craftItem(ctx: RoutineContext, name: string, count = 1): Promise<number> {
  const { bot } = ctx;
  const id = itemId(ctx, name);
  let recipe = bot.recipesFor(id, null, count, null)[0];
  let table: Block | null = null;
  if (!recipe) {
    recipe = bot.recipesFor(id, null, count, true)[0];
    if (recipe?.requiresTable) table = nearbyTable(ctx);
    if (recipe?.requiresTable && !table) {
      throw new Error(`crafting ${name} needs a crafting table within ${TABLE_SEARCH_RADIUS} blocks; stand next to one, or place one`);
    }
  }
  if (!recipe) {
    if (bot.recipesAll(id, null, true).length === 0) throw new Error(`${name} cannot be crafted`);
    throw new Error(`not enough ingredients for ${count} ${name}; items.recipes({ item: "${name}" }) lists what it needs`);
  }
  const held = () => bot.inventory.items().filter((i) => i.name === name.replace(/^minecraft:/, "")).reduce((n, i) => n + i.count, 0);
  const before = held();
  await bot.craft(recipe, Math.ceil(count / recipe.result.count), table ?? undefined);
  const made = held() - before;
  ctx.log(`crafted ${made} ${name}`);
  return made;
}

export const craft = defineRoutine(
  {
    name: "craft.craft",
    description: "Craft at least `count` (default 1) more of `item` from the inventory. A recipe that needs a crafting table uses one within 4 blocks, and the call fails when there is none. Returns how many were made.",
    args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.number(),
  },
  (ctx, { item, count }) => craftItem(ctx, item, count),
);

export const table = defineRoutine(
  {
    name: "craft.table",
    description: "The position of a crafting table within 4 blocks, so a routine can stand next to it. Fails when there is none nearby.",
    args: z.object({}),
    returns: Point,
  },
  (ctx) => {
    const table = nearbyTable(ctx);
    if (!table) throw new Error(`no crafting table within ${TABLE_SEARCH_RADIUS} blocks`);
    return table.position;
  },
);
