You control a Minecraft player named `agent` in a vanilla survival world (Minecraft Java Edition 26.1, Easy difficulty). No one else is playing. The player starts with an empty inventory.

## Goal

Craft a wooden pickaxe.

## How to act

The `minebot` command in this terminal controls the player. The same actions are available as `minebot` MCP tools.

- `minebot observe` prints the position, health, inventory, and nearby entities as JSON.
- `minebot run <file>` runs a module (TypeScript or JavaScript) against the player and prints its logs and result. Without a file, it reads the module from stdin. `--args <json>` passes arguments.
- `minebot api` prints how a run works and what its context `ctx` holds on this body.
- `minebot events` prints recent chat, damage, and deaths.
- `minebot stop` aborts the running run.

The API references are at `/opt/minebot/node_modules/mineflayer/docs/api.md` and `/opt/minebot/node_modules/mineflayer-pathfinder/readme.md`.

## Runs

A run is a module. Its default export is a function: the body calls it with `ctx` and the `--args` object, and sends back what it returns. `ctx.bot` is the live Mineflayer bot; `ctx.log`, `ctx.sleep`, `ctx.signal`, `ctx.notes`, and `ctx.store` come with it. A module uses named imports from Node's core modules and from the packages that the body ships (`mineflayer-pathfinder`, `vec3`, `minecraft-data`), and `require()` works too. Save this as `look.ts`, then run `minebot run look.ts`:

```ts
import { Vec3 } from "vec3";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  const mcData = require("minecraft-data")(ctx.bot.version);
  const feet = ctx.bot.entity.position.floored();
  const below = ctx.bot.blockAt(feet.plus(new Vec3(0, -1, 0)));
  ctx.log("standing on", below?.name);
  return { feet, below: below?.name, logId: mcData.itemsByName.oak_log.id };
};
```

A run stops after 60 seconds unless you pass `--timeout <ms>`. Check `ctx.signal.aborted` in long loops. One run goes at a time. Values that you store on `globalThis` persist between runs.

## Routines

A routine is a module that you save in the body's library and call by name. The body keeps the library and the bindings. `minebot routines save <file...>` saves each file under its file name without the extension, and reports the type errors of its source (they do not stop the save). Save the modules that a routine imports first, and import them as `./<name>.ts`. `minebot routines` lists the routines and their bindings, and `minebot routines source <name>` prints one. `defineRoutine` from `minebot-sdk/routine` adds a description and zod schemas for the arguments and the result.

`minebot bind action <name> <routine>` names a routine for `minebot call <name> --args <json>`, which runs it like `minebot run` (same timeout, one run at a time). `minebot unbind <name>` removes a binding. Save this as `where.ts`:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext, args: { note?: string }) => {
  const { x, y, z } = ctx.bot.entity.position;
  ctx.log(args.note ?? "position");
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), health: ctx.bot.health };
};
```

```sh
minebot routines save where.ts
minebot bind action pos where
minebot call pos --args '{"note":"now"}'
```

## Reflexes

A reflex is a routine that the body runs when an event arrives, so a reaction does not wait for your next turn. `minebot bind reflex <name> <routine> --on <events>` binds one, and the body calls the routine as `(ctx, { event })`, where `event` is `{ seq, type, time, data }`. The events include `hurt`, `death`, `chat`, `low_health` (health below 8), `low_food` (food below 6), `hostile_near` (a hostile creature within 16 blocks), `night`, and `day`. Options: `--cooldown <ms>` (default 1000), `--timeout <ms>` (default 30000), `--priority <n>`, `--preempt` (the firing stops the running run), `--when <expression>`, and `--from` and `--match` for chat. A firing waits until no run is active unless it preempts. A reflex that fails 3 times in a row disables itself; bind it again to enable it. `minebot routines` shows what each reflex did, and `minebot unbind <name>` removes one. Save this as `eat.ts`, then run `minebot routines save eat.ts` and `minebot bind reflex eater eat --on low_food`:

```ts
import type { BodyEvent } from "minebot-sdk/client";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext, { event }: { event?: BodyEvent }) => {
  const food = ctx.bot.inventory.items().find((item) => ctx.bot.registry.foodsByName[item.name]);
  if (!food) return { ate: null, on: event?.type };
  await ctx.bot.equip(food, "hand");
  await ctx.bot.consume();
  return { ate: food.name, on: event?.type };
};
```

## Built-in routines

The body offers these built-in routines, which take `ctx` and one object of arguments: move, sense, dig, place, inventory, craft, items, furnace, gatherer, crafter, builder, explorer, social. `minebot builtins docs [module...]` prints every routine with its arguments and result, and `minebot builtins search <query>` finds routines by what they do. Call one from the terminal with `minebot call <module>.<routine> --args <json>`, with no bind: `minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'`. A run or a routine imports a module as `minebot-sdk/routines/<module>` and calls its routines with `ctx`:

```ts
import * as gatherer from "minebot-sdk/routines/gatherer";
import * as crafter from "minebot-sdk/routines/crafter";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  await gatherer.gather(ctx, { blocks: "*_log", count: 4 });
  return crafter.make(ctx, { item: "wooden_pickaxe" });
};
```

## Grading

The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice. You cannot run server commands.
