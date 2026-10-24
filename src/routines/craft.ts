// The craft routines: crafting at a table that is already within reach. Finding or placing one,
// and crafting intermediate items, is the crafter routines' work on top of this primitive.
import { type Block, defineRoutine, Point, type RoutineContext, z } from "minebot-sdk/routine";

export const description = "Craft items from the inventory at a table within reach.";
export const uses = [] as const;

const TABLE_SEARCH_RADIUS = 4;
/** The result of a table craft reaches the inventory after bot.craft resolves; how often to look, and how long without an inventory update means it is not coming. */
const SETTLE_POLL_MS = 50;
const SETTLE_QUIET_MS = 1500;

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
 * Waits for the inventory to settle after a craft: until `held()` reaches `target`, or `SETTLE_QUIET_MS`
 * pass with no inventory slot update (each update restarts the wait). Time is counted in sleep steps,
 * so a call that finds the result already there does not sleep at all.
 */
async function settle(ctx: RoutineContext, held: () => number, target: number): Promise<void> {
  const { inventory } = ctx.bot;
  let updates = 0;
  const onUpdate = () => {
    updates++;
  };
  inventory.on("updateSlot", onUpdate);
  try {
    let seen = 0;
    let quiet = 0;
    while (held() < target && quiet < SETTLE_QUIET_MS) {
      await ctx.sleep(SETTLE_POLL_MS);
      if (updates !== seen) {
        seen = updates;
        quiet = 0;
      } else quiet += SETTLE_POLL_MS;
    }
  } finally {
    inventory.off("updateSlot", onUpdate);
  }
}

/**
 * Crafts at least `count` more of `name` from what the inventory holds, using a crafting table
 * within reach when the recipe needs one. Returns what the inventory gained once it has settled;
 * fails when that is nothing.
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
  const times = Math.ceil(count / recipe.result.count);
  await bot.craft(recipe, times, table ?? undefined);
  await settle(ctx, held, before + recipe.result.count * times);
  const made = held() - before;
  if (made <= 0) {
    const inputs = recipe.delta
      .filter((d) => d.count < 0)
      .map((d) => `${-d.count * times} ${bot.registry.items[d.id]?.name ?? `#${d.id}`}`)
      .join(", ");
    throw new Error(
      `crafted 0 of ${count} ${name}: the result never reached the inventory (inputs: ${inputs}); check that the inventory still holds the inputs${table ? " and the crafting table is within reach" : ""}, then call again`,
    );
  }
  ctx.log(made < count ? `crafted ${made} ${name}, ${count - made} short of the ${count} asked for` : `crafted ${made} ${name}`);
  return made;
}

export const craft = defineRoutine(
  {
    name: "craft.craft",
    description: "Craft at least `count` (default 1) more of `item` from the inventory. A recipe that needs a crafting table uses one within 4 blocks, and the call fails when there is none. Returns how many the inventory gained once the result settled, and fails when that is none (the error names the recipe's inputs).",
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
