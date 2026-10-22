---
title: bot.inventory shows old counts while a chest or villager window is open
tags: [inventory, window, count, openContainer, openVillager, trade, withdraw, stale, close, chest]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

You withdraw items from a chest, or trade with a villager, and `bot.inventory.count(id)` right after shows the old number. In the test, after `chest.withdraw(iron, null, 3)` the count said 0; after closing the window it was right. After two trades of 20 wheat for 1 emerald it said 0 emeralds and 40 wheat; after closing, 2 emeralds and 0 wheat.

## Cause

While a container window is open, your items live in that window's slots. `bot.inventory` is updated only when the window closes.

## Workaround

Read counts from the window while it is open, or close it and wait a moment:

```ts
import { Vec3 } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep }: RoutineContext, { x, y, z }: { x: number; y: number; z: number }) => {
  const itemId = bot.registry.itemsByName.iron_ingot!.id;
  const chest = await bot.openContainer(bot.blockAt(new Vec3(x, y, z))!);
  await chest.withdraw(itemId, null, 2);
  const have = chest.count(itemId, null);       // current, while the window is open
  chest.close();
  await sleep(500);
  const after = bot.inventory.count(itemId, null); // current again
  return { have, after };
};
```

`chest.items()` lists your own items as the window shows them, and `chest.containerItems()` the container's. `chest.count(itemId)` counts your own. The same holds for a villager window (`mechanics/villagers-and-trading`).
