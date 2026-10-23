---
title: "bot.sleep throws \"there are monsters nearby\" (and the other sleep errors)"
tags: [sleep, bed, monsters, "there are monsters nearby", error, "not night", "too far", occupied, bot.sleep, zombie]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

`await bot.sleep(bed)` rejects with one of:

| Message | Meaning |
| - | - |
| `it's not night and it's not a thunderstorm` | `timeOfDay` is outside 12541 to 23458. Wait, or build a shelter. |
| `there are monsters nearby` | A hostile mob is near the bed. |
| `the bed is too far` | You stand too far from the bed. |
| `the bed is occupied` | Another player sleeps in it. |
| `wrong block : not a bed block` | The block you passed is not a bed (observed when the bed was not loaded yet). |
| `bot is not sleeping` | The server did not put you to bed within 3 seconds. |

## Cause of "monsters nearby"

Mineflayer checks every loaded entity whose `kind` is `Hostile mobs` against a box around the head of the bed: 8 blocks west or north, 7 east or south, 6 down, 4 up. Observed: a zombie 6.3 blocks away (`e.kind` was `"Hostile mobs"`, `e.type` was `"hostile"`) made the call throw. The mob can stand behind a wall; walls do not count.

## Workaround

Kill the mobs in the box, or move the bed, then call `bot.sleep` again:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext) => {
  const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 })!;
  const head = bed.position;
  const near = Object.values(bot.entities).filter((e) => e.kind === "Hostile mobs" && Math.abs(e.position.x - head.x) < 9 && Math.abs(e.position.z - head.z) < 9 && Math.abs(e.position.y - head.y) < 7);
  for (const mob of near) { /* attack it, see mechanics/combat-basics */ }
  await bot.sleep(bed);
};
```

A mob that burns in daylight (`mechanics/daylight-burning`) is gone by morning, but you can only sleep at night. Rules of beds: `mechanics/beds-and-spawn`.

<!-- builtins:combat -->
`minebot call combat.fight` clears hostile mobs near you before you sleep.
<!-- /builtins:combat -->
