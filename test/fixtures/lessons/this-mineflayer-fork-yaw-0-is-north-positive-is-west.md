---
title: "this mineflayer fork: yaw 0 = north, +90 = west, 180 = south, -90 = east"
tags:
  - mineflayer
  - api
  - yaw
  - movement
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T06:30:00.000Z
---

The mineflayer build in this environment is NOT classic mineflayer, and its yaw
convention is inverted from vanilla/upstream:

- **0 = north, +90 (π/2) = west, ±180 = south, -90 (-π/2) = east.**
  Upstream mineflayer documents 0 = south. Code copied from the upstream docs
  walks the player 180° the wrong way.
- To face (tx, tz) from (px, pz): `yaw = Math.atan2(-(tx - px), -(tz - pz))`.
- **Direct assignment `bot.entity.yaw = x` IS accepted by the server.** The
  fork's `updatePosition` sends rotation in baby-steps (it clamps per-packet
  delta), so even 175° jumps land smoothly. Measured 2026-10-25: set 0 → held
  0.000; set π/2 → held 1.571 (server echo via `player_rotation`).
- `bot.lookAt(point, force?)` computes `atan2(-dx, -dz)` internally — same
  convention, consistent. `force = true` sets `lastSentYaw/Pitch` directly
  (no smoothing) and is the pattern that reliably drives movement (see the
  exit-camp4 run: one lookAt(force), then hold `forward` continuously).
