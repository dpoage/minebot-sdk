---
title: blockAt on unloaded chunks lies; scan only near the player
tags: []
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T01:33:06.766Z
---

# blockAt on unloaded chunks lies

`bot.blockAt(x,y,z)` returns `undefined` (not the real block) when the chunk is outside
view distance, and `undefined` also for a genuinely-air cell. Any "scan the world for X"
loop that runs over coordinates the player isn't standing next to is unreliable: a block
reported as `?`/missing may exist 90m away, and a "found" hit may be a stale/gone one.

Hit it 2026-10-24 (~08:00): recover.ts found a spruce trunk at (-524,76,94) while the
player stood at (-590,82,4) — 85m away. The follow-up chop loop then saw `?` for every
cell (chunk had unloaded as the player moved) and silently chopped nothing: result
`logs: 0`, "not enough logs".

Rule: **move to the area first, then scan within ~8 blocks of where you actually stand.**
If a scan from a distance must happen, treat `undefined` as "unloaded, unverified" and
re-scan on arrival before acting on it.
