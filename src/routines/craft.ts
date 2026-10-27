// The craft routines: crafting at a table that is already within reach. Finding or placing one,
// and crafting intermediate items, is the crafter routines' work on top of this primitive.
import { type Block, defineRoutine, Point, type RoutineContext, z } from "minebot-sdk/routine";

export const description = "Craft items from the inventory at a table within reach.";
export const uses = [] as const;

const TABLE_SEARCH_RADIUS = 4;
/** The result of a table craft reaches the inventory after bot.craft resolves; how often to look, and how long without an inventory update means it is not coming. */
const SETTLE_POLL_MS = 50;
const SETTLE_QUIET_MS = 1500;
/** The main grid plus the hotbar: the slots a crafting result can enter. */
const INVENTORY_SLOTS = 36;

/** The crafted items did not fit in the inventory and fell at the bot's feet: free a slot and pick them up, rather than crafting again. */
export class InventoryFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryFullError";
  }
}

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

/**
 * How many of the crafted item the `times` crafts can fit in the inventory, computed before they run.
 * Stacks of items the recipe neither uses nor makes never move, so they take the slots they take.
 * The recipe's own items are modelled packed: Mineflayer picks an input stack up whole and puts what is
 * left back onto a partial stack first, and the result likewise joins partial stacks before an empty slot:
 * each craft consumes its inputs (a stack may empty, which frees a slot), then the crafted item takes
 * room on its partial stack or an empty slot, then any other output (a bucket left over) does.
 */
function roomFor(ctx: RoutineContext, recipe: { delta: readonly { id: number; count: number }[] }, resultId: number, times: number): number {
  const { bot } = ctx;
  const size = (type: number) => bot.registry.items[type]?.stackSize ?? 64;
  const involved = new Set(recipe.delta.map((d) => d.id));
  let fixed = 0;
  const counts = new Map<number, number>();
  for (const stack of bot.inventory.items()) {
    if (involved.has(stack.type)) counts.set(stack.type, (counts.get(stack.type) ?? 0) + stack.count);
    else fixed++;
  }
  const slots = () => {
    let used = fixed;
    for (const [type, count] of counts) used += Math.ceil(count / size(type));
    return used;
  };
  let room = 0;
  for (let craft = 0; craft < times; craft++) {
    for (const d of recipe.delta) {
      if (d.count < 0) counts.set(d.id, Math.max(0, (counts.get(d.id) ?? 0) + d.count));
    }
    const outputs = [...recipe.delta].filter((d) => d.count > 0).sort((a, b) => Number(b.id === resultId) - Number(a.id === resultId));
    for (const d of outputs) {
      const have = counts.get(d.id) ?? 0;
      const partial = have % size(d.id) === 0 ? 0 : size(d.id) - (have % size(d.id));
      const empty = Math.max(0, INVENTORY_SLOTS - slots()) * size(d.id);
      // Another output is placed regardless (what does not fit falls): what it takes is room the next craft's item no longer has.
      const fits = d.id === resultId ? Math.min(d.count, partial + empty) : d.count;
      counts.set(d.id, have + fits);
      if (d.id === resultId) room += fits;
    }
  }
  return room;
}

/**
 * Closes a window still open from earlier code (a crafting table or chest the bot opened and left),
 * and says so. With another window open, a craft's inventory updates never arrive and it times out
 * after 20 s ("Event updateSlot:0 did not fire"). Closing copies the window's inventory slots back
 * into the inventory, so call it before the inventory is read.
 */
async function closeStrayWindow(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const stray = bot.currentWindow;
  if (!stray) return;
  const type = stray.type.toString().replace(/^minecraft:/, "").replace(/^crafting$/, "crafting_table");
  await bot.closeWindow(stray);
  ctx.log(`closed the open ${type} window first`);
}

/**
 * Crafts at least `count` more of `name` from what the inventory holds, using a crafting table
 * within reach when the recipe needs one. Returns what the inventory gained once it has settled;
 * fails when that is nothing, with an InventoryFullError when the inventory had no room for the result.
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
  await closeStrayWindow(ctx);
  const item = name.replace(/^minecraft:/, "");
  const held = () => bot.inventory.items().filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);
  const times = Math.ceil(count / recipe.result.count);
  // What the crafts add to the inventory: a recipe whose result is also an input (a smithing template makes 2 from 1) adds the difference.
  const gain = times * recipe.delta.filter((d) => d.id === id).reduce((n, d) => n + d.count, 0);
  // Where an item Mineflayer tosses for want of room lands: at the bot's feet.
  const feet = `(${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`;
  const room = roomFor(ctx, recipe, id, times);
  const before = held();
  await bot.craft(recipe, times, table ?? undefined);
  await settle(ctx, () => held() - before >= gain);
  const made = held() - before;
  if (made <= 0 && room === 0) {
    throw new InventoryFullError(
      `crafted 0 of ${count} ${name}: the inventory is full, so the ${gain} ${item} the recipe makes fell at the bot's feet near ${feet} and the inputs are used; free a slot (inventory.toss an item you can spare), then pick them up with gatherer.collectDrops or by walking over that spot, instead of crafting again`,
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
  const overflow = room < gain && made < count ? `; the inventory is full, so the rest fell at the bot's feet near ${feet}: free a slot, then pick it up with gatherer.collectDrops` : "";
  ctx.log(`crafted ${made} ${name}${short}${overflow}`);
  return made;
}

export const craft = defineRoutine(
  {
    name: "craft.craft",
    description: "Craft at least `count` (default 1) more of `item` from the inventory. A window left open (a crafting table or chest) is closed before the craft runs. A recipe that needs a crafting table uses one within 4 blocks, and the call fails when there is none. Returns how many the inventory gained once the result settled, and fails when that is none: when the inventory has no room for the result, the error says it fell at the bot's feet and how to recover it, and otherwise the error names the recipe's inputs.",
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
