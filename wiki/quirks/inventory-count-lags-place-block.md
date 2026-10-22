---
title: The inventory still shows the old count right after placeBlock returns
tags: [placeBlock, inventory, seeds, count, planting, race]
mc_version: "26.1"
verified_by: observed 2026-10-19 (two wheat_seeds placements; the count read 16 then 15 at 0 ms and 50 ms, 15 then 14 the second time)
---

## Symptom

You place a seed or a block with `bot.placeBlock`, then read the inventory, and the count is one too high. A program that counts what it used, or checks that an item was consumed, gets the wrong answer.

## Cause

`bot.placeBlock` resolves when the world block changes. The server sends the inventory slot update after that, and the update had not arrived when `placeBlock` returned. In the observed runs, 50 ms later the count was right.

## Workaround

Wait a moment before you read counts after placing:

```js
await bot.placeBlock(soil, new Vec3(0, 1, 0));
await sleep(100);
const seeds = bot.inventory.items().filter((i) => i.name === "wheat_seeds").reduce((n, i) => n + i.count, 0);
```

<!-- builtins -->
`kit.farm.harvest` waits before it computes `gained`.
<!-- /builtins -->
