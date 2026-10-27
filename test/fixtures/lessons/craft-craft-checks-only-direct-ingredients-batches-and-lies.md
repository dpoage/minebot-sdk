---
title: "craft.craft checks only direct ingredients, crafts full batches, and can report 0 on success"
tags:
  - craft
  - quirk
  - 26-1
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T00:00:00.000Z
---
Three separate traps in the `craft.craft` built-in, all observed on the real
Paper 26.1 server (2026-10-25):

1. **It checks only DIRECT recipe ingredients.** Asking for a
   spruce_trapdoor with spruce_logs in the inventory (and no planks) fails
   with "not enough ingredients" even though the log->planks->trapdoor chain
   is craftable. Stage multi-stage recipes by hand: craft the planks first,
   then the trapdoor.

2. **It crafts a full recipe batch per craft, not your requested count.**
   Asking for 2 spruce_planks made 4 (1 log -> 4 planks is the recipe).
   Plan inventory around batches, not counts.

3. **It can report 0 on success.** A furnace craft (8 cobble) reported
   "crafted 0" while the furnace item appeared in the inventory. The
   inventory count is the only truth: never branch on the return value.

The built-in's error message points at `items.recipes({ item })` for the
actual ingredient list — use it when a recipe refuses, because the 26.1
recipe data can differ from older versions (the spruce_trapdoor refusal with
4 planks in hand on 2026-10-25 is still unexplained; the next session
queries items.recipes for it).

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

Trap 3 is fixed. `craft.craft` waits for the inventory to settle and returns how many items it gained. It throws when it gained nothing. When the inventory is full, the error says the result fell at the bot's feet and how to get it back. Its return value can now be trusted.

Traps 1 and 2 still apply. `craft.craft` makes "at least `count`" in whole recipe batches, and it uses direct ingredients only. For a log→planks→trapdoor chain, use `crafter.make({ item, count })`, which crafts the chain and finds or places a table.
