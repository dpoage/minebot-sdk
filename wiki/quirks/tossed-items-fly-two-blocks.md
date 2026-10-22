---
title: Tossed items fly about two blocks
tags: [toss, give, trade, items, drop]
mc_version: "26.1"
verified_by: observed on the dev server, 2026-10-18 (a toss from 2 blocks away missed; from 1 block, aimed at the feet, the recipient got all items)
---

## Symptom

You `bot.toss` items toward another player, and they land behind the player or out of reach.

## Workaround

Walk within one block of the recipient, look at their feet, then toss:

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext, { name, itemId, count }: { name: string; itemId: number; count: number }) => {
  const target = bot.players[name]!.entity;
  await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
  await bot.lookAt(target.position.offset(0, 0.2, 0), true);
  await bot.toss(itemId, null, count);
};
```

<!-- builtins -->
`minebot call social.give --args '{"player":"alice","item":"cobblestone","count":8}'` does this.
<!-- /builtins -->
