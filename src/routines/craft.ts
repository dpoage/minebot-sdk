// The craft routines: crafting at a table that is already within reach. Finding or placing one,
// and crafting intermediate items, is the crafter routines' work on top of this primitive.
import { type Block, defineRoutine, Point, type RoutineContext, type Vec3, z } from "minebot-sdk/routine";

export const description = "Craft items from the inventory at a table within reach.";
export const uses = [] as const;

const TABLE_SEARCH_RADIUS = 4;
/** The result of a table craft reaches the inventory after bot.craft resolves; how often to look, and how long without an inventory update means it is not coming. */
const SETTLE_POLL_MS = 50;
const SETTLE_QUIET_MS = 1500;
/** Mineflayer tosses a crafted item that finds no room in the inventory; a new item entity of it this close to the bot is that item. */
const DROP_RADIUS = 8;

/** The crafted items did not fit in the inventory and lie on the ground near the bot: free a slot and pick them up, rather than crafting again. */
export class InventoryFullError extends Error {}

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
 * Waits for the inventory to settle after a craft: until `settled()` holds, or `SETTLE_QUIET_MS`
 * pass with no inventory slot update (each update restarts the wait). Time is counted in sleep steps,
 * so a call that finds the result already there does not sleep at all.
 */
async function settle(ctx: RoutineContext, settled: () => boolean): Promise<void> {
  const { inventory } = ctx.bot;
  let updates = 0;
  const onUpdate = () => {
    updates++;
  };
  inventory.on("updateSlot", onUpdate);
  try {
    let seen = 0;
    let quiet = 0;
    while (!settled() && quiet < SETTLE_QUIET_MS) {
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

/** The item entities within `DROP_RADIUS` of the bot that hold item `type` and are not among `known`: crafted items Mineflayer tossed for want of room. */
function newDrops(ctx: RoutineContext, type: number, known: ReadonlySet<number>): { count: number; position: Vec3 }[] {
  const { bot } = ctx;
  const drops: { count: number; position: Vec3 }[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity.name !== "item" || known.has(entity.id) || entity.position.distanceTo(bot.entity.position) > DROP_RADIUS) continue;
    const stack = entity.getDroppedItem();
    if (stack?.type === type) drops.push({ count: stack.count, position: entity.position });
  }
  return drops;
}

/**
 * Crafts at least `count` more of `name` from what the inventory holds, using a crafting table
 * within reach when the recipe needs one. Returns what the inventory gained once it has settled;
 * fails when that is nothing, with an InventoryFullError when the crafted items fell to the ground.
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
  const item = name.replace(/^minecraft:/, "");
  const held = () => bot.inventory.items().filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);
  const times = Math.ceil(count / recipe.result.count);
  // What the crafts add to the inventory: a recipe whose result is also an input (a smithing template makes 2 from 1) adds the difference.
  const gain = times * recipe.delta.filter((d) => d.id === id).reduce((n, d) => n + d.count, 0);
  const known = new Set(Object.values(bot.entities).map((e) => e.id));
  const before = held();
  await bot.craft(recipe, times, table ?? undefined);
  await settle(ctx, () => held() - before + newDrops(ctx, id, known).reduce((n, d) => n + d.count, 0) >= gain);
  const made = held() - before;
  const drops = newDrops(ctx, id, known);
  const lost = drops.reduce((n, d) => n + d.count, 0);
  const at = drops[0] && `(${Math.floor(drops[0].position.x)}, ${Math.floor(drops[0].position.y)}, ${Math.floor(drops[0].position.z)})`;
  if (made <= 0 && lost > 0) {
    throw new InventoryFullError(
      `crafted 0 of ${count} ${name}: the inventory is full, so the ${lost} ${item} crafted fell to the ground near ${at}, and the inputs are used up; free a slot (inventory.toss an item you can spare), then pick it up with gatherer.collectDrops or by walking onto it, instead of crafting again`,
    );
  }
  if (made <= 0) {
    const inputs = recipe.delta
      .filter((d) => d.count < 0)
      .map((d) => `${-d.count * times} ${bot.registry.items[d.id]?.name ?? `#${d.id}`}`)
      .join(", ");
    throw new Error(
      `crafted 0 of ${count} ${name}: nothing reached the inventory within 1.5 s of its last update (inputs: ${inputs}); the server may only be slow, so before gathering the inputs again, check inventory.count({ items: "${item}" }) and look for it on the ground; if it is not there and the inventory still holds the inputs${table ? " and the crafting table is within reach" : ""}, call again`,
    );
  }
  const short = made < count ? `, ${count - made} short of the ${count} asked for` : "";
  const spilled = lost > 0 ? `; the inventory is full, so ${lost} more fell to the ground near ${at}: free a slot, then pick them up with gatherer.collectDrops` : "";
  ctx.log(`crafted ${made} ${name}${short}${spilled}`);
  return made;
}

export const craft = defineRoutine(
  {
    name: "craft.craft",
    description: "Craft at least `count` (default 1) more of `item` from the inventory. A recipe that needs a crafting table uses one within 4 blocks, and the call fails when there is none. Returns how many the inventory gained once the result settled, and fails when that is none: the error says where the items fell when the inventory had no room for them, and otherwise names the recipe's inputs.",
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
