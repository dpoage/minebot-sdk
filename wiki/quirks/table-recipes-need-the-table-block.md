---
title: 3x3 recipes need the crafting table block
tags: [craft, crafting_table, recipesFor, requiresTable, 3x3, pickaxe, tools]
mc_version: "26.1"
verified_by: check program
check: table-recipes-need-the-table-block.js
---

## Symptom

`bot.recipesFor(id, null, 1, null)` returns an empty list for a pickaxe, even though you hold the planks and sticks.

## Cause

The inventory has a 2x2 crafting grid. Recipes that need a 3x3 grid (`requiresTable: true`) are hidden unless you pass a crafting table. Tools, furnaces, and chests all need a table.

## Workaround

Place a crafting table, stand within reach of it, and pass the table block to both calls:

```js
const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 });
const recipe = bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id, null, 1, table)[0];
await bot.craft(recipe, 1, table);
```

<!-- builtins -->
`kit.craft` and `kit.make` (crafter kit) find, place, or craft a table when a recipe needs one.
<!-- /builtins -->
