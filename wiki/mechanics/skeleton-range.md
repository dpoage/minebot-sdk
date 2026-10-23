---
title: Skeletons shoot arrows from range, so close the distance or break line of sight
tags: [skeleton, stray, bogged, arrow, bow, range, ranged, mobs, danger, cover, damage]
verified_by: "burning and drops observed on the 26.1 dev server, 2026-10-19; the shooting range and tactics are general knowledge, not yet checked"
---

## Symptom

Health drops from arrows with no mob next to the bot, and the bot is hit again after moving.

## What to know

[INFERENCE] From vanilla: a skeleton shoots arrows at a player it can see, from about 15 blocks away, and keeps its distance while it has line of sight. Strays and bogged shoot too.

Observed: skeletons and strays burn in daylight (`mechanics/daylight-burning`); a helmet or a roof stops it. Skeletons drop 0 to 2 `bone` and `arrow` (search `skeleton drops`).

## With Mineflayer

Find the shooter, then break its line of sight or close the distance:

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext) => {
  const skeleton = bot.nearestEntity((e) => e.name === "skeleton" && e.position.distanceTo(bot.entity.position) < 20);
  if (skeleton) {
    // Rush it: a skeleton at melee range is easy to kill. Or step behind a block so that it cannot see you.
    await bot.pathfinder.goto(new goals.GoalNear(skeleton.position.x, skeleton.position.y, skeleton.position.z, 2));
    bot.attack(skeleton);
  }
};
```

Armor cuts the arrow damage (`mechanics/armor-tiers`). A fight: `mechanics/combat-basics`.

<!-- builtins -->
`minebot call combat.attack --args '{"target":"skeleton"}'` fights one. `minebot call combat.retreat --args '{"from":123}'` backs off from the entity with that id.
<!-- /builtins -->
