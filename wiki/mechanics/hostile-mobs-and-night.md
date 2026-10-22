---
title: Hostile mobs, darkness, and shelter
tags: [mobs, zombie, skeleton, creeper, spider, enderman, night, darkness, shelter, torches, danger]
verified_by: general knowledge of vanilla Java Edition; not yet checked on 26.1
---

Hostile mobs spawn on solid blocks in darkness: in the Overworld, only where the block light is 0. On the surface that means night. Underground, caves are dark at all times.

| Mob | What it does |
| - | - |
| zombie | Walks to you and hits. Burns in daylight. |
| skeleton | Shoots arrows from range. Burns in daylight. |
| creeper | Walks close and explodes after a short fuse. Back away when it hisses. |
| spider | Climbs walls. Hostile in darkness. |
| enderman | Neutral until you look at its face or hit it. Do not look at it. |

To survive the night, stay in an enclosed space with a roof and a light source, or sleep in a bed. Torches stop spawns around them. Two blocks of headroom and closed walls are enough for a shelter.

`bot.nearestEntity((e) => e.type === "hostile")` finds the nearest threat.

Details: `mechanics/creeper-fuse`, `mechanics/skeleton-range`, `mechanics/spider-climbing`, `mechanics/daylight-burning`, and how to fight (`mechanics/combat-basics`). A shelter you can build in one program: `flows/first-night-shelter`.

<!-- builtins -->
`kit.explorer.scan()` lists nearby entities.
<!-- /builtins -->
