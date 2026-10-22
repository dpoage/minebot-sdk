---
title: Zombies, skeletons, and strays burn in daylight; spiders, creepers, and husks do not
tags: [burn, fire, daylight, sun, sunrise, zombie, skeleton, stray, husk, helmet, roof, mobs]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

At sunrise, a mob that chased you all night is on fire, or a mob you expected is gone.

## What burns

Observed in daylight, four seconds after each mob spawned (the `Fire` tag was above 0 when it burned):

| Mob | Burns |
| - | - |
| zombie | yes, in the open |
| zombie under a stone roof | no |
| zombie with an iron helmet | no |
| skeleton | yes |
| stray | yes |
| husk | no |
| creeper | no |
| spider | no |

So the sun burns zombies and skeletons only where the sky is open and the head is bare. A roof or a helmet stops it. Creepers and spiders are still there in the morning.

## With Mineflayer

Wait under a roof until the day starts. `bot.time.timeOfDay` wraps from 23999 to 0 at dawn:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext) => {
  while (bot.time.timeOfDay >= 12000) await sleep(1000);
};
```
