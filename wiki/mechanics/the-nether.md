---
title: "The Nether: how to get there, how to tell where you are, and what lives near a fortress"
tags: [nether, the_nether, dimension, portal, fortress, piglin, zombified_piglin, wither_skeleton, strider, magma_cube, netherrack, danger]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Getting there

Build a portal (`flows/build-nether-portal`). Standing in it for about 4 seconds sends you across.

`bot.game.dimension` tells you where you are: `"overworld"`, or `"the_nether"` in the Nether. Your position scales by 8: the bot entered at x = 12021 and came out near x = 1496. Moving 8 blocks in the Overworld is moving 1 block in the Nether, so a portal in the Nether is a short way to a far place in the Overworld.

Observed in the Nether: `bot.time.timeOfDay` was 0, so `bot.time` does not tell you whether it is day.

## Fortresses

A fortress is a big structure of `nether_bricks`. Find one by looking for the bricks as you explore:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default ({ bot }: RoutineContext) => {
  const bricks = bot.findBlocks({ matching: bot.registry.blocksByName.nether_bricks!.id, maxDistance: 32, count: 5 });
  const spawners = bot.findBlocks({ matching: bot.registry.blocksByName.spawner!.id, maxDistance: 64, count: 10 });
  return { bricks, spawners };
};
```

Observed at a fortress at about (-640, 57, 624) in the Nether: 2 `spawner` blocks within 64 blocks, and both held blazes. Blazes are what you come for (`mechanics/blazes-and-fortresses`).

## Who lives there

Entities in range at that fortress (about 8 chunks around the bot):

| Mob | Count |
| - | - |
| zombified_piglin | 29 |
| skeleton | 14 |
| piglin | 11 |
| wither_skeleton | 8 |
| blaze | 4 |
| strider | 4 |
| magma_cube | 4 |
| enderman | 3 |

Fighting: `mechanics/combat-basics`. What each mob drops: `reference/mobs-hostile` and `reference/mobs-passive`.

Go in with armor (`mechanics/armor-tiers`), a stack of cobblestone to bridge or wall off, and food (`mechanics/food-sources`). Place a block between you and any lava you see (`mechanics/water-and-lava`).
