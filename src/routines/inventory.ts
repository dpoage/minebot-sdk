// The inventory routines: what the player carries, holding it, and handing it over.
import { defineRoutine, nameMatcher, NamePattern, type RoutineContext, z } from "minebot-sdk/routine";

export const description = "Count and list what the inventory holds, equip an item, and toss items out.";
export const uses = [] as const;

function countItems(ctx: RoutineContext, pattern: NamePattern): number {
  const matches = nameMatcher(pattern);
  return ctx.bot.inventory
    .items()
    .filter((i) => matches(i.name))
    .reduce((n, i) => n + i.count, 0);
}

function inventoryTotals(ctx: RoutineContext): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of ctx.bot.inventory.items()) totals[item.name] = (totals[item.name] ?? 0) + item.count;
  return totals;
}

export const list = defineRoutine(
  {
    name: "inventory.list",
    description: "Inventory totals by item name, e.g. { oak_log: 3, stick: 12 }.",
    args: z.object({}),
    returns: z.record(z.string(), z.number()),
  },
  (ctx) => inventoryTotals(ctx),
);

export const count = defineRoutine(
  {
    name: "inventory.count",
    description: "How many items matching `items` ('stick', '*_log', or a list) the inventory holds.",
    args: z.object({ items: NamePattern }),
    returns: z.number(),
  },
  (ctx, { items }) => countItems(ctx, items),
);

export const equip = defineRoutine(
  {
    name: "inventory.equip",
    description: "Hold or wear an item from the inventory. `slot`: 'hand' (default), 'off-hand', 'head', 'torso', 'legs', 'feet'.",
    args: z.object({ item: z.string().min(1), slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).default("hand") }),
    returns: z.void(),
  },
  async (ctx, { item, slot }) => {
    const found = ctx.bot.inventory.items().find((i) => i.name === item.replace(/^minecraft:/, ""));
    if (!found) throw new Error(`no ${item} in inventory`);
    await ctx.bot.equip(found, slot);
  },
);

export const toss = defineRoutine(
  {
    name: "inventory.toss",
    description: "Toss `count` of `item` out of the inventory (a tossed stack lands about two blocks away).",
    args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.void(),
  },
  async (ctx, { item, count }) => {
    const id = ctx.bot.registry.itemsByName[item.replace(/^minecraft:/, "")]?.id;
    if (id === undefined) throw new Error(`unknown item "${item}"`);
    await ctx.bot.toss(id, null, count);
  },
);
