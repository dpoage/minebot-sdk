---
title: Smelting with a furnace
tags: [furnace, smelt, smelting, fuel, coal, charcoal, raw_iron, iron_ingot, cooking, blast_furnace, smoker, openFurnace, burn time]
mc_version: "26.1"
verified_by: check program; furnace times and fuel values read from the 26.1 dev server, 2026-10-19
check: smelting.js
---

A furnace turns raw metal into ingots, cooks food, and turns logs into charcoal. You need an input, a fuel, and time.

## Time

Observed on the dev server:

| Station | Per item |
| - | - |
| furnace | 10 seconds |
| blast furnace | 5 seconds |
| smoker | 5 seconds |

A blast furnace takes ores and metal gear, and a smoker takes food: raw iron went through a blast furnace in 5 seconds per item, raw beef through a smoker in 5. A campfire cooks food with no fuel, at 30 seconds per item, according to the recipe data. The recipe of every item is in `reference/recipes-*`; search `iron_ingot recipe`.

## Fuel

One fuel item burns for a number of ticks, and a furnace smelts one item per 200 ticks. Read from a lit furnace:

| Fuel | Items smelted per fuel item |
| - | - |
| lava_bucket | 100 |
| coal_block | 80 |
| dried_kelp_block | 20 |
| blaze_rod | 12 |
| coal, charcoal | 8 |
| log, planks, crafting_table | 1.5 |
| wooden tool | 1 |
| stick, sapling, wool | 0.5 |
| bamboo | 0.25 |

Charcoal burns as long as coal does. A log smelts into charcoal, so a bot with no coal can make fuel: smelt logs with planks or logs as fuel.

Common inputs: `raw_iron` to `iron_ingot`, `raw_copper` to `copper_ingot`, `raw_gold` to `gold_ingot`, a log to `charcoal`, raw meat to cooked meat, `cobblestone` to `stone`. Tags such as `#logs_that_burn` are listed in `reference/item-tags`. The registry has none of these recipes: see `quirks/smelting-recipes-missing-from-registry`.

## With Mineflayer

Stand within reach of the furnace, open it, put in fuel and input, and wait. Observed with 2 raw iron and 1 coal:

```js
const block = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 6 });
const furnace = await bot.openFurnace(block);
await furnace.putFuel(bot.registry.itemsByName.coal.id, null, 1);
await furnace.putInput(bot.registry.itemsByName.raw_iron.id, null, 2);
await sleep(21000);                      // 2 items x 10 s, plus a margin
const ingots = await furnace.takeOutput(); // the whole output stack, or null
furnace.close();
```

`furnace.fuel` and `furnace.progress` run from 0 to 1 while it burns, and `furnace.on("update", ...)` fires about three times a second. `furnace.outputItem()` shows the output stack. `takeOutput()` took the 3 ingots that were already in the output and the 2 new ones in one call (5 in all). The ingots show up in `bot.inventory` after you close the window and wait a moment (`quirks/inventory-lags-while-a-window-is-open`).

A furnace keeps smelting while you walk away, so you can start it and do other work. Come back and take the output.

<!-- kits -->
`kit.furnace.smelt({ item: "raw_iron", count: 3 })` finds a furnace, loads fuel and input, waits, and takes the output. `kit.furnace.take()` collects what a furnace finished while you were away.
<!-- /kits -->
