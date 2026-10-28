---
title: A walk fails because every way goes through blocks you placed
tags: [pathfinder, stuck, blocked, own builds, build, door, scaffold, wall, roof, could not reach, no path, allowDigOwnBuilds]
mc_version: "26.1"
verified_by: "the own-build exclusion, allowDigOwnBuilds, and the error text by test/pathfinding-own-builds.test.ts and test/move-own-builds.test.ts"
---

## Symptom

A walk finds no route although the player can see one. The blocks in the way are ones the player placed earlier, such as a wall, a roof, a door, or a staircase.

<!-- builtins:move -->
`move.to` then throws:

```
could not reach (10, 64, 0): every way goes through blocks you placed (e.g. oak_planks at (4, 64, 0)); open a door, break one yourself, or call move.to again with allowDigOwnBuilds: true
```

The same error appears when the only path would break one of those blocks, or put a scaffolding block under one.
<!-- /builtins:move -->

A raw `bot.pathfinder.goto` fails with the plugin's own error, `No path to the goal!`.

## Cause

The body records each block the player places itself, and not the blocks the pathfinder scaffolds. The default movements never break a recorded block, and never place a block under one within 16 blocks. The pathfinder therefore treats your own wall as solid and your own roof as a ceiling.

The record belongs to the bot host session. A restart of the body forgets it, and with it the block you placed and then forgot.

## Workaround

1. Open the door you built, or break the block that the error names. Then walk again.
2. Pick a target on the same side of your build, so the route crosses nothing you placed.
3. Walk through what you built on purpose, when that is cheaper than going around:

<!-- builtins:move -->
`minebot call move.to --args '{"position":[10,64,0],"range":1,"allowDigOwnBuilds":true}'` walks on movements without the own-build exclusions. A routine passes the same argument, and `allowDigOwnBuilds` defaults to `false`.
<!-- /builtins:move -->

With a raw `bot.pathfinder`, break the block first, or give the pathfinder movements that carry no exclusion for your builds.
