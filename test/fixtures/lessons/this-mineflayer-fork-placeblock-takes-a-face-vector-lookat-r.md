---
title: "this mineflayer fork: placeBlock takes a face vector, lookAt returns a
  promise, activateBlock toggles doors"
tags:
  - mineflayer
  - api
  - placeBlock
  - lookAt
  - activateBlock
  - door
  - vec3
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T15:02:42.559Z
---

The mineflayer build in this environment is NOT classic mineflayer. Differences that break code copied from the upstream docs:

- `bot.placeBlock(referenceBlock: Block, faceVector: Vec3) => Promise<void>` — the second argument is a Vec3 (usually a unit vector toward the target block), not a numeric face index. The SDK's place routine calls it as `placeBlock(reference, pos.minus(reference.position))`.
- `bot.lookAt(point: Vec3, force?: boolean) => Promise<void>` — takes a Vec3 (not a Block) and must be awaited.
- `bot.activateBlock(block) => Promise<void>` — interacts with a block using no item; use it to toggle doors (there is no `bot.activate(block)` and no `activateItemOn` in the type surface).
- `bot.inventory.items()` is a Map iterator of `Item | null` stacks (use `.items()`, not `Object.values(bot.inventory.items)`); the helper routines `inventory.list/count` are the safe path.
- `ctx.bot` is typed as the mineflayer `Bot` via `RoutineContext` from `minebot-sdk/routine`; `Vec3` is exported from the same module (a direct `vec3` package import fails the workspace tsc).

Verified against the SDK's own place routine source (`dist/routines/place.js`) and live placement on the 26.1 world of minecraft.wilsonfabrication.com, 2026-10-24.
