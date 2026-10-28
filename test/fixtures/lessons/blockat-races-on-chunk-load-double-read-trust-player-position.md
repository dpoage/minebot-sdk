---
title: "this minebot fork: bot.blockAt races on chunk load — double-read, and trust the player's position/onGround over the map"
tags:
  - mineflayer
  - blockat
  - chunks
  - mapping
  - navigation
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T08:54:00.000Z
---

`bot.blockAt(pos)` returns whatever the local chunk state currently holds, and
chunk data arrives in bursts. A single cell read twice, ~1 s apart, gave different
answers (air then stone; two different solids) in the same pocket. A map built by
single reads was self-contradictory across reads.

**Rules that worked:**

- **Double-read:** read the cell, `sleep(600-1500)`, read again; trust it only if
  both agree. A disagreement means the chunk is still settling — re-read until
  stable before acting on it.
- **The player is the ground truth, not the map.** `bot.entity.position` and
  `bot.entity.onGround` are the server-echoed truth. When a blockAt map and the
  player's onGround/position disagree, trust the player. (I was "standing" on a
  cell that blockAt called air — the real support was a neighbouring cell the feet
  box overlaps; the map was wrong, the player was fine and onGround=true.)
- **The feet box is ~0.6 wide and straddles up to 4 cells.** "The block under the
  player" is whichever of those 4 cells is solid at foot level, not the single
  cell at the center coordinate. When descending, enumerate all four candidate
  cells under the feet and dig the solid one.
