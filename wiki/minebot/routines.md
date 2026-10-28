---
title: Routines are TypeScript modules that you save, call, and bind
tags: [routine, routines, module, typescript, import, defineRoutine, action, call, bind, library, versions, type check, timers]
requires: [routines]
mc_version: "26.1"
verified_by: "save, versions, revert, bind, call, a busy call, a timeout, a stop, and a leftover timer that restarted the bot host checked on the dev server, 2026-10-21"
---

A run is a module that you send once. A routine is a TypeScript module that stays in the body's library. You call it by name, it can import other routines, and it survives a restart of the body. Use a routine for code that you run again.

```sh
cat > count-logs.ts <<'EOF'
import { defineRoutine, z } from "minebot-sdk/routine";

export default defineRoutine(
  {
    description: "Counts the logs in the inventory.",
    args: z.object({ prefix: z.string().default("oak") }),
    returns: z.object({ count: z.number() }),
  },
  async (ctx, { prefix }) => {
    const count = ctx.bot.inventory.items().filter((i) => i.name.startsWith(prefix)).reduce((sum, i) => sum + i.count, 0);
    ctx.log("counted", count);
    return { count };
  },
);
EOF
minebot routines save count-logs.ts      # saves it, and prints its type check
minebot bind action count count-logs     # gives it a name for calls
minebot call count --args '{"prefix":"birch"}'
```

A run can import a saved routine and call it: `import count from "./count-logs.ts"`, then `await count(ctx)`. From outside the body, use `minebot call`, the `call_routine` tool, or `POST /call`. An MCP server started with `--tools full` also serves `routine_save`, `routine_source`, `routine_versions`, `routine_revert`, `list_routines`, and `unbind_routine`. `bind_routine` can save the module and bind it in one call: pass `source`.

## What a routine has

The default export is a function `(ctx, args) => result`. With `defineRoutine`, the body checks `args` (a zod schema) on every call and gives the routine the parsed value with defaults applied. A call with bad arguments fails before the routine runs, and the error holds the schema. The body also checks the result against `returns`. Only a missing argument defaults to `{}`: a call without `--args` passes `{}`. `null` is an argument, not a missing one, and a schema that expects an object refuses it. `minebot call` takes `--args` as a JSON object and refuses `null`. A plain exported function works too, with unchecked arguments.

`ctx` has these members and no others:

- `bot`, `log(...)`, `sleep(ms)`, `signal`, and `on(event, handler)`, as in a run.
- `notes` and `status()`, as in a run.
- `store(namespace)`, a JSON store that survives restarts of the body and that every routine opening the same namespace shares.
- `wiki`, when the wiki is on.

`Vec3`, `goals`, and `Movements` are not in `ctx`. Import them by name from `minebot-sdk/routine`, or from the packages: `import { goals, Movements } from "mineflayer-pathfinder"` and `import { Vec3 } from "vec3"`. Named imports of the body's CommonJS packages work, and so does `require`: `require("vec3")`.

<!-- builtins:move -->
A built-in routine is an import, not a `ctx` member: `import * as move from "minebot-sdk/routines/move"`, then `await move.to(ctx, { position: [10, 64, 10], range: 1 })`. See `minebot/kits`.
<!-- /builtins:move -->

## Imports

Use `import`. `require` works too, for the packages and the Node built-ins in the list below.

- Node built-ins, such as `node:fs`.
- The packages that the body ships: `mineflayer`, `mineflayer-pathfinder`, `vec3`, `minecraft-data`, the `prismarine-*` packages, and `zod`.
- `minebot-sdk/<subpath>`, such as `minebot-sdk/routine`. A bare `import "minebot-sdk"` does not resolve.
- Other saved routines, by file name: `import { double } from "./helper.ts"`. Name the `.ts` file. A type check does not catch `./helper.js`, and the call then fails with `Cannot find module`.

When a routine imports another, save the imported one first: `minebot routines save helper.ts act.ts`. The type check of `act.ts` runs when it is saved, and it reports `TS2307` for a module that is not saved yet.

## Save, change, and revert

A routine name has 1-48 lowercase letters, digits, `_`, and `-`, and starts with a letter. A source has at most 128 KiB.

Saving over a routine keeps the old source as a numbered version. `minebot routines versions <name>` lists them, and `minebot routines revert <name> <version>` saves an earlier one again as a new version. A save takes effect at the next call, without a restart, also for the routines that import the changed module. If you edit the file on disk by hand, the body records the old bytes as a version saved by `unknown` before your next save writes over them.

A save prints the type check: `passed`, `failed` with the errors, or `skipped` with a reason (for example, when `typescript` is not installed). A failed check does not stop the save. Fix the errors and save again. The check rejects an `enum`, a namespace that holds code, and a type imported as a value, because Node only strips types.

No command deletes a routine. `minebot unbind <name>` removes a binding and keeps the routine.

A bind refuses a routine that the library does not hold, and the error says how to save it: ``no routine named "<name>" in this body's routine library; save it first: pass its TypeScript as `source` to bind_routine (or routine_save), or run `npx minebot routines save <file>.ts`, then bind again``. Save the module, then bind again.

## Calls

`minebot call <name>` runs a bound action and prints the status, the logs, and the result. A call is a run:

- One run goes at a time. A call that arrives while another run is going is refused with a busy error. Wait for the run to end, or stop it.
- The default timeout is 60 seconds (`--timeout <ms>`). `minebot stop` and a timeout abort the run. Check `ctx.signal.aborted` in long loops.
- If the routine does not end within 5 seconds of the abort, the body kills the bot host and restarts it, also when the routine blocks the host with synchronous code. The run answers with an error that says so.

## What outlives a call

Only `ctx.on`, `ctx.sleep`, and `ctx.signal` end with the call. A `setTimeout`, a `setInterval`, or a `bot.on` listener that the routine makes itself keeps running after the call, and the body does not clear it. Clear your own timers before the routine returns. A leftover timer that throws after the call has ended crashes the bot host: the body restarts it, and you see a `disconnected` event.

<!-- reflexes -->
## Run a routine on an event

`minebot bind reflex <name> <routine> --on <types>` binds a routine as a reflex: the body calls it when an event of one of the types arrives. The routine gets `(ctx, { event })`. The event has `seq`, `type`, `time`, and `data`.

```ts
import type { BodyEvent } from "minebot-sdk/client";
import type { RoutineContext } from "minebot-sdk/routine";

export default (ctx: RoutineContext, { event }: { event: BodyEvent }) => {
  ctx.notes.set("last-chat", `${String(event.data.from)}: ${String(event.data.message)}`);
};
```

```sh
minebot routines save note-chat.ts
minebot bind reflex noter note-chat --on chat --cooldown 5000
```

A reflex takes the options `--when`, `--from`, `--match`, `--cooldown`, `--timeout`, `--priority`, and `--preempt`. A reflex that fails three times in a row disables itself, and two deaths during or just after its runs disable it too. Bind it again to turn it on: a new bind replaces the reflex and resets its counts. `minebot routines` lists the reflexes with what each did since the body started. See `minebot/triggers` for the death rule.

An action and a reflex share one namespace. A bind with a name that the other kind holds is refused; run `minebot unbind <name>` first. A body keeps at most 50 reflexes. See `minebot/triggers` for when a reflex runs, its priority, and preemption.
<!-- /reflexes -->
