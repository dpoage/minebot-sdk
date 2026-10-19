// The inventory kit: what the player carries, holding it, and handing it over.
import { z } from "zod";
import { action, defineKit, type KitContext, NamePattern, nameMatcher } from "../kit.ts";

export function countItems(ctx: KitContext, pattern: NamePattern): number {
  const matches = nameMatcher(pattern);
  return ctx.bot.inventory
    .items()
    .filter((i) => matches(i.name))
    .reduce((n, i) => n + i.count, 0);
}

export function inventoryTotals(ctx: KitContext): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of ctx.bot.inventory.items()) totals[item.name] = (totals[item.name] ?? 0) + item.count;
  return totals;
}

export const inventory = defineKit({
  name: "inventory",
  description: "Count and list what the inventory holds, equip an item, and toss items out.",
  uses: [],
  actions: {
    list: action({
      doc: "Inventory totals by item name, e.g. { oak_log: 3, stick: 12 }.",
      args: z.object({}),
      run: (ctx) => inventoryTotals(ctx),
    }),
    count: action({
      doc: "How many items matching `items` ('stick', '*_log', or a list) the inventory holds.",
      args: z.object({ items: NamePattern }),
      run: (ctx, { items }) => countItems(ctx, items),
    }),
    equip: action({
      doc: "Hold or wear an item from the inventory. `slot`: 'hand' (default), 'off-hand', 'head', 'torso', 'legs', 'feet'. Returns nothing.",
      args: z.object({ item: z.string().min(1), slot: z.enum(["hand", "off-hand", "head", "torso", "legs", "feet"]).default("hand") }),
      run: async (ctx, { item, slot }) => {
        const found = ctx.bot.inventory.items().find((i) => i.name === item.replace(/^minecraft:/, ""));
        if (!found) throw new Error(`no ${item} in inventory`);
        await ctx.bot.equip(found, slot);
      },
    }),
    toss: action({
      doc: "Toss `count` of `item` out of the inventory (a tossed stack lands about two blocks away). Returns nothing.",
      args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
      run: async (ctx, { item, count }) => {
        const id = ctx.bot.registry.itemsByName[item.replace(/^minecraft:/, "")]?.id;
        if (id === undefined) throw new Error(`unknown item "${item}"`);
        await ctx.bot.toss(id, null, count);
      },
    }),
  },
});
