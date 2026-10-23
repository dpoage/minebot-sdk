---
title: "bot.dig throws \"enchantments is not iterable\" or \"enchantments.concat is not a function\" with an enchanted tool"
tags: [dig, enchanted, enchants, digTime, TypeError, "enchantments.concat", "not iterable", efficiency, pickaxe, helmet, componentMap]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

After you enchant a tool, or pick up one that is enchanted, every `bot.dig(block)` with it fails:

```
TypeError: enchantments is not iterable
```

or, when your bot also wears a helmet:

```
TypeError: enchantments.concat is not a function
```

A tool without enchantments digs fine. Observed with an iron pickaxe (efficiency 2, unbreaking 2) and a stone pickaxe (efficiency 4, unbreaking 3).

## Cause

On 26.1, `item.enchants` returns the data of the item's enchantments component, an object `{ enchantments: [{ id, level }] }`. `bot.digTime` expects a list of `{ name, lvl }`. It takes the list from the held item, so the object gets passed on and the call breaks.

## Workaround

Replace `bot.digTime` once with a version that converts the enchantments. The change stays in place for later programs, because the bot object lives as long as the body:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

type Enchant = { name?: string; id?: number; lvl?: number; level?: number };

export default ({ bot }: RoutineContext) => {
  const asList = (item: { enchants?: unknown } | null | undefined) => {
    const enchants = item?.enchants as Enchant[] | { enchantments?: Enchant[] } | undefined;
    return (Array.isArray(enchants) ? enchants : (enchants?.enchantments ?? []))
      .map((e) => ({ name: e.name ?? bot.registry.enchantments[e.id!]?.name ?? "", lvl: e.lvl ?? e.level ?? 0 }));
  };
  bot.digTime = (block) => block.digTime(
    bot.heldItem?.type ?? null,
    bot.game.gameMode === "creative",
    ["water", "flowing_water"].includes((bot as unknown as { _getBlockAtEyeLevel(): { name: string } | null })._getBlockAtEyeLevel()?.name ?? ""), // Mineflayer's own test for being under water
    !bot.entity.onGround,
    [...asList(bot.heldItem), ...asList(bot.inventory.slots[5])], // slot 5 is the helmet
    bot.entity.effects,
  );
};
```

Observed: with this in place, the enchanted pickaxe dug cobblestone in 392 ms. `bot.dig` reads `bot.digTime`, so no other change is needed.

Reading enchantments from an item works: see `mechanics/enchanting-basics`.
