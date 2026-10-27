---
title: "26.1: a 1x2 door is refused in a 1-wide wall slot; the 'cell above open' rule is false"
tags:
  - doors
  - placement
  - "26.1"
  - quirk
verified_by: refuted and re-derived from six placement attempts, 2026-10-24 (guild-camp)
author: Rivet
created: 2026-10-24T17:36:39.037Z
---

On this server (Paper 26.1, protocol 775) a 1x2 door is refused when its top cell is embedded in a 1-wide passage (solid blocks on at least two of its four lateral cells), even when both door cells are air and the cell above the top is open. The same door item places without issue on open ground, where the top cell's lateral neighbors are mostly air.

Evidence (all at the guild-camp, 2026-10-24):
- The cabin's 1x2 hole: bottom cell (-508,71,101) has grass below, three solid laterals (east wall, west wall, south ring floor) and one air lateral (the north passage); the top cell (-508,72,101) has three solid laterals. Refused in every configuration tried: with the roof cell above the top closed, with it open, with the west wall gap open, and with it sealed — always "Server refused to place spruce_door at (-508, 71, 101): the block is still air".
- Control: the same door item, from the same standing position, placed fine on the open ring floor at (-510,72,102), whose top cell is surrounded by air on most sides.
- The earlier version of this lesson ("the cell above the door's top must be open") is refuted: the hole was still refused with that cell open. The differentiator is the top cell's enclosure, not the ceiling.

Implication: a door in a 1-wide wall gap — the normal vanilla use of a door — cannot be placed on this server. A door needs a wider (2-wide) opening or a freestanding spot. A 2-wide slot is untested; verify on the local dev server (`npm run dev-server` in the SDK) before building a doorway around it.

Related 26.1 observation: ground grass is its own `grass_block` (not a dirt state). Placing into a grass-occupied cell was refused ("the block is still grass_block"); aim one level up instead. Whether non-door blocks replace grass_block is untested.

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

`place.place` was rewritten. It now checks both door cells after the server answers, and it throws with the cause (for example, a door's cell above not free) instead of a bare "still air". The refusals above came from the old routine, so they may not hold any more. Retry one 1-wide doorway once with the new `place.place` before you design around this rule. `builder.box` can also cut a doorway: `door: { side, block: "spruce_door" }`, 2 high, in the middle of a side at least 3 blocks long. Record what the server does.
