---
title: "Trapped underground: dig a staircase to the surface"
tags: [stuck, trapped, underground, pit, hole, cave, surface, climb, escape, staircase]
mc_version: "26.1"
verified_by: "a staircase climb from 20 blocks underground on the dev server, 2026-10-18"
---

## Symptom

The bot is in a pit or a cave, and `bot.pathfinder.goto` to the surface fails or never ends. Program results show a notice that the last programs changed neither the position nor the inventory, and that the player is under solid blocks.

`minebot observe --brief` shows `underground: N blocks above`.

## Do not

- Do not dig straight down to get out of a hole. Digging down makes the hole deeper.
- Do not dig straight up with the bot under the block. Gravel and sand fall on the bot.

## Workaround

Dig a staircase: each step clears the space above the head and the two blocks of the next step, then walks up one block. A staircase needs no blocks in the inventory.

Repeat these steps until nothing solid and no water is above the head:

1. Pick a direction `d` (east, south, west, north).
2. Dig the block above the head: `here + (0, 2, 0)`.
3. Dig the two blocks of the next step: `here + d + (0, 1, 0)` and `here + d + (0, 2, 0)`.
4. Walk up: `await bot.pathfinder.goto(new goals.GoalBlock(step.x, step.y, step.z))`.
5. If lava is next to a cell you dig, or the next step has no floor, turn to another direction.
6. If water is directly on top of a cell you dig, you are under a lake or the sea. Do not dig that cell: the water pours down and the player can drown. Dig a level tunnel (the two blocks at `here + d`) and try again from there.

Hold a pickaxe if you have one. By hand, each stone block takes about 7 seconds, so 20 blocks of depth take several minutes.

<!-- builtins:explorer -->
One call does all of this on a body with built-in routines: `minebot call explorer.surface` with `--timeout 600000`.
<!-- /builtins:explorer -->

## Under water

The player has 20 points of air. Under water, air drops about 1 point per second, then the player takes drowning damage. `minebot observe --brief` shows `air N/20` when air is below 20. To get out, hold jump to swim up (`bot.setControlState("jump", true)`), then swim to dry land with the pathfinder. Releasing jump makes the player sink again.

Digging under water is 25 times slower than on land, so do not dig a ceiling while your head is under water. By hand, one stone block takes minutes, and the air lasts about 15 seconds. `bot.oxygenLevel` (0 to 20) is the air left; each level is 0.75 seconds. If a solid ceiling blocks you, swim sideways to air first (look for an air block above water), wait there until `bot.oxygenLevel` is back near 20, then dig.

<!-- builtins:explorer -->
`explorer.surface` checks `bot.oxygenLevel` before every dig under water. It swims to air first when the air does not cover the dig.
<!-- /builtins:explorer -->
