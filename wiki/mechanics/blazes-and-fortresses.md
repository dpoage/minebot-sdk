---
title: Blazes drop blaze rods, and spawn from spawners in nether fortresses
tags: [blaze, blaze_rod, blaze_powder, fortress, spawner, nether, ender_eye, fireball, snowball, fire resistance]
verified_by: "spawners, blaze health, and drops observed on the 26.1 dev server, 2026-10-19; how blazes attack is general knowledge, not yet checked"
---

## Where they are

Observed: a nether fortress had 2 spawner blocks within 64 blocks, and the spawn data of both named `blaze`. Four blazes stood within range of the bot. A blaze has 20 health. See `mechanics/the-nether` for finding the bricks of a fortress.

## What they give

A blaze drops 0 to 1 `blaze_rod`, and only when a player kills it (search `blaze_rod drops`). Looting raises the count. One rod crafts into 2 `blaze_powder`, and an `ender_pearl` with a `blaze_powder` crafts into an `ender_eye` (search `ender_eye recipe`). So each eye costs half a rod and a pearl.

## How to fight one

[INFERENCE] From vanilla: a blaze hovers and shoots fireballs from range, takes damage from water and from snowballs, and does not burn in lava. The ways to survive it are fire resistance, armor, and a roof of blocks to hide behind. Hit it with a sword or a bow: `mechanics/combat-basics`. Check `bot.health` after every fireball, and leave when it is under 8.

Find blazes with:

```js
const blaze = bot.nearestEntity((e) => e.name === "blaze");
```

<!-- builtins -->
`kit.combat.fight({ radius: 16, targets: ["blaze"] })` fights blazes in range.
<!-- /builtins -->
