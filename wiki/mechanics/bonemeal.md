---
title: Bone meal grows a crop by 2 to 5 stages per use
tags: [bonemeal, bone_meal, fertilizer, farming, grow, crop, wheat, bone, skeleton, composter]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

Hold `bone_meal` and use it on a crop. Observed on wheat planted at age 0:

| Use | Age before | Age after |
| - | - | - |
| 1 | 0 | 5 |
| 2 | 5 | 7 (ripe) |
| 3 and later | 7 | 7, and no bone meal was used up |

```js
await bot.equip(bot.inventory.items().find((i) => i.name === "bone_meal"), "hand");
await bot.activateBlock(bot.blockAt(cropPosition));
await sleep(300);
```

Check the new age before the next use: `Number(bot.blockAt(cropPosition).getProperties().age)` (see `quirks/block-properties-are-strings`). A ripe crop does not take bone meal.

Bone meal comes from bones: one `bone` makes 3 `bone_meal`. Skeletons, strays, and bogged drop bones; search the wiki for `bone drops`.
