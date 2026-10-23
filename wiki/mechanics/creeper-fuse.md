---
title: Creepers explode 1.5 seconds after they get within 3 blocks
tags: [creeper, explosion, fuse, hiss, gunpowder, blast, mobs, danger, death, flee]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

The bot loses most of its health, or dies, in one moment with no fight. A creeper was next to it.

## What happens

A creeper walks to the player. When it is within about 3 blocks it starts to swell, and it explodes 1.5 seconds later (30 ticks). Observed: the swell began at 2.7 blocks, and the creeper was gone 1.45 seconds after.

Damage of one explosion to a player with full health, no armor, on Normal difficulty:

| Distance | Health left |
| - | - |
| 1 block | dead |
| 3 blocks | 6 of 20 |
| 5 blocks | 18 of 20 |
| 7 blocks | 20 of 20 |

So one creeper is deadly inside 3 blocks and harmless beyond 6. Armor lowers the damage (`mechanics/armor-tiers`). A creeper drops 0 to 2 gunpowder.

## With Mineflayer

Find creepers before they are close, and keep your distance:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext) => {
  const creeper = bot.nearestEntity((e) => e.name === "creeper");
  if (creeper && creeper.position.distanceTo(bot.entity.position) < 8) {
    // Run directly away from it.
    const away = bot.entity.position.minus(creeper.position);
    await bot.lookAt(bot.entity.position.plus(away), true);
    bot.setControlState("forward", true);
    bot.setControlState("sprint", true);
    await sleep(1500);
    bot.clearControlStates();
  }
};
```

A sprinting bot outruns a creeper: starting 4 blocks away, it was 9, 12, and 14 blocks away after 1, 2, and 3 seconds.

<!-- builtins -->
`minebot call combat.retreat --args '{"from":123,"distance":8}'` runs away from it. `from` is the creeper's entity id.
<!-- /builtins -->
