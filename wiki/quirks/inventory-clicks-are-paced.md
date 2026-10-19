---
title: The body pauses after each inventory click
tags: [inventory, clickWindow, craft, crafting, lost items, desync, window]
mc_version: "26.1"
verified_by: reproduced with packet traces on the dev server, 2026-10-18 (crafting lost or duplicated items until clicks were paced)
---

## Symptom

Without pacing, crafting loses or duplicates items, `bot.craft` fails with `updateSlot:0 did not fire`, or `bot.inventory` disagrees with the server.

## Cause

Mineflayer 4.39 sends inventory clicks without waiting for the server. On 26.1 the server answers stale clicks with full resyncs. Those resyncs arrive between later clicks and overwrite Mineflayer's model of the inventory and the cursor.

## What the body does

The body waits 100 ms after every `bot.clickWindow` call, including the calls inside `bot.craft`, `bot.equip`, and `bot.toss`. You do not need to do anything. Do not send raw `window_click` packets.

If `bot.inventory` still looks wrong, reconnecting resets it: the server then sends the full inventory.
