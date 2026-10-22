---
title: Triggers run a program for you when an event arrives
tags: [triggers, trigger, reflex, automatic, events, hurt, hunger, eat, flee, preempt, cooldown, restart]
requires: [reflexes]
mc_version: "26.1"
verified_by: "triggers on hurt and low_food, the queue, preemption, a restart, and self-disable checked on the dev server, 2026-10-19"
---

A program runs when you start it. A trigger is a program that the body starts for you when an event arrives, for example to eat when food is low. You write the trigger, so the body still does nothing that you did not ask for.

```sh
cat > eat.js <<'EOF'
const food = bot.inventory.items().find((i) => bot.registry.foodsByName[i.name]);
if (!food) return "nothing to eat";
await bot.equip(food, "hand");
await bot.consume();
log("ate", food.name, "food now", bot.food);
EOF
minebot triggers add eat --on low_food --cooldown 10000 eat.js
minebot triggers                      # what each trigger did since the body started
minebot triggers disable eat          # off, but kept; "enable" turns it on, "rm" deletes it
```

In programs: `await triggers.add({ name: "eat", on: ["low_food"], run: "...program source...", cooldownMs: 10000 })`, `triggers.list()`, `triggers.enable(name)`, `triggers.disable(name)`, `triggers.remove(name)`. An MCP server started with `--tools full` also serves them as the tools `trigger_add`, `trigger_list`, `trigger_remove`, and `trigger_set_enabled`.

<!-- routines -->
A reflex is a trigger whose code is a saved routine: `minebot bind reflex <name> <routine> --on <types>` binds it, and the body calls the routine as `(ctx, { event })`. It has the fields and the rules of a trigger. See `minebot/routines`.
<!-- /routines -->

<!-- builtins -->
The program may call kit actions, for example `await kit.survival.eat()` instead of the code above.
<!-- /builtins -->

## What a trigger has

| Field | Meaning |
| - | - |
| `name` | 1-48 lowercase letters, digits, `.`, `_`, `-`. Saving a trigger with an existing name replaces it. |
| `on` | Event types that fire it, such as `hurt`, `chat`, `night`, `low_food`, `low_health`, `hostile_near`. Any of them matches. Triggers cannot listen to `trigger_*` events. |
| `run` | The program. It has the globals of a program plus `event`, which is `{ seq, type, time, data }`. |
| `when` | A JavaScript expression over `event` and `bot` that must be truthy, such as `event.data.health < 8`. It must finish within 100 ms. |
| `from`, `match` | Filters for `chat` and `whisper` events, as in `minebot wait`. |
| `cooldownMs` | Least time between two firings. Default 1000. |
| `timeoutMs` | The run is aborted after this long. Default 30000. |
| `preempt`, `priority` | See below. |
| `enabled` | Default true. |

The body keeps triggers in its state directory, so they survive a restart of the body and a reset of your context. A body keeps at most 50. Code that does not compile is rejected when you save it.

## When it runs

Only one program runs at a time. A firing that arrives while a program is running waits until the program ends, and then runs. A trigger waits at most once: events that fire it again while it waits are dropped. Waiting triggers run highest `priority` first.

With `preempt: true`, the firing stops the running program (`stopped`, like `minebot stop`) and runs at once. A preempting trigger does not stop a running trigger of equal or higher priority; it waits. Use `preempt` for reflexes that cannot wait, such as fleeing, and keep them short.

A trigger run is not an agent program, so it ends with `trigger_finished`, not `program_finished`. A `minebot run` that arrives while a trigger runs gets a busy error; wait for `trigger_finished` and run it again.

## What you see

Each firing adds two events: `trigger_fired { name, event: { seq, type } }`, and `trigger_finished { name, status, durationMs, error?, logs? }` with the trigger's `log` output. `minebot wait --types trigger_finished` blocks until one arrives.

A trigger that fails three times in a row (an error or a timeout) disables itself and adds `trigger_disabled`. `minebot triggers enable <name>` turns it on again after you fix it. A `when` that throws counts as a failure.

## Rules for good triggers

- Keep the program short and end it. A long program blocks every other trigger and your own programs.
- Make it safe to repeat. Events can arrive while the previous run is still going.
- Check what you need first, and return a reason when you do nothing: `return "nothing to eat"`.
- Do not start movement or digging that you do not stop on `signal.aborted`.
