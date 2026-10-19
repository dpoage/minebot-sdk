---
title: Basic crafting recipes and grid sizes
tags: [crafting, recipe, recipes, planks, sticks, crafting_table, tools, furnace, chest, torch]
mc_version: "26.1"
verified_by: check program
check: crafting-basics.js
---

The inventory has a 2x2 crafting grid. A crafting table gives a 3x3 grid.

| Result | Ingredients | Grid |
| - | - | - |
| 4 planks | 1 log (any wood type gives that type's planks) | 2x2 |
| 4 sticks | 2 planks | 2x2 |
| crafting table | 4 planks | 2x2 |
| 4 torches | 1 coal or charcoal + 1 stick | 2x2 |
| pickaxe | 3 head material + 2 sticks | 3x3 |
| axe | 3 head material + 2 sticks | 3x3 |
| shovel | 1 head material + 2 sticks | 3x3 |
| sword | 2 head material + 1 stick | 3x3 |
| furnace | 8 cobblestone | 3x3 |
| chest | 8 planks | 3x3 |

Head material: planks (wooden), cobblestone (stone), copper ingots (copper), iron ingots, gold ingots (golden), diamonds. Netherite tools are not crafted: a smithing table upgrades a diamond tool (search `netherite_pickaxe recipe`).

A wooden pickaxe from nothing needs 3 logs: 12 planks covers the table (4), sticks (2), and the head (3).

The full list of recipes is in the `reference/recipes-*` pages; search for `<item> recipe`.

See `quirks/table-recipes-need-the-table-block` and `quirks/recipes-list-every-wood-variant` before calling `bot.craft` directly.
