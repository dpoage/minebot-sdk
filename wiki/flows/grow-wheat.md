---
title: "Grow wheat: water, farmland, seeds, bone meal, harvest"
tags: [farming, wheat, bread, seeds, farmland, hoe, water, bone_meal, harvest, plan, food]
mc_version: "26.1"
verified_by: every step ran on the 26.1 dev server, 2026-10-19
---

You need a hoe, seeds, and a bucket of water. A hoe is 2 head material and 2 sticks; search `wooden_hoe recipe` for the grid.

1. **Water.** Pick flat dirt or grass. Empty a water bucket on a block in the middle (`mechanics/buckets`). Every farmland block must be within 4 blocks of the water (`mechanics/farmland-hydration`).
2. **Till.** Hoe the dirt around the water, within 4 blocks. Each use turns one dirt block into farmland.

   ```js
   await bot.equip(bot.inventory.items().find((i) => i.name.endsWith("_hoe")), "hand");
   for (const p of dirtBlocks) {
     await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3));
     await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0));
   }
   ```
3. **Plant.** Hold the seeds and place one on the top face of each farmland block.

   ```js
   await bot.equip(bot.inventory.items().find((i) => i.name === "wheat_seeds"), "hand");
   await bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0));
   ```
4. **Bone meal** (optional). Use it on each crop until its `age` is 7 (`mechanics/bonemeal`). Two uses took a new plant from age 0 to 7 in the test. Without it, the crops grow on their own.
5. **Harvest** each crop whose `Number(getProperties().age)` is 7, then plant a seed in its place (`mechanics/crop-growth`). A ripe plant gave 1 wheat and some seeds.
6. **Bread.** Craft 3 wheat in a row on a crafting table: 5 food points each (`mechanics/food-sources`).

Check the inventory after each step: `bot.inventory.items()`.

<!-- builtins -->
`kit.farm.till({ at })`, `kit.farm.plant({ at, seed: "wheat_seeds" })`, and `kit.farm.harvest({ radius: 8, replant: true })` do steps 2, 3, and 5.
<!-- /builtins -->
