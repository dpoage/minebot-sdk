---
title: Try, save, and revert your own kit
tags: [kits, agent kits, defineKit, action, try, save, revert, versions, search, stats, authoring]
requires: [agentKits]
verified_by: "smoke-tested on the 26.1 dev server, 2026-10-19"
mc_version: "26.1"
---

Write a kit when you repeat the same steps in program after program. Search first: another kit may already do it. Then try your source against the live body before you save it. A saved kit stays, so a mistake costs more than a failed try.

## Find a kit that already does it

```js
return kits.search("collect logs");
```

`kits.search(query, limit?)` ranks the kits and actions this body offers by name, kit description, and action doc. Each hit names the kit or the call, says whether the kit is active, and shows how often the action worked on this body. From the terminal: `minebot kits search "collect logs"`.

## Write it

A kit is one file: an import, then one exported kit.

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

`import { ... } from "minebot-sdk/kit"` is the only import a kit may have, and it is the whole authoring surface: `defineKit`, `action`, `z`, and the helpers the built-in kits use (`nameMatcher`, `NamePattern`, `Position`, `Point`, `toVec3`, `Vec3`, `goals`, `Movements`, `isAir`, `within`, and more). Only named imports work; `import type` from anywhere is erased; any other specifier, `require`, `import()`, and `import.meta` are rejected (the scan skips comments, strings, and templates, and `import()` is blocked again when the kit runs), and so is the old form that used `defineKit`, `action`, and `z` as globals. The source exports exactly one kit: `export default defineKit(...)`, or `export const <name> = defineKit(...)` as the built-in kits are written. Other `export const` and `export function` declarations are allowed and ignored, so a built-in kit's source, printed by `kits.source("move")`, can be saved under a new name as it is. `defineKit({ name, description, uses }, actions)` takes the identity first and the actions second, so that `ctx.kits` inside every action is typed from `uses`. `uses` names the kits `run` calls through `ctx.kits`; `ctx` also holds `bot`, `log`, `sleep`, `signal`, `on`, `within`, and `store`, a JSON store that only this kit reads. Every call through `ctx.kits` returns a promise: `await` it.

`returns` is a zod schema of what the action returns. `run` must produce a value that fits it, callers get the validated result (zod strips keys the schema does not list), and a result that does not fit fails the call with `kit.<kit>.<action> returned a value that does not match its returns schema`. Use `z.void()` for an action that returns nothing, `Point` for a position, and an object schema for anything with fields. `kits.docs()` shows each action's `Returns:` shape. Print a built-in kit with `kits.source("move")` and start from it. Write each `doc` to say what the action does, because `kits.search` and `kits.docs()` show it.

## Try it first

```js
const source = notes.get("kits/woodcutter");
return kits.try(source, { action: "chop", args: { times: 1 } });
```

`kits.try(source, { action, args })` compiles and audits the source exactly as a save does, then calls the action once, inside your program, against the live bot. It returns the action's result, or throws its error, so a broken action shows its message in the run. Nothing is saved or registered, the `ctx.store` of your kit and of every kit it calls is thrown away, and no call is counted in the statistics. The kits in `uses` must be offered and active. From the terminal: `minebot kits try woodcutter.ts --action chop --args '{"times":1}'`.

## Save it, and take it back

`kits.save(source)` writes the kit and offers it at once. Saving over a kit keeps the old source:

```js
await kits.versions("woodcutter");   // [{ version: 1, savedAt, savedBy, current: false }, { version: 2, ..., current: true }]
await kits.revert("woodcutter", 1);  // saves version 1 again, as version 3
```

Every save of a different source is a new version, and a revert is a save, so a revert can be reverted. `savedBy` is the name of the body that saved it. The versions sit in `.history/<kit>/` inside the agent-kit directory, so bodies that share the directory share the history, and a kit you remove can still be reverted to. From the terminal: `minebot kits versions woodcutter` and `minebot kits revert woodcutter 1`.

## Check it with a type checker

A harness with a file system can write kits in a workspace instead: `minebot init ws` scaffolds one, the body loads `ws/kits/*.ts` when it runs with `--agent-kits ./kits`, and `minebot types --out minebot-env.d.ts` writes declarations for this body's kits and program globals, so `npx tsc` reports a wrong argument before you try or save anything. A saved kit and a try are not type-checked by the body.

## Test it without a server

A harness with a file system can also test a kit before the body loads it. `minebot-sdk/testing` runs the kit's actions through the real kit framework (argument and result validation, `uses`, stores) against a fake bot on the real 26.1 registry, with no Minecraft server:

```ts
import { createKitHarness } from "minebot-sdk/testing";
import woodcutter from "../kits/woodcutter.ts";

const h = createKitHarness({ kits: [woodcutter], blocks: [{ name: "oak_log", from: [6, 64, 0], to: [6, 66, 0] }] });
await h.call("woodcutter.chop", { times: 2 }); // { chopped: 2, standingAt: { x: 5, y: 64, z: 0 } }
h.count("oak_log"); // 2: the drops are in the inventory
h.blockAt([6, 64, 0]).name; // "air"
```

It tests decisions, not physics: digging is instant, pathfinding teleports next to the goal, and a Mineflayer API it does not implement (`bot.attack`, `bot.sleep`, `bot.openContainer`) throws `not supported by minebot-sdk/testing: <api>` instead of returning `undefined`. A passing test shows the kit's logic holds; `kits.try` shows how the live body behaves.

## Prefer the actions that work

`kits.available()` lists, for each kit, how often each of its actions succeeded and failed on this body, and the message of the last failure:

```js
kits.available().find((k) => k.name === "woodcutter").stats;
// { chop: { ok: 12, failed: 3, lastError: "no log within reach" } }
```

`minebot kits` prints the same as `chop: 12 ok / 3 failed`. The body counts every call, including calls that one kit makes to another, and keeps the counts across restarts. Saving a different source for a kit, or removing it, resets its counts, because the old counts describe code that no longer exists. When two actions do the same job, call the one that works, and read `lastError` before you call the other.
