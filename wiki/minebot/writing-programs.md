---
title: How to write programs that work
tags: [program, run, minebot, strategy, debugging, helpers, globalThis, timeout, verify, type check, typecheck, error, suggestion, refusal]
verified_by: "practices from the Gemini 4 Argon dragon run (arXiv 2610.22319) and minebot's own oracle and demo runs; the type-check refusal and the suggestion line by test/run-check.test.ts and test/explain-run.test.ts"
---

A program is a module that `minebot run` sends to the body. Its default export is a function `(ctx, args)` that runs against the live bot, and the result is what it returns. A `return` outside a function is a syntax error, and a run has no `bot` global: take `bot`, `log`, `sleep`, and `signal` from `ctx`.

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext) => ({
  position: bot.entity.position,
  items: bot.inventory.items().map((item) => `${item.name} x${item.count}`),
});
```

Save this as `look.ts` and run `minebot run look.ts`. A run takes its inputs from its args: `minebot run look.ts --args '{"x":1,"y":64,"z":2}'` passes `{ x: 1, y: 64, z: 2 }` as the second argument of the default function. Without `--args`, the second argument is `{}`.

## It is type-checked before it runs

The body type-checks your program first, and refuses a program that would fail when it runs: a name that is not defined, a call of a member that does not exist, a call of a value that is not a function, an object with a key the type does not have, or the wrong number of arguments. A refused program does not start. Its status is `error`, and the first line says what to do:

```
the run did not start: the type check found 1 error(s) in your code. Fix them and run again, or put // @ts-nocheck as the first line to run it unchecked.
```

Each error follows as `line <L>:<C> <message>`, with the line and column in your own source. Under a call of a `bot` member that does not exist, one more line names the member to use instead, when the member is on a short curated list of mistakes seen in practice: `bot.selectItem does not exist: use bot.equip(item, "hand")`. Any other missing member gets the TypeScript message alone. Read those lines from the top: the first error often causes the rest.

Other type errors do not stop a program. An unresolved module and a type mismatch go through, because the body strips the types and nothing checks them again. A check that cannot answer is skipped: the run's log gets one line, `type check skipped: <reason>`, and the program runs anyway.

The same suggestion appears at run time. A program that calls a `bot` member which is not a function ends `error`, and its last line names the real member: `bot.selectItem does not exist: use bot.equip(item, "hand")`, or `bot.isRaining is a boolean, not a function: read bot.isRaining`.

These practices made long runs succeed:

1. **Observe first.** Start with `minebot observe` or a short run that returns what you need to know: inventory, nearby blocks, position.
2. **Keep programs short.** Do one step per run, return its result, and read the result before you write the next one.
3. **Verify, do not assume.** Compare the inventory before and after. A call that returns without an error can still have had no effect.
4. **Reuse helpers.** Store working functions on `globalThis`; they persist between runs until the bot host restarts. A helper that needs the bot takes `ctx` as a parameter, because each run has its own `ctx`. Fix a helper once instead of rewriting it.
5. **Bound every wait.** Pass `--timeout` and put time limits on moves and digs. See `quirks/pathfinding-needs-a-timeout`.
6. **Log progress.** `ctx.log(...)` inside loops shows how far a program got when it fails.
7. **Check `ctx.signal.aborted`** in long loops, so that `minebot stop` and timeouts end them.
8. **Search the wiki on surprises.** Search for the error text: `minebot wiki search "<error words>"`.

<!-- builtins -->
When built-in routines are offered, prefer one over raw Mineflayer code. Run `minebot builtins docs` for the full list with argument types.
<!-- /builtins -->
<!-- builtins:gatherer -->
For example, `minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'` collects four logs.
<!-- /builtins:gatherer -->

<!-- routines -->
When you run the same code again and again, or you want to call it by name after a restart, save it as a routine. See `minebot/routines`.
<!-- /routines -->
