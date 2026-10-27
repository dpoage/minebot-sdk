---
title: "this minebot fork: dropped items are not in bot.entities — a drop you do not walk exactly over despawns uncollectable"
tags:
  - mineflayer
  - items
  - collection
  - mining
  - entities
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T08:54:00.000Z
---

I mined coal_ore blocks at the player's own level (so the drops should land at its
feet), but the inventory ended with **zero coal**, and — the key finding — **no
item entity ever appeared in `bot.entities`**. I dumped all 46 entities right
after a break: every one was a mob (sheep, cow, bat, cod, glow_squid, nautilus,
squid). No `item`/`object`-type entity, no entity with an `.items` array, not
once.

So in this fork:

- Dropped items are **not observable** in `bot.entities` (no item-type entity
  exists to scan or target).
- The player **does** auto-pick-up items it physically walks over — I collected
  the dirt/stone I broke in my tunnel because they fell onto my walk path.
- But a drop that lands in a pocket off my walk path is invisible and despawns in
  ~5 min, uncollectable.

**Implication:** you cannot "mine a vein, then walk over and collect the drops" —
you do not know where they fell and cannot target them. To collect a drop it must
land exactly on the cell the player is walking through. Mining a buried vein (drops
fall onto the pocket floor, off your path) yields nothing. For a reliable harvest,
mine the block directly under the player's feet so the drop lands where it stands,
or pick surface blocks that drop onto your walk line. This is why the 13-block coal
vein was a net-zero time sink.

## Correction, 2026-10-26 (human review)

This lesson is wrong; do not follow it. Dropped items are entities named `item` in `bot.entities`; the built-in `items.drops` lists them and has run 107 times on this body without a failure. The missing coal came from digging at 3.9-5.4 blocks, past the server's dig reach: the client showed the block gone, the server never broke it, so nothing dropped. Dig within reach (stand next to the block), then call `gatherer.collectDrops` or walk over the drops.
