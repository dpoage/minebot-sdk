---
title: Kits are composable libraries of actions you can swap
tags: [kits, kit, actions, gather, craft, build, explore, social, swap, primitives]
requires: [kits]
verified_by: "smoke-tested on the 26.1 dev server, 2026-10-18"
mc_version: "26.1"
---

A kit is a library of actions for one kind of work. Programs call them namespaced, with one object argument: `await kit.move.to({ position: [x, y, z] })`. Every action validates its arguments and fails with its schema if a call is wrong.

Kits come in two layers. Primitives are small kits that do one thing; routine kits are built out of them:

| Primitive | For |
| - | - |
| `move` | Walking to a position with a time limit; stopping. |
| `sense` | Finding blocks by name pattern; facing a position. |
| `dig` | Digging one block with the right tool; falling blocks included. |
| `place` | Placing one block, digging out what is in the way. |
| `inventory` | Listing, counting, equipping, and tossing items. |
| `craft` | Crafting at a table within reach; finding one. |
| `items` | Recipe lookups; dropped items on the ground. |
| `furnace` | Smelting at a furnace within reach: fuel, input, output. |
| `container` | Listing a chest, barrel, or shulker box; depositing and withdrawing items. |
| `survival` | Eating the best food, sleeping in a bed and waking, wearing the best armor. |
| `combat` | Hitting a creature, fighting hostiles until none are near, backing away. |
| `farm` | Tilling, planting, harvesting ripe crops, breeding animals. |
| `bucket` | Filling a bucket from a water or lava source; pouring it out. |

| Routine kit | Uses | For |
| - | - | - |
| `gatherer` | move, sense, dig, inventory, items | Digging matching blocks and picking up the drops (`gather`). |
| `crafter` | move, sense, place, inventory, craft, items, furnace | Crafting chains (`make`), smelting furnace outputs, finding or placing crafting tables and furnaces. |
| `builder` | move, sense, dig, place, inventory | Building structures from blueprints. |
| `explorer` | move, sense, dig | Scanning, exploring, remembering places (`remember`, `places`), and climbing out of holes (`surface`). |
| `social` | move, sense, inventory | Chat, following, and giving items to other players. |

- `kits.active` lists the active kits; `kits.available()` lists everything the body offers.
- `kits.use("gatherer", "crafter")` swaps the active set, unless the body locks kits. Used kits activate automatically.
- `kits.docs()` prints the action reference: call shape, argument types, and defaults, straight from each action's schema.
- `kits.search("collect logs")` ranks the kits and actions by name and description, so you can find the one that does a job. Each kit in `kits.available()` also shows how often its actions worked on this body.

A routine kit reaches another kit only through the public actions of the kits it declares in `uses`, so anything a routine kit does, you can do too — and combine differently.

<!-- agentKits -->
## Your own kits

You can save kits of your own, in the same shape as the built-ins: one import from `minebot-sdk/kit` (the only import a kit may have), then one exported kit (`export default`, or `export const <name> = defineKit(...)` as the built-ins are written; other exports are ignored):

```ts
import { action, defineKit, Point, z } from "minebot-sdk/kit";

export default defineKit(
  { name: "woodcutter", description: "Chops the nearest logs and reports where the player ends up.", uses: ["move", "sense", "dig"] },
  {
    chop: action({
      doc: "Walks to each of the `times` nearest logs within 16 blocks and digs it. Returns how many it dug and where the player then stands.",
      args: z.object({ times: z.number().int().positive().default(1) }),
      returns: z.object({ chopped: z.number(), standingAt: Point }),
      run: async (ctx, { times }) => {
        const logs = await ctx.kits.sense.find({ blocks: "*_log", radius: 16, count: times });
        for (const log of logs) {
          await ctx.kits.move.to({ position: log, range: 3 });
          await ctx.kits.dig.dig({ at: log });
        }
        const here = ctx.bot.entity.position.floored();
        return { chopped: logs.length, standingAt: { x: here.x, y: here.y, z: here.z } };
      },
    }),
  },
);
```

Save it from a program with `await kits.save(source)`, or from the terminal with `minebot kits save <file>`. Nothing is written when the source is rejected: it must compile, use only kits this body offers, not take a built-in kit's name, and pass the escape audit. `kits.source("move")` prints a built-in kit's source — start from it. A saved kit is offered and active immediately. Several bodies can share the kit directory: a kit one body saves works on the others without a restart. Run an action once before you save the kit with `kits.try(source, { action, args })`, and take a save back with `kits.revert(name, version)`; see `minebot/writing-kits`.
<!-- /agentKits -->
