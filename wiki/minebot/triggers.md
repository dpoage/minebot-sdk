---
title: Reflexes run a routine for you when an event arrives
tags: [reflex, reflexes, bind, automatic, events, hurt, hunger, eat, flee, preempt, priority, cooldown, restart, when, death, disable, breaker]
requires: [reflexes]
mc_version: "26.1"
verified_by: "reflexes on chat and low_food, the queue, preemption, a restart, and self-disable checked on the dev server, 2026-10-22; the death breaker by test/reflex-breaker.test.ts"
---

A run starts when you ask for it. A reflex is a saved routine that the body starts for you when an event arrives, for example to eat when food is low. You bind the reflex, so the body does nothing that you did not ask for.

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  const food = ctx.bot.inventory.items().find((item) => ctx.bot.registry.foodsByName[item.name]);
  if (!food) return "nothing to eat";
  await ctx.bot.equip(food, "hand");
  await ctx.bot.consume();
  ctx.log("ate", food.name, "food now", ctx.bot.food);
  return food.name;
};
```

Save the file as `eat.ts`, then bind it:

```sh
minebot routines save eat.ts
minebot bind reflex eat eat --on low_food --cooldown 10000
minebot routines                      # lists each reflex with what it did since the body started
minebot unbind eat                    # removes the reflex and keeps the routine
```

The body calls the routine as `(ctx, { event })`. The event is `{ seq, type, time, data }`. The routine above does not read it. A reflex routine gets the same `ctx` as any routine. The MCP tool `bind_routine` binds a reflex with `kind: "reflex"` and `on`, and with `source` it saves the routine in the same call.

<!-- builtins:survival -->
A reflex routine can call a built-in routine instead of the code above:

```ts
import * as survival from "minebot-sdk/routines/survival";
import type { RoutineContext } from "minebot-sdk/routine";

export default (ctx: RoutineContext) => survival.eat(ctx);
```

`survival.eat` fails when the inventory holds no food. A failure counts toward the failure rule below.
<!-- /builtins:survival -->

## What a reflex has

| Option | Meaning |
| - | - |
| name | The first argument of `minebot bind reflex`: 1-48 lowercase letters, digits, `_` and `-`, starting with a letter. Binding an existing reflex name replaces the reflex and resets its counts. |
| `--on` | Event types that fire it, such as `hurt`, `chat`, `night`, `low_food`, `low_health`, `hostile_near`. Separate them with commas. Any of them matches. A reflex cannot listen to `reflex_*` events. |
| `--when` | A JavaScript expression over `event` and `bot` that must be truthy, such as `event.data.health < 8`. It must finish within 100 ms. |
| `--from`, `--match` | Filters for `chat` and `whisper` events, as in `minebot wait`. |
| `--cooldown` | The least time in milliseconds between two firings. Default 1000. |
| `--timeout` | The run is aborted after this many milliseconds. Default 30000. |
| `--preempt`, `--priority` | See below. |

A reflex starts enabled. The body keeps reflexes in its state directory, so they survive a restart of the body and a reset of your context. A body keeps at most 50. An action and a reflex share one namespace of names: a bind with a name that an action holds is refused.

## When it runs

Runs, calls, and reflex firings share one slot, so only one goes at a time. A firing that arrives while something runs waits until it ends, and then runs. A reflex waits at most once: events that fire it again while it waits are dropped. Waiting reflexes run highest `--priority` first (-100 to 100, default 0).

With `--preempt`, the firing stops the running run (it ends as `stopped`, like `minebot stop`) and runs at once. A preempting reflex does not stop a running reflex of equal or higher priority; it waits. Use `--preempt` for reflexes that cannot wait, such as fleeing, and keep them short.

A reflex firing is not a run that you started, so it ends with `reflex_finished`, not `program_finished`. A `minebot run` that arrives while a reflex runs gets a busy error. Wait for `reflex_finished` and run it again.

## What you see

Each firing adds two events: `reflex_fired { name, event: { seq, type } }`, and `reflex_finished { name, status, durationMs, error?, logs? }` with the routine's `ctx.log` output. A firing that stopped a run adds `preempted: true` to `reflex_fired`. `minebot wait --types reflex_finished` blocks until one arrives.

A reflex that fails three times in a row (an error or a timeout) disables itself and adds `reflex_disabled { name, failures, reason }`. Bind it again after you fix it: the new bind enables it. A `when` that throws counts as a failure.

At start, the body reports `reflex_error` for a stored entry that it cannot load as a reflex, such as one saved before reflexes existed. The entry keeps its name until you run `minebot unbind <name>`.

## Two deaths switch a reflex off

A death counts against a reflex when it falls during that reflex's firing, or within 180 seconds after the firing ends. When 2 counted deaths fall within 10 minutes, the body disables the reflex and adds `reflex_disabled { name, failures, reason }` with the reason `the player died 2 times within 10 min during or right after its runs (last: drowned at 12 63 -4); bind it again with bind_routine and its full settings (list_routines shows them) to turn it back on`. A death that this breaker charges does not fire the reflex it disabled, so the reflex does not run on the death that broke it. Bind the reflex again to turn it back on, and fix what walks the player into the same danger first.

This rule exists for reflexes that walk back to a grave. A grave under water, in lava, or at the bottom of a cliff kills the player again on the way, and a reflex that fires on every death turns one accident into eight.

## Rules for good reflexes

- Keep the routine short and end it. A long routine blocks every other reflex and your own runs.
- Make it safe to repeat. Events can arrive while the previous firing is still going.
- Check what you need first, and return a reason when you do nothing: `return "nothing to eat"`.
- Stop movement and digging when `ctx.signal.aborted` turns true.
