---
title: bot.wake() does not get the player out of bed
tags: [sleep, bed, wake, isSleeping, entity_action, stop_sleeping, night]
mc_version: "26.1"
verified_by: observed on the dev server, 2026-10-19 (after bot.sleep, bot.wake() left bot.isSleeping true and fired no wake event; the stop_sleeping packet woke the player)
---

## Symptom

`await bot.sleep(bed)` works at night. Then `await bot.wake()` returns without an error, but `bot.isSleeping` stays `true`, the `wake` event never fires, and the player stays in bed until the server wakes it at dawn.

## Cause

Mineflayer 4.39 writes the `entity_action` packet with `actionId: 2`. In the 26.1 protocol `0` is `stop_sleeping` and `2` is `stop_sprinting`, so the server ignores the request.

## Workaround

Send the packet with the right action and wait for the event:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext) => {
  if (!bot.isSleeping) throw new Error("not sleeping");
  const woke = new Promise<void>((resolve) => bot.once("wake", () => resolve()));
  bot._client.write("entity_action", { entityId: bot.entity.id, actionId: "stop_sleeping", jumpBoost: 0 });
  await Promise.race([woke, sleep(3000)]);
  return bot.isSleeping;
};
```

`bot.sleep(bed)` itself is fine. It throws `it's not night and it's not a thunderstorm` in daylight (night is `timeOfDay` 12541 to 23458), and `there are monsters nearby` when a hostile mob is within about 8 blocks of the bed.

<!-- builtins:survival -->
`minebot call survival.sleep` walks to the nearest bed within 16 blocks and sleeps. `minebot call survival.wake` sends the right packet.
<!-- /builtins:survival -->
