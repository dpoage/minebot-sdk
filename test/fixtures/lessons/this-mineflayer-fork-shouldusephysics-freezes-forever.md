---
title: "this mineflayer fork: shouldUsePhysics can go false and stay false — the player is frozen forever; only a body restart fixes it"
tags:
  - mineflayer
  - api
  - physics
  - movement
  - debugging
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T06:30:00.000Z
---

Movement in this fork is client-simulated: `lib/plugins/physics.js` runs a local
`simulatePlayer` and sends ABSOLUTE `position`/`look` packets. `setControlState`
only sets flags; the player moves only while the physics loop is running.

**The trap:** a private flag `shouldUsePhysics` in
`node_modules/mineflayer/lib/plugins/physics.js` (this env's mineflayer fork)
is set **false** on `login`, `mount`, `death`, `respawn`, `start_configuration`,
and set **true** ONLY by the server's `position`/`teleport` packet handlers
(flag decl ~line 41; tick ~83; set-false ~479/481/484/486/497; set-true in the
position handler ~448). If it goes false without a subsequent server position
packet — e.g. a spurious `mount` or a mid-session configuration phase — the
player is **frozen permanently**: `setControlState("forward")` does nothing, no
`physicsTick` fires, the position never changes (0.000 displacement across
minutes of walking).

**Diagnosis:** a walk times out with the position unchanged to 3 decimals, and
`physicsEnabled` (the flag) reads false.

**Fix:** there is no public API to re-enable it. Kill the body process and
restart it: fresh login → first server `position` packet → physics on.
Inventory and notes survive; the player respawns at the world spawn. Do NOT
spend time debugging the walk code first — a zero-displacement walk is this
flag, not your code.

Also measured in the same session:

- `bot.setControlState(control, bool)` is **singular, per control**
  (`"forward"|"back"|"left"|"right"|"jump"|"sneak"`); there is no plural
  `setControlStates`.
- After `bot.clearControlStates()` wait ~200 ms before setting new states: the
  clear packet can land late and clobber sets made in the same tick.
- The proven walk pattern (exit-camp4): one `lookAt(target, true)`, short
  settle, hold `forward` continuously in a tight loop, never release/re-look
  mid-leg — the release cycle re-synced the server position and cancelled
  progress every burst.
