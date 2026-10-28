---
title: "equip-then-place races: verify heldItem and the result"
tags:
  - place
  - equip
  - quirk
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T16:57:54.709Z
---

In this mineflayer fork, `bot.equip(stack, "hand")` is fire-and-forget: a hotbar-to-hotbar swap sends only a selected-slot packet, and a main-inventory-to-hotbar move sends a click-window packet, and neither waits for the server to apply it. The SDK's `place.place` calls `bot.placeBlock` immediately after awaiting equip, so the placement click can be processed while the server still has the previous item selected.

Observed (2026-10-24): `place.place({ at: (-507,71,100), item: "chest" })` left a spruce_log at the target — the previously held item — even though a chest was in the inventory and equip was called (no "no chest in inventory" error was thrown, so the stack was found).

Safe pattern (verified again 2026-10-25, where a MOVE between verify and click
re-slotted the held item and the click placed cobble instead of a furnace):
1. Do ALL movement first.
2. Settle 300-500 ms, then `await inventory.equip(ctx, { item })` and poll
   `bot.heldItem?.name === item` in a tight retry loop (300 ms, up to 5 tries)
   IMMEDIATELY BEFORE the click — a verify before the movement is stale.
3. Place, then verify the target cell's block type; if the wrong block
   appeared, dig it out and retry from another stance.

Also relevant: the fork's `placeBlock` throws "Server refused to place <held> at <dest>: the block is still <type>" when the server answers with an unchanged cell, so a failed placement is detectable, but it can also leave the intended item unplaced while a different item was in hand.

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

`place.place` now handles this race. It waits for the server's block and held-slot updates. It checks every cell the block needs (both halves of a door or bed), and it returns only once the server has taken the item from the hand. When the block did not land, it throws and names the cause (an entity in the way, a door's upper cell or a bed's head cell not free, a face out of reach). With `place.place`, skip the manual equip/poll/verify loop. Keep it only for raw `bot.placeBlock` calls.
