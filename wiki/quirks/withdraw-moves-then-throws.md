---
title: "chest.withdraw with a count above the stock throws \"Can't find ... in slots\" after it moved everything"
tags: [withdraw, deposit, chest, container, error, "Can't find", count, items, window]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

```
Error: Can't find coal in slots [0 - 27], (item id: 897)
```

You asked `chest.withdraw(coal, null, 99)` and the chest held 12. The call throws, but the 12 coal are already in your inventory.

## Cause

`withdraw` moves stacks until the count is met, and throws when it runs out of stacks to take. The items it did move stay moved.

## Workaround

Ask for no more than the chest holds, and treat the error as a partial success:

```ts
import { Vec3 } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext, { x, y, z, itemId, want }: { x: number; y: number; z: number; itemId: number; want: number }) => {
  const chest = await bot.openContainer(bot.blockAt(new Vec3(x, y, z))!);
  const have = chest.containerItems().filter((i) => i.type === itemId).reduce((n, i) => n + i.count, 0);
  await chest.withdraw(itemId, null, Math.min(want, have));
  chest.close();
};
```

If the chest has none of the item, `withdraw` throws the same error with nothing moved. Count first. See `mechanics/containers`.
