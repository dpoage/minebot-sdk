---
title: Recipe lists contain one recipe per wood type
tags: [craft, recipes, recipesAll, recipesFor, planks, sticks, missing ingredient]
mc_version: "26.1"
verified_by: check program
check: recipes-list-every-wood-variant.js
---

## Symptom

You pick `bot.recipesAll(id, null, true)[0]` for a wooden tool, and crafting fails with `missing ingredient`, or the recipe asks for `cherry_planks` or `bamboo_planks` that you do not have.

## Cause

Minecraft recipes accept "any planks". Mineflayer expands such a recipe into one recipe per wood type. The first entry is often a wood type you do not hold.

## Workaround

Use `bot.recipesFor(itemId, null, count, table)`. It returns only the recipes that the current inventory can craft:

```ts
import { Vec3 } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default ({ bot }: RoutineContext, { x, y, z }: { x: number; y: number; z: number }) => {
  const craftingTableBlock = bot.blockAt(new Vec3(x, y, z));
  const id = bot.registry.itemsByName.wooden_pickaxe!.id;
  const recipe = bot.recipesFor(id, null, 1, craftingTableBlock)[0]; // undefined if you lack ingredients
  return recipe ?? null;
};
```

<!-- builtins -->
`minebot call crafter.make --args '{"item":"wooden_pickaxe"}'` picks a recipe that matches your inventory and crafts missing planks and sticks first.
<!-- /builtins -->
