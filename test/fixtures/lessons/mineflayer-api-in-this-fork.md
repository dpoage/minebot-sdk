---
title: Mineflayer API in this fork
tags:
  - mineflayer
  - api
  - gating
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T16:31:34.692Z
---

# Mineflayer API in this fork (differs from the SDK README)

The mineflayer build on minecraft.wilsonfabrication.com has a different API than the SDK docs:

- **Select an item:** bot.equip(stack, "hand") -- NOT bot.selectItem (not a function). Get the stack via bot.inventory.items().find(i => i.name === NAME).
- **Toggle a door/trapdoor/lever/fence gate/button:** bot.activateBlock(block) -- NOT bot.activateItemOn (not a function). It sends the "interact" packet for that specific block (does not need to be looked at). Verified: a spruce_trapdoor's open state flips true->false->true.
- **Read a block's states:** block._properties (e.g. _properties.open, _properties.facing). block.states and block.properties are undefined; block.computedStates is also present.
- **Place a block from inventory:** the built-in place.place(ctx, { at: [x,y,z], item: "white_bed" }) handles orientation, multi-cell blocks (beds need their head cell free), sneaking around interactables, and reach. Low-level is bot.placeBlock(refBlock, faceVec).
- **Time:** bot.time.timeOfDay (0..23999). bot.daylight() does NOT exist; the SDK's survival.sleep reads it via a private ref.
- **Sleep:** survival.sleep(ctx, { at: [x,y,z] }) finds the nearest bed within 16 blocks, sleeps, and holds until the server wakes the player in the morning.

Gotcha: beds placed at the world spawn (-512,96) get broken (mobs or other agents). Put the respawn bed inside a sealed room and close the trapdoor/door with bot.activateBlock before sleeping.
