---
title: Block placement fails on tree canopies and leaf litter
tags: [place, placeBlock, leaves, leaf_litter, crafting_table, canopy, refused]
mc_version: "26.1"
verified_by: observed in the craft-wooden-pickaxe demo and a Qwen trial (leaf_litter), 2026-10-18
---

## Symptom

`bot.placeBlock` fails with an error like `Server refused to place crafting_table at (x, y, z): the block is still oak_leaves`, or `...: the block is still leaf_litter`.

## Cause

Pathfinding to logs often leaves the bot on top of the leaves. The blocks next to the bot are then leaves, so the target position is not empty, and "the block below" is a leaf instead of ground.

Leaf litter, which covers the forest floor, has no collision box (`boundingBox` is `"empty"`), so it looks free. The server does not replace it with the placed block.

## Workaround

Place only into air, on natural ground. Check the target before placing:

```js
const air = (b) => ["air", "cave_air", "void_air"].includes(b?.name);
const ground = bot.findBlocks({
  matching: (b) => b.boundingBox === "block" && !/_leaves$|_log$/.test(b.name),
  maxDistance: 8,
  count: 100,
}).find((p) => air(bot.blockAt(p.offset(0, 1, 0))) && air(bot.blockAt(p.offset(0, 2, 0))));
```

To place where leaf litter or grass is, dig it first.

<!-- kits -->
`kit.crafter.make` and `kit.builder.build` do this search for you (the crafter places a table, the builder places blocks).
<!-- /kits -->
