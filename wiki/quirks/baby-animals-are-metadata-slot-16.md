---
title: Baby animals have no flag on the entity except metadata slot 16
tags: [animals, baby, breeding, cow, sheep, pig, entity, metadata, zombie]
mc_version: "26.1"
verified_by: observed 2026-10-19 (a cow summoned with Age:-24000, a baby zombie, and a bred calf all had metadata[16] === true; adults left the slot null)
---

## Symptom

`bot.nearestEntity((e) => e.name === "cow")` returns a calf as often as a cow. Feeding wheat to a calf does not breed it; the calf only grows up faster. The entity has no `isBaby` field and its `height` is the adult's.

## Cause

Mineflayer 4.39 passes the entity's raw metadata through. Ageable mobs (animals and zombies) keep the baby flag in slot 16 of `entity.metadata`. The slot holds `true` for a baby and is `null` or missing for an adult.

## Workaround

```ts
import type { Entity } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default ({ bot }: RoutineContext) => {
  const isBaby = (e: Entity) => (e.metadata?.[16] as unknown) === true;
  const adults = Object.values(bot.entities).filter((e) => e.name === "cow" && !isBaby(e));
  return adults.map((e) => e.id);
};
```

To find the calf that a breeding produced, poll for a cow with the flag that was not in the world before.

<!-- builtins:farm -->
`minebot call farm.breed --args '{"animal":"cow"}'` picks adults only and reports the baby it sees.
<!-- /builtins:farm -->
