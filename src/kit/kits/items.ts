// The items kit: item knowledge — recipes, and the item drops lying on the ground.
import { z } from "zod";
import { action, defineKit, type KitContext } from "../kit.ts";

function itemId(ctx: KitContext, name: string): number {
  const item = ctx.bot.registry.itemsByName[name.replace(/^minecraft:/, "")];
  if (!item) throw new Error(`unknown item "${name}"`);
  return item.id;
}

/** One way to craft an item, as agents see it. */
export interface RecipeSummary {
  makes: number;
  requiresTable: boolean;
  ingredients: Record<string, number>;
}

function summarize(ctx: KitContext, recipe: { delta: { id: number; count: number }[]; result: { count: number }; requiresTable: boolean }): RecipeSummary {
  const ingredients: Record<string, number> = {};
  for (const d of recipe.delta) {
    if (d.count < 0) ingredients[ctx.bot.registry.items[d.id]?.name ?? `#${d.id}`] = -d.count;
  }
  return { makes: recipe.result.count, requiresTable: recipe.requiresTable, ingredients };
}

/** Positions of dropped items within `radius`, nearest first. */
export function droppedItems(ctx: KitContext, radius: number) {
  return Object.values(ctx.bot.entities)
    .filter((e) => e.name === "item" && e.position.distanceTo(ctx.bot.entity.position) < radius)
    .sort((a, b) => a.position.distanceTo(ctx.bot.entity.position) - b.position.distanceTo(ctx.bot.entity.position))
    .map((e) => e.position.floored());
}

export const items = defineKit({
  name: "items",
  description: "Look up recipes, and find the items lying on the ground.",
  uses: [],
  actions: {
    recipes: action({
      doc: "Up to 3 recipes for `item`: [{ makes, requiresTable, ingredients: { name: count } }]. Fails for an unknown item.",
      args: z.object({ item: z.string().min(1) }),
      run: (ctx, { item }): RecipeSummary[] => ctx.bot.recipesAll(itemId(ctx, item), null, true).slice(0, 3).map((r) => summarize(ctx, r)),
    }),
    drops: action({
      doc: "Positions ({x,y,z}) of dropped item entities within `radius`, nearest first — what a dig has left to pick up.",
      args: z.object({ radius: z.number().positive().default(8) }),
      run: (ctx, { radius }) => droppedItems(ctx, radius),
    }),
  },
});
