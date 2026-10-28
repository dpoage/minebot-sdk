---
title: Placement clicks near a bed break the bed (26.1)
tags:
  - "26.1"
  - placement
  - bed
  - safety
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T04:16:26.081Z
---

# Placement clicks near a bed break the bed (26.1)

Two camp beds were broken in one night, both by `bot.placeBlock` raycasts that
passed over a bed cell while another item was in hand.

## The mechanics
- ANY click on a bed cell breaks it, with ANY item in hand (pickaxe, stick,
  even nothing useful). The bed drops as an item and auto-picks back up if the
  player is within reach.
- The placeBlock raycast aims at the reference block's face, but the click can
  resolve to an adjacent block (the bed) when standing close — the post-check
  error is then "Server refused to place <heldItem> ... the block is still air".
- A second failure mode: **held-item desync**. `inventory.equip(item)` selects
  the slot, but later movement/GUI work can leave a different item held; the
  click then places/damages with the wrong item.

## The rules
1. Verify the held item IMMEDIATELY before the click: read `bot.heldItem.name`
   (a property on this mineflayer fork, not a method) and re-equip if it is not
   the item you intend to place.
2. Keep the bed >=2 cells from any work cell, or run a bedGuard after every
   click (re-place from the west axial cell, yaw east; mirror from the east).
3. A broken bed is recoverable (the item drops); a broken DOOR is not (it may
   despawn the block from the build). Pathfinders break blocking blocks —
   route paths away from doorways (dig.dig included).
