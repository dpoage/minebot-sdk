---
title: "Build a nether portal: 10 obsidian, flint and steel, then stand in it"
tags: [nether, portal, nether portal, obsidian, flint_and_steel, frame, dimension, ignite, light, travel, return]
mc_version: "26.1"
verified_by: every step ran on the 26.1 dev server, 2026-10-19
---

## What you need

- 10 obsidian. The frame is 4 blocks wide and 5 tall around an opening of 2 by 3. The 4 corners are not needed, so it takes 10 blocks.
- Flint and steel: 1 `iron_ingot` and 1 `flint`, shapeless.
- Some cobblestone for scaffolding, and a pickaxe to take it away again.

Obsidian needs a diamond pickaxe (`mechanics/tool-tiers`). You can also make it by pouring water on a lava source (`mechanics/water-and-lava`).

## Steps

1. **Build the frame** on flat ground. Each `placeBlock` needs a solid block to click on, and a frame without corners has nothing to click on at its top, so use 4 cobblestone corners as scaffolding. This code builds a frame in the plane `z = z0`, running along x, standing in front of it. `(x0, y0)` is the lowest, westmost corner:

   ```ts
   import { Vec3 } from "minebot-sdk/routine";
   import type { RoutineContext } from "minebot-sdk/routine";

   export default async ({ bot, sleep }: RoutineContext, { x0, y0, z0 }: { x0: number; y0: number; z0: number }) => {
     const obsidian = bot.registry.itemsByName.obsidian!.id;
     const cobble = bot.registry.itemsByName.cobblestone!.id;
     const up = new Vec3(0, 1, 0);
     const at = (dx: number, dy: number) => new Vec3(x0 + dx, y0 + dy, z0);
     const place = async (item: number, p: Vec3, ref: Vec3, face: Vec3) => {
       await bot.equip(item, "hand");
       await bot.placeBlock(bot.blockAt(ref)!, face);
       await sleep(120);
       if (bot.blockAt(p)!.name === "air") throw new Error(`nothing at ${p}`);
     };
     await place(cobble, at(0, 0), at(0, -1), up);                  // corners hold the columns
     await place(cobble, at(3, 0), at(3, -1), up);
     for (const dx of [1, 2]) await place(obsidian, at(dx, 0), at(dx, -1), up); // bottom row
     for (const dx of [0, 3]) for (let dy = 1; dy <= 3; dy++) await place(obsidian, at(dx, dy), at(dx, dy - 1), up); // columns
     await place(cobble, at(0, 4), at(0, 3), up);                  // top corners hold the top row
     await place(cobble, at(3, 4), at(3, 3), up);
     await place(obsidian, at(1, 4), at(0, 4), new Vec3(1, 0, 0));  // top row, against the corner
     await place(obsidian, at(2, 4), at(1, 4), new Vec3(1, 0, 0));
     for (const [dx, dy] of [[0, 4], [3, 4], [0, 0], [3, 0]] as const) await bot.dig(bot.blockAt(at(dx, dy))!); // take the scaffold away
   };
   ```

   Observed: this ended with obsidian in a ring of 10 around an empty 2 by 3 opening. `bot.dig` throws with an enchanted tool: see `quirks/enchanted-tools-break-bot-dig`.
2. **Light it.** Hold flint and steel and click the top of a bottom obsidian block:

   ```ts
   import { Vec3 } from "minebot-sdk/routine";
   import type { RoutineContext } from "minebot-sdk/routine";

   export default async ({ bot }: RoutineContext, { x0, y0, z0 }: { x0: number; y0: number; z0: number }) => {
     await bot.equip(bot.inventory.items().find((i) => i.name === "flint_and_steel")!, "hand");
     await bot.placeBlock(bot.blockAt(new Vec3(x0 + 1, y0, z0))!, new Vec3(0, 1, 0)); // the top of a bottom obsidian block
   };
   ```

   Observed: 6 `nether_portal` blocks filled the opening. A frame with an opening of 2 by 2 got fire and no portal.
3. **Stand in it.** Walk into the opening and stay there. After about 4 seconds you are in the Nether: observed 4.1 seconds from the first tick inside to the `respawn` event, and `bot.game.dimension` was then `the_nether`. Walking straight through is too fast to count:

   ```ts
   import type { RoutineContext } from "minebot-sdk/routine";

   export default async ({ bot, sleep }: RoutineContext) => {
     const arrived = new Promise<void>((res) => bot.once("respawn", () => res()));
     // stand in a portal block, then wait:
     await Promise.race([arrived, sleep(15000)]);
     return bot.game.dimension;
   };
   ```
4. **Arrive.** Observed: from a portal near (12021, 101, 10) the bot arrived at (1496, 83, 2), about one eighth of the distance, and 6 `nether_portal` blocks stood around it. The game had made a portal there.
5. **Go back.** Step out of the portal and walk back in, and wait 4 seconds. Observed: the bot came out in the overworld at the portal it had used. A second portal built 14 blocks away from the first led to the same nether portal, because the game links to the nearest one.

What is on the other side: `mechanics/the-nether`.
