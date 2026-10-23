---
title: Write, test, and save a routine of your own
tags: [routines, authoring, workspace, init, test, harness, testing, type check, tsc, store, args, returns, compose, save]
requires: [routines]
verified_by: "workspace, type check, harness tests, save, run, call, and a restart checked on the 26.1 dev server, 2026-10-22"
mc_version: "26.1"
---

Write a routine when you repeat the same steps in run after run. Test the routine without a server first. Then save it: a saved routine stays on the body, so a mistake costs more than a failed test.

## Start a workspace

A harness with a file system writes routines in a workspace:

```sh
minebot init ws
cd ws
```

The workspace holds `routines/` for routines, `runs/` for runs that call them, and `test/` for tests. Its `package.json` depends on `minebot-sdk`: install it, so that `tsc` and the tests find `minebot-sdk/routine` and `minebot-sdk/testing`. `npx tsc` type-checks all three folders, and `npm test` runs the tests. The `tsconfig.json` lists `routines` and `runs` in `rootDirs`, so an error in a routine's signature shows up in the run that calls it.

## Write it

A routine is one file. Its default export is `defineRoutine`, which takes a description, an `args` schema, a `returns` schema, and the function.

```ts
import { defineRoutine, z } from "minebot-sdk/routine";

export default defineRoutine(
  {
    description: "Counts how many times it ran, across calls and body restarts.",
    args: z.object({ step: z.number().int().positive().default(1) }),
    returns: z.object({ visits: z.number() }),
  },
  async (ctx, { step }) => {
    const store = ctx.store("visits");
    const visits = Number(store.get("count") ?? 0) + step;
    store.set("count", visits);
    ctx.log("visits now", visits);
    return { visits };
  },
);
```

Save the file as `routines/visits.ts`. These rules apply to every call:

- The body validates the arguments against `args` and passes the function the parsed value with the defaults filled in. A call with bad arguments fails before the function runs, and the error holds the schema.
- The body validates the result against `returns`. A result that does not fit fails the call with `returned a value that does not match its returns schema`. Zod drops the keys that the schema does not list.
- `ctx.store(namespace)` is a JSON store that survives restarts of the body. Every routine that opens the same namespace shares it. Name the namespace after the routine: 1-48 lowercase letters, digits, `_` and `-`, starting with a letter. The names `notes` and `body` belong to the body.

## Test it without a server

`minebot-sdk/testing` runs a routine through the same checks as the body, against a fake bot that uses the real Minecraft registry. No server runs.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import visits from "../routines/visits.ts";

test("visits counts across runs and checks its arguments", async () => {
  const h = createHarness();
  assert.deepEqual(await h.run(visits), { visits: 1 });
  assert.deepEqual(await h.run(visits, { step: 5 }), { visits: 6 });
  assert.deepEqual(h.logs, ["visits now 1", "visits now 6"]);
  await assert.rejects(h.run(visits, { step: 0 }), /arguments/);
});
```

Save it as `test/visits.test.ts` and run `npm test`. `createHarness` takes the world to build: the `inventory`, the `blocks`, the `entities`, the `position`, and the `time`. The harness holds the stores in memory, so a value that one `h.run` stores is there in the next.

The harness tests decisions, not physics. Digging removes the block and drops its items, the pathfinder moves the bot to the nearest standable spot that satisfies the goal, and furnaces cook on the harness clock. A Mineflayer call that the harness does not implement (`bot.attack`, `bot.sleep`, `bot.openContainer`) throws `not supported by minebot-sdk/testing: <api>`. A passing test shows that the logic holds. A call on the live body shows how the world behaves.

## Save it, run it, call it

1. Save the file: `minebot routines save routines/visits.ts`. The save prints `type check: passed`, or the errors that `tsc` found. A failed check does not stop the save.
2. Call it once: `minebot bind action visits visits`, then `minebot call visits --args '{"step":2}'`.
3. Or call it from a run. A `./` import in a run names a saved routine, so save the routine first.

```ts
import type { RoutineContext } from "minebot-sdk/routine";
import visits from "./visits.ts";

export default (ctx: RoutineContext) => visits(ctx, { step: 3 });
```

Save this file as `runs/try-visits.ts`. A run must not have the file name of a routine, because it would import itself. Run it with `minebot run runs/try-visits.ts`. Saving a different source for a routine keeps the old one as a version: `minebot routines versions visits` lists the versions, and `minebot routines revert visits 1` saves version 1 again. See `minebot/routines`.

<!-- builtins -->
## Compose built-in routines

Search first: a built-in routine may already do the job. `minebot builtins search "collect logs"` ranks the routines by what they do, and `minebot builtins docs gatherer` prints the call shapes. See `minebot/kits`.

A routine reaches a built-in routine by import. This routine walks to each of the nearest logs and digs it:

```ts
import { defineRoutine, Point, z } from "minebot-sdk/routine";
import * as dig from "minebot-sdk/routines/dig";
import * as move from "minebot-sdk/routines/move";
import * as sense from "minebot-sdk/routines/sense";

export default defineRoutine(
  {
    description: "Chops the nearest logs and reports where the player ends up.",
    args: z.object({ times: z.number().int().positive().default(1) }),
    returns: z.object({ chopped: z.number(), standingAt: Point }),
  },
  async (ctx, { times }) => {
    const logs = await sense.find(ctx, { blocks: "*_log", radius: 16, count: times });
    for (const log of logs) {
      await move.to(ctx, { position: log, range: 3 });
      await dig.dig(ctx, { at: log });
    }
    const here = ctx.bot.entity.position.floored();
    return { chopped: logs.length, standingAt: { x: here.x, y: here.y, z: here.z } };
  },
);
```

The harness runs built-in routines too. It records each call of a built-in routine in `h.calls`, as `{ kit, action, args }`: `kit` is the module and `action` is the routine.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import woodcutter from "../routines/woodcutter.ts";

test("woodcutter digs the nearest logs", async () => {
  const h = createHarness({ blocks: [{ name: "oak_log", from: [6, 64, 0], to: [6, 66, 0] }] });
  assert.deepEqual(await h.run(woodcutter, { times: 2 }), { chopped: 2, standingAt: { x: 5, y: 64, z: 0 } });
  assert.deepEqual(h.calls.map((c) => `${c.kit}.${c.action}`), ["sense.find", "move.to", "dig.dig", "move.to", "dig.dig"]);
  assert.equal(h.count("oak_log"), 2);
  assert.equal(h.blockAt([6, 64, 0]).name, "air");
});
```

Save the routine as `routines/woodcutter.ts` and the test as `test/woodcutter.test.ts`. The body counts every call of a built-in routine, so `minebot builtins` shows which routines work on this body. When two routines do the same job, call the one that works.
<!-- /builtins -->
