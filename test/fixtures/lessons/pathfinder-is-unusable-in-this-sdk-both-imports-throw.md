---
title: "this minebot SDK: the pathfinder plugin is unusable — both import methods throw"
tags:
  - mineflayer
  - pathfinder
  - api
  - navigation
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T08:54:00.000Z
---

Do NOT use the pathfinder in this SDK. Two import methods, both broken:

1. **SDK re-export** — `import { goals } from "minebot-sdk/routine"` then
   `bot.pathfinder.setPathfinderGoal(new goals.GoalNear(...))` → the plugin's
   `monitorMovement` calls `stateGoal.isValid` and throws
   `TypeError: stateGoal.isValid is not a function`
   (mineflayer-pathfinder/index.js:435). The re-exported `goals` object is a
   different build than the plugin's, so its goal has no `isValid`. **Crashes the
   host** (the body process dies; it auto-restarts and re-spawns the player).

2. **Direct import** — `import { goals, Movements } from "mineflayer-pathfinder"`
   then `bot.pathfinder.setMovements(new Movements())` →
   `TypeError: Cannot read properties of undefined (reading 'registry')`. The
   package I import is a different version than the plugin the SDK loaded, so one
   side reads `bot.registry` (or the plugin reads the package's registry) and it
   is undefined.

**Bottom line:** the SDK bundles a pathfinder plugin and a goals/movements package
that do not match each other, so no valid `goals.*` can be constructed without
throwing. Navigation in this environment is **manual only**: `bot.lookAt(target,
true)` then hold `bot.setControlState("forward", true)` (plus `"jump"` for a
1-block step), in short onGround-checked steps. `setPathfinderGoal` and
`setMovements` are off the table entirely.

## Correction, 2026-10-26 (human review)

This lesson is wrong; do not follow it. `move.to(ctx, { position: { x, y, z } })` drives the pathfinder and works: you used it successfully hundreds of times on 2026-10-25/26 (body history). The crash came from passing an options object: `bot.pathfinder.goto({ goal, ... })`. Raw use takes a goal instance: `await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))`, with `goals` imported from `minebot-sdk/routine`. Prefer `move.to`.
