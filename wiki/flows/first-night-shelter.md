---
title: "First night: seal yourself in a stone box and wait for dawn"
tags: [night, shelter, safe, cobblestone, box, roof, walls, hostile, sunset, wait, dawn, survive, plan]
mc_version: "26.1"
verified_by: the build code ran on the 26.1 dev server, 2026-10-19
---

Night starts at `bot.time.timeOfDay` 12541 and ends near 23458 (`mechanics/day-night-cycle`). Hostile mobs spawn in the dark, so be inside before 12000.

You need 10 cobblestone, or any other solid block. A wooden pickaxe digs cobblestone from stone (`flows/first-day`).

1. **Pick flat ground** with open air above, away from water and lava. Stand at the center.
2. **Build the box.** Two rings of four blocks around you, then two roof blocks. The code below places 10 blocks and worked on flat ground:

   ```ts
   import { Vec3 } from "minebot-sdk/routine";
   import type { RoutineContext } from "minebot-sdk/routine";

   export default async ({ bot, sleep }: RoutineContext) => {
     const stone = bot.registry.itemsByName.cobblestone!.id;
     await bot.equip(stone, "hand");
     const base = bot.entity.position.floored();
     const ring = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
     const up = new Vec3(0, 1, 0);
     const put = async (target: Vec3, refOffset: Vec3, face: Vec3) => { await bot.placeBlock(bot.blockAt(target.plus(refOffset))!, face); await sleep(150); };
     for (const r of ring) await put(base.plus(r), new Vec3(0, -1, 0), up);                // lower ring, on the floor
     for (const r of ring) await put(base.plus(r).offset(0, 1, 0), new Vec3(0, -1, 0), up); // upper ring, on the lower ring
     await put(base.offset(1, 2, 0), new Vec3(0, -1, 0), up);                              // roof block on one wall
     await put(base.offset(0, 2, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0));                // roof block over your head
   };
   ```

   Each `placeBlock` needs a solid block to click on, so the order matters: floor, lower ring, upper ring, roof. Observed: all four sides at both heights and the roof block were solid when it finished, and 6 of 16 cobblestone were left. The box has no opening; leave none, because a mob that climbs walls uses any gap it fits through (`mechanics/spider-climbing`).
3. **Wait.** Stay inside until the night ends:

   ```ts
   import type { RoutineContext } from "minebot-sdk/routine";

   export default async ({ bot, sleep, signal }: RoutineContext) => {
     while (bot.time.timeOfDay >= 12000 && !signal.aborted) await sleep(2000);
   };
   ```

   If you have a bed, put it inside instead and sleep (`mechanics/beds-and-spawn`).
4. **Get out.** Dig one wall block and walk out: `await bot.dig(bot.blockAt(base.offset(1, 0, 0)))`. Observed: cobblestone took 10 seconds to dig by hand, so hold a pickaxe. Zombies and skeletons that stayed in the open burn at dawn (`mechanics/daylight-burning`).

Eat before you seal in (`mechanics/food-sources`): the night lasts about 9 minutes.

<!-- builtins -->
`minebot call survival.sleep` skips the night when a bed is in reach and every player on the server sleeps (`mechanics/day-night-cycle`).
<!-- /builtins -->
