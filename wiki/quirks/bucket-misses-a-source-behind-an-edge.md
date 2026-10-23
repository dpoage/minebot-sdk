---
title: An empty bucket does not fill from a water or lava source that sits behind a block's edge
tags: [bucket, water, lava, fluid, fill, activateItem, lookAt, line of sight]
mc_version: "26.1"
verified_by: observed 2026-10-19 (lava source one block below the grass, player 3 blocks away; aiming at the block middle did nothing, aiming at its surface filled the bucket)
---

## Symptom

`bot.activateItem()` with an empty `bucket` in hand does nothing. No `water_bucket` or `lava_bucket` appears, and there is no error. The source is within reach, and `bot.lookAt(source.offset(0.5, 0.5, 0.5))` faces it.

## Cause

The server fills the bucket from the fluid that the look ray reaches before it reaches a solid block. When the source lies one block below the ground and the player stands 3 blocks away at eye height, the ray to the middle of the source clips the side of the ground block next to it. The ray ends on that block, so no fluid is taken. From 2 blocks away the same aim worked.

A source block is 8/9 of a block deep. Aim just below its surface instead, where the ray enters from above:

## Workaround

```ts
import { Vec3 } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext) => {
  const source = new Vec3(3997, 68, 9);
  await bot.equip(bot.inventory.items().find((i) => i.name === "bucket")!, "hand");
  await bot.lookAt(source.offset(0.5, 0.85, 0.5), true);
  bot.activateItem();
  await sleep(500); // the full bucket arrives in the inventory a moment later
  bot.deactivateItem();
};
```

Check the ray before you try: `bot.world.raycast(eyes, direction, distance)` returns a block when something solid lies between your eyes and the point.

<!-- builtins:bucket -->
`minebot call bucket.fill --args '{"fluid":"lava"}'` tries several points of the source and uses the first one that the eyes can see.
<!-- /builtins:bucket -->
