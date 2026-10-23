---
title: bot.recipesFor has no furnace recipes, so you cannot look up what smelts into what
tags: [smelting, furnace, recipesFor, recipesAll, registry, recipes, cooking, raw_iron, cooked_beef, minecraft-data]
mc_version: "26.1"
verified_by: check program
check: smelting-recipes-missing-from-registry.js
---

## Symptom

`bot.recipesAll(itemId, null, true)` for `iron_ingot` lists only the nugget and block recipes. For `cooked_beef` it returns nothing. There is no way to ask the registry which item smelts into an ingot.

## Cause

The registry (`bot.registry`, minecraft-data) lists crafting recipes only. Smelting, blasting, smoking, campfire cooking, stonecutting, and smithing recipes are missing. The same holds for fuel times.

## Workaround

Use the wiki: the `reference/recipes-*` pages list the furnace, blast furnace, smoker, and campfire recipes per result item (search `iron_ingot recipe`). The common inputs are on `mechanics/smelting`. In code, keep a small map of what you need:

```ts
export default () => {
  const smelts = { raw_iron: "iron_ingot", raw_copper: "copper_ingot", raw_gold: "gold_ingot", beef: "cooked_beef", porkchop: "cooked_porkchop" };
  return smelts;
};
```

<!-- builtins:furnace -->
`minebot call furnace.smelt --args '{"item":"raw_iron","count":3}'` knows the recipes.
<!-- /builtins:furnace -->
<!-- builtins:crafter -->
`minebot call crafter.make --args '{"item":"iron_ingot"}'` smelts when it must.
<!-- /builtins:crafter -->
