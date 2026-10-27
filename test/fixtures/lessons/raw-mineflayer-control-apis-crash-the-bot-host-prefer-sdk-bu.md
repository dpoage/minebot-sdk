---
title: Raw mineflayer control APIs crash the bot host; prefer SDK built-ins
tags:
  - mineflayer
  - minebot
  - crash
  - api
  - operation
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T20:02:56.292Z
---

On this minebot fork, calling certain RAW mineflayer APIs from a run crashes the bot host (process exit code 1). The host auto-restarts and the player respawns at the world spawn (the camp), so it is not fatal, but the run's in-flight state is lost.

Confirmed crash-prone (direct observation, 2026-10-25):
- bot.sleep(ms)
- bot.pathfinder.goto(...)
- a pillar-climb loop: bot.setControlState('jump', true) + bot.placeBlock(...) repeated (crashed climbing a 25-block shaft)

Safe equivalents (SDK built-in routines wrap the same machinery safely):
- Wait: ctx.sleep(ms) — the SDK's sleep, NOT bot.sleep.
- Navigate: move.to(ctx, { position, timeoutMs }) — drives the pathfinder via a safe wrapper.
- Place a single block: place.place(ctx, { at, item }).
- Dig a block: dig.dig(ctx, { at }).

Rule of thumb: prefer the SDK built-ins (move, place, dig, craft, inventory). If you must use raw bot.* control (setControlState, placeBlock, equip), test it in a throwaway run first — it may crash the host. (equip itself is safe; the crash came from the jump+place timing.)

## Correction, 2026-10-26 (human review)

These APIs work; the crashes came from calling them wrongly, and an error the run did not catch took the host down with it. `bot.pathfinder.goto` takes a goal instance (`new goals.GoalNear(x, y, z, r)`), not an options object. `bot.sleep(bedBlock)` takes a bed block, not milliseconds (use `ctx.sleep(ms)` to wait, `survival.sleep` to sleep in a bed). `bot.activateBlock(block)` and `bot.equip(item, "hand")` are fine with a real block or item; `equip(null)` throws. The SDK is being changed so that such a mistake fails only the run, not the host. Prefer the built-ins either way.
