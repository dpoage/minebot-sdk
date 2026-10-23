---
title: From stone tools to iron tools
tags: [iron, raw_iron, iron_ingot, smelting, furnace, iron_pickaxe, caves, mining]
verified_by: general knowledge of vanilla Java Edition; not yet checked on 26.1
---

Prerequisites: a stone pickaxe, a crafting table, sticks.

1. **Furnace.** Mine 8 cobblestone and craft a furnace at a table: `ctx.bot.craft(ctx.bot.recipesFor(itemId(ctx, "furnace"), null, 1, table)[0], 1, table)`. The helpers `collect`, `count`, and `itemId` are in `flows/first-day`; each takes `ctx` as its first argument.
2. **Fuel.** Find coal ore (`coal_ore` or `deepslate_coal_ore`) with `bot.findBlocks` and mine it with any pickaxe. Without coal, use planks or logs as fuel. See `mechanics/smelting`.
3. **Iron ore.** Look for `iron_ore` or `deepslate_iron_ore` in exposed cave walls and mountainsides: `bot.findBlocks({ matching: ids, maxDistance: 64, count: 16 })`. Mine it with a stone pickaxe or better; it drops `raw_iron`. See `mechanics/tool-tiers`.
4. **Smelt.** Place the furnace, add fuel, and smelt `raw_iron` into `iron_ingot`. 3 ingots make a pickaxe.
5. **Craft.** `ctx.bot.craft(ctx.bot.recipesFor(itemId(ctx, "iron_pickaxe"), null, 1, table)[0], 1, table)`.

Underground is dark: hostile mobs spawn there at any time of day.

<!-- builtins -->
With built-in routines:

- `minebot call crafter.make --args '{"item":"furnace"}'` crafts the furnace.
- `minebot call sense.find --args '{"blocks":"*coal_ore"}'` and `minebot call sense.find --args '{"blocks":"*iron_ore","radius":32}'` give positions.
- `minebot call explorer.scan --args '{"radius":24}'` lists the ores near you.
- `minebot call furnace.smelt --args '{"item":"raw_iron","count":3}'` smelts at a furnace within 4.5 blocks. It loads coal, charcoal, planks, or logs as fuel, waits 10 seconds per item, and takes the ingots.
- `minebot call crafter.make --args '{"item":"iron_ingot","count":3}'` does the same from anywhere. It finds a furnace within 32 blocks, or places or crafts one (8 cobblestone).
- `minebot call crafter.make --args '{"item":"iron_pickaxe"}'` smelts the ingots it lacks from the `raw_iron` you hold, then crafts the pickaxe.
<!-- /builtins -->
