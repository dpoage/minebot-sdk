---
title: Drops from dug blocks can land out of pickup range
tags: [drops, items, pickup, logs, gathering, inventory]
mc_version: "26.1"
verified_by: observed in the craft-wooden-pickaxe demo, 2026-10-18 (dug 3 logs, inventory held 1)
---

## Symptom

`bot.dig(block)` succeeds, but the item does not reach the inventory. This happens most with logs high in a tree: the drop falls to the ground, several blocks below the bot.

## Cause

A player picks up an item only within about one block of its hitbox. `bot.dig` does not walk to the drop.

## Workaround

After digging, walk over nearby item entities:

```js
await sleep(400); // let the drop spawn and fall
for (const e of Object.values(bot.entities)) {
  if (e.name !== "item" || e.position.distanceTo(bot.entity.position) > 8) continue;
  const p = e.position.floored();
  await bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)).catch(() => {});
}
```

<!-- kits -->
`await kit.gatherer.collectDrops()` does the same, and `kit.gatherer.gather` already picks up drops after each block.
<!-- /kits -->
