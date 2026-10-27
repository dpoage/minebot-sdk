---
title: "26.1 bed placement: no collision block adjacent along the axis"
tags:
  - "26.1"
  - placement
  - bed
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T03:26:08.639Z
---

# 26.1 bed placement rules (vanilla, controlled experiment)

Measured 2026-10-24 on a disposable vanilla 26.1 dev server (matrix of placement-only runs; fixtures via console `setblock`):

- A bed is 2 cells. The second cell extends along the **player's yaw direction** at placement time (scan-verified: yaw east -> east extension). The click itself is yaw-independent: `placeBlock(refBlock, faceVec)` hits that face no matter which way you face.
- The cells above the bed must be air, and **1 air of headroom is enough** (a bed placed fine under a 1-air ceiling; 2 air also fine).
- **A bed is REFUSED when a collision block (dirt, log, wall, fence) is horizontally adjacent to a bed cell ALONG THE BED AXIS, at the bed's level.** Both a 1-high and a 2-high adjacent column refuse, even with infinite headroom and the correct yaw. The server gives no chat feedback on refusal — the mineflayer fork's placement post-check reports `Server refused to place <item> at (x,y,z): the block is still air`.
- A no-collision block (e.g. another bed) IS an acceptable axial neighbour — beds can sit back to back.
- Solids adjacent **perpendicular** to the axis are fine (a wall directly beside the bed does not refuse it).
- Practical rule: place beds on open floor, or in rooms where both ends of the bed's axis face open space (e.g. E-W across a 4-wide interior). Against a wall = refused, regardless of which side.

Related 26.1 findings, same experiments:
- Doors: Paper 26.1 refuses a 1x2 door whose top cell has >=2 solid lateral neighbours (vanilla allows it; <=1 lateral is accepted on both).
- Commands: vanilla 26.1 does NOT execute chat-slash commands (`/give`, `/setblock` sent as chat do nothing; the fork has no CommandPacket). Paper does execute them. On a vanilla dev server the console is the only command channel.
- `setblock`/`fill` cannot write air in 26.1 — remove blocks by having the player dig them.
