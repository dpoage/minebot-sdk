---
title: "First day: from nothing to stone tools and a safe night"
tags: [start, early game, wood, tools, pickaxe, shelter, food, plan]
verified_by: "steps 1-4 ran in the minebot oracle on 26.1 (2026-10-18); steps 5-6 are general knowledge"
---

You start with an empty inventory at about `timeOfDay` 0. Night starts at about 13000, so you have about 10 minutes.

Run this module once to store these helpers on `globalThis`, and reuse them in every step. They stay until the bot host restarts, so run the module again after a restart. A helper that needs the bot takes `ctx`, because each run has its own `ctx`. They put a time limit on every move and dig (see `quirks/pathfinding-needs-a-timeout`) and walk over the drops (see `quirks/drops-fall-out-of-reach`):

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

declare global {
  var within: <T>(ms: number, label: string, work: Promise<T>, cancel: () => void) => Promise<T>;
  var itemId: (ctx: RoutineContext, name: string) => number;
  var count: (ctx: RoutineContext, match: (name: string) => boolean) => number;
  var collect: (ctx: RoutineContext, names: (name: string) => boolean, enough: () => boolean) => Promise<void>;
  var isLog: (name: string) => boolean;
}

export default () => {
  globalThis.within = async (ms, label, work, cancel) => {
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => { cancel(); expired.reject(new Error(`${label} took longer than ${ms} ms`)); }, ms);
    try { return await Promise.race([work, expired.promise]); } finally { clearTimeout(timer); }
  };
  globalThis.itemId = ({ bot }, name) => bot.registry.itemsByName[name]!.id;
  globalThis.count = ({ bot }, match) => bot.inventory.items().filter((i) => match(i.name)).reduce((n, i) => n + i.count, 0);
  // Digs blocks until `enough()` is true. `names` is a predicate on block names.
  globalThis.collect = async ({ bot, signal, sleep, log }, names, enough) => {
    const ids = Object.values(bot.registry.blocksByName).filter((b) => names(b.name)).map((b) => b.id);
    const skipped = new Set<string>();
    let failures = 0;
    while (!enough()) {
      if (signal.aborted) throw signal.reason;
      // Prefer blocks at your own height: high ones need scaffolding.
      const target = bot.findBlocks({ matching: ids, maxDistance: 48, count: 64 })
        .filter((p) => !skipped.has(p.toString()))
        .sort((a, b) => Math.abs(a.y - bot.entity.position.y) - Math.abs(b.y - bot.entity.position.y) || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0];
      if (!target) throw new Error("no matching block within 48 blocks; walk somewhere else and try again");
      try {
        await within(45000, "goto", bot.pathfinder.goto(new goals.GoalLookAtBlock(target, bot.world)), () => bot.pathfinder.stop());
        const block = bot.blockAt(target)!;
        const tool = bot.pathfinder.bestHarvestTool(block); // a stone block dug by hand drops nothing
        if (tool) await bot.equip(tool, "hand");
        if (!block.canHarvest(bot.heldItem?.type ?? null)) throw new Error(`cannot harvest ${block.name} with ${bot.heldItem?.name ?? "an empty hand"}`);
        await within(20000, "dig", bot.dig(block), () => bot.stopDigging());
        await sleep(400);
        for (const e of Object.values(bot.entities)) {
          if (e.name !== "item" || e.position.distanceTo(bot.entity.position) > 8) continue;
          const p = e.position.floored();
          await within(10000, "pickup", bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z)), () => bot.pathfinder.stop()).catch(() => {});
        }
      } catch (err) {
        skipped.add(target.toString());
        if (++failures > 12) throw new Error(`gave up: ${(err as Error).message}`);
        log(`skipping ${target}: ${(err as Error).message}`);
      }
    }
  };
  globalThis.isLog = (n) => n.endsWith("_log") && !n.startsWith("stripped_");
};
```

1. **Logs.** Collect 4 or more logs. Run this module with `--timeout 300000`.

   ```ts
   import type { RoutineContext } from "minebot-sdk/routine";

   export default (ctx: RoutineContext) => collect(ctx, isLog, () => count(ctx, isLog) >= 4);
   ```
2. **Wooden pickaxe.** Each log type makes its own planks, and any planks work. Craft planks from the logs, then a crafting table and sticks. A pickaxe is a 3x3 recipe, so place the table first (see `quirks/table-recipes-need-the-table-block` and `quirks/canopy-breaks-block-placement`) and pass it to `recipesFor` and `craft`. See `mechanics/crafting-basics`.

   ```ts
   import { goals, Vec3 } from "minebot-sdk/routine";
   import type { Block, RoutineContext } from "minebot-sdk/routine";

   export default async (ctx: RoutineContext) => {
     const { bot, log } = ctx;
     for (const i of bot.inventory.items().filter((i) => isLog(i.name))) {
       await bot.craft(bot.recipesFor(itemId(ctx, i.name.replace(/_log$/, "_planks")), null, 1, null)[0]!, i.count);
     }
     await bot.craft(bot.recipesFor(itemId(ctx, "crafting_table"), null, 1, null)[0]!, 1);
     await bot.craft(bot.recipesFor(itemId(ctx, "stick"), null, 1, null)[0]!, 1);
     const air = (p: Vec3) => ["air", "cave_air"].includes(bot.blockAt(p)?.name ?? "");
     const spots = bot.findBlocks({ matching: (b) => b.boundingBox === "block" && !/_leaves$|_log$/.test(b.name), maxDistance: 8, count: 100 })
       .filter((p) => p.distanceTo(bot.entity.position) > 1.5 && air(p.offset(0, 1, 0)) && air(p.offset(0, 2, 0)));
     await bot.equip(itemId(ctx, "crafting_table"), "hand");
     let table: Block | null = null;
     for (const ground of spots.slice(0, 8)) {
       try {
         await within(15000, "goto", bot.pathfinder.goto(new goals.GoalNear(ground.x, ground.y + 1, ground.z, 3)), () => bot.pathfinder.stop());
         await bot.placeBlock(bot.blockAt(ground)!, new Vec3(0, 1, 0));
         table = bot.blockAt(ground.offset(0, 1, 0));
         break;
       } catch (err) {
         log(`table: ${(err as Error).message}`);
       }
     }
     if (!table) throw new Error("found no spot for the crafting table");
     // Craft within reach of the table.
     await within(15000, "goto", bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2)), () => bot.pathfinder.stop());
     await bot.craft(bot.recipesFor(itemId(ctx, "wooden_pickaxe"), null, 1, table)[0]!, 1, table);
   };
   ```
3. **Cobblestone.** Mine at least 3 stone with the pickaxe; it drops cobblestone. Mine 11 if you also want a furnace. If no stone is in sight, dig down at an angle, or walk to a hillside.

   ```ts
   import type { RoutineContext } from "minebot-sdk/routine";

   export default (ctx: RoutineContext) => collect(ctx, (n) => n === "stone", () => count(ctx, (n) => n === "cobblestone") >= 3);
   ```
4. **Stone tools.** Walk back to within 2 blocks of the table (or place a new one), then craft with `ctx.bot.recipesFor(itemId(ctx, "stone_pickaxe"), null, 1, table)[0]`. A stone sword and axe help too.
5. **Food.** Kill animals for meat, or collect wheat. See `mechanics/hunger-and-health`.
6. **Shelter before 12500.** Dig into a hillside or build walls and a roof. Light it if you have coal for torches. See `mechanics/hostile-mobs-and-night`.

Check the result after each step with `ctx.bot.inventory.items()`. Do not assume a step worked because the call returned.

<!-- builtins:crafter,gatherer -->
Steps 1-4 are one call each:

```sh
minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'
minebot call crafter.make --args '{"item":"wooden_pickaxe"}'
minebot call gatherer.gather --args '{"blocks":"stone","count":3}'
minebot call crafter.make --args '{"item":"stone_pickaxe"}'
```
<!-- /builtins:crafter,gatherer -->
<!-- builtins:inventory -->

`minebot call inventory.list` shows the result.
<!-- /builtins:inventory -->
