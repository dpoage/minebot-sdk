---
title: Spiders climb walls, so a wall does not stop them but a roof does
tags: [spider, cave_spider, climb, wall, mobs, night, danger, string, spider_eye, shelter, gap, width]
verified_by: "size from minecraft-data 26.1 and burning observed on the 26.1 dev server, 2026-10-19; climbing and neutrality in light are general knowledge, not yet checked"
---

## Symptom

A mob you thought was blocked by a wall comes over the top of it.

## What to know

[INFERENCE] From vanilla: spiders and cave spiders climb any vertical wall they touch. So a shelter needs a roof, not only walls (`flows/first-night-shelter`).

Size decides which gaps they use. From the registry: a spider is 1.4 blocks wide and 0.9 tall, so it does not fit through a gap one block wide. A cave spider is 0.7 wide and 0.5 tall, and it does. Leave no one-block opening in a wall or roof that a cave spider can reach.

Observed: a spider in daylight did not burn (`mechanics/daylight-burning`), unlike zombies and skeletons, so a spider is still there in the morning. A spider drops 0 to 2 `string` and, when a player kills it, `spider_eye` (`reference/mobs-hostile`).

## With Mineflayer

Find them and fight on flat ground:

```js
const spider = bot.nearestEntity((e) => e.name === "spider" || e.name === "cave_spider");
```

Fight rules: `mechanics/combat-basics`.
