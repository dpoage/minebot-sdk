---
title: Crops grow in stages; plant seeds on farmland and harvest at the last stage
tags: [farming, crop, wheat, carrots, potatoes, beetroot, nether_wart, seeds, age, harvest, plant, grow, stages]
mc_version: "26.1"
verified_by: check program; planting and harvesting run on the 26.1 dev server, 2026-10-19
check: crop-growth.js
---

## Stages

A crop block has an `age` state. It grows one stage at a time, on random ticks. The last stage is the ripe one.

| Crop | Stages (`age`) | Ripe at | Plant |
| - | - | - | - |
| wheat | 0 to 7 | 7 | `wheat_seeds` on farmland |
| carrots | 0 to 7 | 7 | a `carrot` on farmland |
| potatoes | 0 to 7 | 7 | a `potato` on farmland |
| beetroots | 0 to 3 | 3 | `beetroot_seeds` on farmland |
| nether_wart | 0 to 3 | 3 | a `nether_wart` on soul sand |

Read the stage of a crop block:

```js
const crop = bot.blockAt(position);
const ripe = Number(crop.getProperties().age) === (crop.name === "beetroots" || crop.name === "nether_wart" ? 3 : 7);
```

## Plant and harvest

The ground must be farmland (`mechanics/farmland-hydration`). Place the seed on its top face:

```js
await bot.equip(bot.inventory.items().find((i) => i.name === "wheat_seeds"), "hand");
await bot.placeBlock(bot.blockAt(farmlandPosition), new Vec3(0, 1, 0));
```

Dig the crop to harvest it. Observed on wheat:

| Stage when broken | Drops |
| - | - |
| 7 (ripe) | 1 `wheat` and some `wheat_seeds` (one try gave 1 wheat and 3 seeds) |
| 0 | 1 `wheat_seeds`, no wheat |

Breaking a crop early loses the harvest, so dig only at the ripe stage. Replant with the seeds the crop dropped. Bone meal speeds growth (`mechanics/bonemeal`). A full wheat plot, step by step: `flows/grow-wheat`.

<!-- builtins -->
`kit.farm.plant({ at, seed: "wheat_seeds" })` plants one seed. `kit.farm.harvest({ radius: 8, replant: true })` harvests every ripe crop in reach and replants it.
<!-- /builtins -->
