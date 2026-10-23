---
title: Beds skip the night and set your spawn point
tags: [bed, sleep, spawn, respawn, night, wake, bot.sleep, spawn point, set spawn, skip night]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Sleep rules

- A bed works only at night: `bot.time.timeOfDay` from 12541 to 23458, or in a thunderstorm. In the daytime `bot.sleep` throws `it's not night and it's not a thunderstorm` (observed at `timeOfDay` 118).
- No hostile mob may be near the bed. Observed: a zombie 6 blocks away made `bot.sleep` throw `there are monsters nearby`. See `quirks/bed-monsters-nearby`.
- You must be near the bed, or `bot.sleep` throws `the bed is too far`.

Sleeping sets your spawn point. Observed: after the bot slept in a bed at (12010, 100, 8), the server stored the respawn position (12011, 100, 8), the head of the bed. After a death the bot comes back there.

In the test the night ended within seconds of the bot going to bed: `timeOfDay` went from 16320 to 18 (other bodies on the server may have been in bed too). The default rule is that every player in the world must sleep.

## With Mineflayer

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext) => {
  const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 })!;
  await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
  await bot.sleep(bed);          // resolves when you are in bed
  // ... the night passes, or you want to get up early ...
  const woke = new Promise<void>((resolve) => bot.once("wake", () => resolve()));
  bot._client.write("entity_action", { entityId: bot.entity.id, actionId: "stop_sleeping", jumpBoost: 0 });
  await Promise.race([woke, sleep(3000)]);
};
```

Do not use `bot.wake()`: on 26.1 it does nothing (`quirks/bot-wake-does-not-leave-the-bed`). Observed: when the night ended, the server got the bot out of bed at dawn on its own (`isSleeping` was false at `timeOfDay` 118).

A bed is 3 wool of one color above 3 planks of one kind. Search `white_bed recipe` for the grid. A bed and a shelter together make the first night safe: `flows/first-night-shelter`.

<!-- builtins:survival -->
`minebot call survival.sleep` goes to the nearest bed and sleeps. `minebot call survival.sleep --args '{"at":[10,64,5]}'` uses the bed at that position. `minebot call survival.wake` gets up.
<!-- /builtins:survival -->
