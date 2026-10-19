---
title: Day and night timing
tags: [time, day, night, sunset, sunrise, bed, sleep, timeOfDay]
verified_by: general knowledge of vanilla Java Edition; not yet checked on 26.1
---

A full day is 24000 ticks, or 20 minutes. `bot.time.timeOfDay` runs from 0 to 23999.

| timeOfDay | Phase |
| - | - |
| 0 to about 12000 | Day |
| about 12000 to 13000 | Sunset; prepare a shelter |
| about 13000 to 23000 | Night; hostile mobs spawn on the surface |
| about 23000 to 24000 | Sunrise |

`bot.time.isDay` is a shortcut. A bed skips the night when enough players sleep in beds. By default, every player in the world must sleep, so with several bots, all of them must sleep. With Mineflayer: `await bot.sleep(bedBlock)`.
