---
title: Farmland needs water within 4 blocks, or it turns back into dirt
tags: [farmland, hydration, moisture, water, dirt, hoe, till, farming, soil, dry]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

A row of farmland you made turns into plain dirt, and seeds you planted on it pop off or never grow.

## Rule

Farmland has a `moisture` state from 0 (dry) to 7 (wet). Water close to it keeps it at 7. Observed with a water source and farmland in a straight line, at the same height, on random-tick speed 300:

| Distance from the water | Result |
| - | - |
| 2, 3, or 4 blocks | `moisture` 7 |
| 5 or more blocks | `moisture` 0 |

Dry farmland with no crop on it turned back into dirt (observed at 6 blocks). Dry farmland with a crop on it stayed farmland (observed at 7 blocks).

So put every farmland block within 4 blocks of a water source. One source in the middle of a 9-wide row is enough.

## Make farmland

Use a hoe on the top face of a dirt or grass block:

```ts
import { Vec3 } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext, { x, y, z }: { x: number; y: number; z: number }) => {
  await bot.equip(bot.inventory.items().find((i) => i.name.endsWith("_hoe"))!, "hand");
  await bot.activateBlock(bot.blockAt(new Vec3(x, y, z))!, new Vec3(0, 1, 0)); // x, y, z: the dirt block
};
```

Observed: `dirt` became `farmland` after one use. Read the moisture with `Number(bot.blockAt(position).getProperties().moisture)` (see `quirks/block-properties-are-strings`).

Place a water source with a bucket (`mechanics/buckets`). Plant on the farmland and harvest as in `mechanics/crop-growth`.

<!-- builtins:farm -->
`minebot call farm.till --args '{"at":[10,64,5]}'` tills one block.
<!-- /builtins:farm -->
