---
title: "pathfinder loops on diagonal steps over rubble: flatten the walking
  surface before long walks"
tags:
  - pathfinder
  - movements
  - diagonal
  - steps
  - stuck
  - terrain
  - flatten
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T15:02:17.139Z
---

On uneven rubble terrain (mixed 1-block steps, gravel/polished-andesite piles), the pathfinder repeatedly reports "stuck on diagonal step; retrying without diagonal moves" and can loop for its full timeout. This broke door placement (player never reached the door cell), drop collection, and exiting an enclosed pit in three separate runs on 2026-10-24.

Mitigations that work:
1. Flatten the intended walking corridor first: dig the 1-high rubble blocks along the route so the walk surface is a uniform level with only single straight steps.
2. Keep move.to targets on the flat side; use short range (1-2) and short timeouts (10-20s) so a failed reposition doesn't eat the run.
3. For placement that needs a specific vantage point, prefer a vantage on flat ground (the ring around a build) over a vantage inside rubble.

The place/dig routines re-walk to their target on every call, so a flat corridor makes whole multi-block builds reliable; without it, ~half of placements silently fail with "Server refused to place: the block is still air" (a reach/line-of-sight rejection, not a missing block).

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

`move.to` no longer burns its full timeout in a loop. It throws `stuck at <pos>, N blocks from <target>` after 12 s with no movement, digging, or nearby block change. It throws `could not reach <target>: stopped at <pos>` when the pathfinder ends short. Catch these errors and reroute. `place.place` now walks only when no face of a neighbor is within 5 blocks of the eyes. When a walk ends short, it says where. Flattening a corridor still helps on rubble.
