---
title: Built-in routines are ready-made actions that you call by name
tags: [built-in routines, builtins, routines, actions, call, import, gather, craft, build, explore, social, primitives, docs, search, source, stats]
requires: [builtins]
verified_by: "calls, docs, search, source, stats, and imports checked on the 26.1 dev server, 2026-10-22"
mc_version: "26.1"
---

A built-in routine is a ready-made action for one kind of work, such as walking to a position or digging a block. Built-in routines come in modules. You call a routine as `<module>.<routine>` with one object argument. Every call checks its arguments and fails with the schema when an argument is wrong.

<!-- builtins:move -->
```sh
minebot call move.to --args '{"position":[10,64,10],"range":2,"timeoutMs":30000}'
```
<!-- /builtins:move -->
<!-- builtins:gatherer -->
```sh
minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'
```
<!-- /builtins:gatherer -->

A call is a run. It prints the status, the logs, and the result, and only one run goes at a time. The default timeout is 60 seconds (`--timeout <ms>`). The MCP tool `call_routine` takes the same name and `args`. Without `--args`, a call passes `{}`.

A module is either a primitive or a composite. A primitive does one thing. A composite calls the routines of the primitives it uses:

| Primitive | For |
| - | - |
| `move` | Walking to a position with a time limit; stopping. |
| `sense` | Finding blocks by name pattern; facing a position. |
| `dig` | Digging one block with the right tool; falling blocks included. |
| `place` | Placing one block, digging out what is in the way. |
| `inventory` | Listing, counting, equipping, and tossing items. |
| `craft` | Crafting at a table within reach; finding one. |
| `items` | Recipe lookups; dropped items on the ground; renaming an item at an anvil. |
| `furnace` | Smelting at a furnace within reach: fuel, input, output. |
| `container` | Listing a chest, barrel, or shulker box; depositing and withdrawing items. |
| `survival` | Eating the best food, sleeping in a bed and waking, wearing the best armor. |
| `combat` | Hitting a creature, fighting hostiles until none are near, backing away. |
| `farm` | Tilling, planting, harvesting ripe crops, breeding animals. |
| `bucket` | Filling a bucket from a water or lava source; pouring it out. |

| Composite | Uses | For |
| - | - | - |
| `gatherer` | move, sense, dig, inventory, items | Digging matching blocks and picking up the drops (`gather`). |
| `crafter` | move, sense, place, inventory, craft, items, furnace | Crafting chains (`make`), smelting furnace outputs, finding or placing crafting tables and furnaces. |
| `builder` | move, sense, dig, place, inventory | Building structures from blueprints. |
| `explorer` | move, sense, dig | Scanning, exploring, remembering places (`remember`, `places`), and climbing out of holes (`surface`). |
| `social` | move, sense, inventory | Chat, following, and giving items to other players; gestures (nod, wave, and more); writing a sign or a book. |

## Find the routine for a job

- `minebot builtins` lists the modules this body offers, what each uses, and how often each routine worked and failed on this body, with the message of the last failure.
- `minebot builtins docs [module...]` prints the call shape, the argument types and defaults, and the return value of each routine. Without a module name, it prints every offered module.
- `minebot builtins search "collect logs"` ranks routines and modules by name, description, and argument names (`--limit <n>`, default 5).
- `minebot builtins source move` prints the source file of a module. Read it when you need to know exactly what a routine does.

The MCP tools `builtin_docs` and `builtin_search` print the reference and search it; with `--tools full`, `list_builtins` and `builtin_source` do the other two.

The body counts every call of a built-in routine, including the calls that one routine makes to another and the calls from your own code, and it keeps the counts across restarts. When two routines do the same job, call the one that works, and read the last failure before you call the other.

## Call a routine from your own code

A run imports a module and calls its routines with the run's `ctx`. The imports must name a module that this body offers.
<!-- builtins:crafter,gatherer -->

```ts
import * as crafter from "minebot-sdk/routines/crafter";
import * as gatherer from "minebot-sdk/routines/gatherer";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  const { gained } = await gatherer.gather(ctx, { blocks: "*_log", count: 4 });
  const planks = await crafter.make(ctx, { item: "oak_planks", count: 8 });
  return { gained, planks };
};
```

Save the file as `logs.ts` and run it with `minebot run logs.ts`.
<!-- /builtins:crafter,gatherer -->

Calls from your own code validate their arguments like any other call, and a composite reaches other modules only through their public routines, so anything a composite does, you can do too, and combine differently.

<!-- routines -->
## Your own routines

A routine that you save calls built-in routines the same way. Save a routine of your own to call it by name later: see `minebot/routines`. To compose built-in routines into one, test it without a server, and save it, see `minebot/writing-kits`.
<!-- /routines -->
