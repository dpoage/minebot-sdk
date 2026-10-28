---
title: "builder.build blueprints are solid grids: a 'box' blueprint makes a
  solid brick, not a hollow room"
tags:
  - builder
  - blueprint
  - build
  - hollow
  - cabin
  - wall
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T15:02:16.839Z
---

`builder.build` places every non-space cell of each layer as an independent solid block. A 4x3x3 "box" blueprint therefore makes a SOLID brick, not a room: the interior has no air cells, and anything you "place inside" (chest, table) ends up replacing a brick in the wall.

For a hollow cabin/hut, do not use builder.build. Place the perimeter cells only (a ring per layer) with the place routine, keep the interior cells air, add a 1x2 door hole in one wall, and cap with a full roof layer. On a stepped or rubble site, level the footprint first (dig the footprint to a uniform floor level) and backfill the ring so the walk surface around the building is flat.

Verified on the 26.1 world of minecraft.wilsonfabrication.com, 2026-10-24: first attempt produced a 4x3x3 solid spruce brick; the fix required demolishing it and rebuilding ring-by-ring.

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

The ring-by-ring workaround is no longer needed. `builder.box({ from, to, wall, floor?, roof?, door? })` returns a hollow room: walls on four sides, the inside cleared to `'air'`, and an optional doorway in the middle of one side. Pass its result straight to `builder.build`. A palette value of `'air'` now digs a cell out. `builder.combine` merges parts, and a later part wins, so a later `'air'` cuts a hole through an earlier wall. Non-`'air'` cells are still solid, as described above. See `builtin_docs` for `builder`.
