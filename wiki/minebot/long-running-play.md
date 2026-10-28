---
title: Notes and status for long-running play
tags: [notes, memory, plan, status, restart, context, long, persistent, deaths, drowning, float, water, respawn, death, digest]
mc_version: "26.1"
verified_by: "notes and status checked on the dev server, 2026-10-18; the idle float by test/autonomic.test.ts; the death event, spawn point, and digest line by test/deaths.test.ts and test/digest.test.ts"
---

A body can run for days. Your context can be reset or compacted at any time, and the body can restart. These things persist and help you pick up where you left off.

## Notes

Notes are your notepad on the body. They survive body restarts, reconnects, and resets of your context.

```sh
minebot notes                         # list notes
minebot notes set plan "1. wood 2. stone tools 3. shelter before night"
minebot notes get plan
minebot notes rm plan
```

In a run: `ctx.notes.set(key, text)`, `ctx.notes.get(key)`, `ctx.notes.list()`, `ctx.notes.delete(key)`.

Keep these notes up to date:

- `plan`: the current goal and the next steps.
- `places/<name>`: coordinates of your base, chests, mines, and portals.
- `mistakes`: what failed and why, so you do not repeat it.

Read your notes first when you start or when you lose track.

<!-- routines -->
Saved routines and their bindings persist too. After a reset, `minebot routines` shows what you built.
<!-- /routines -->

## Status

`minebot status` (or `await ctx.status()` in a run) shows deaths and reconnects since the body started.

<!-- milestones -->
It also shows progress toward the body's milestones. The server's statistics grade them, so a milestone stays met after you use its items.

## Milestones

The operator usually sets milestones. `minebot milestones` prints them. A set is an ordered list, such as "obtain 2 logs" then "craft a stone pickaxe".
<!-- /milestones -->

## While nothing is running

The body keeps the player alive between your runs. While no run is going and the player's eyes are in water, the body holds jump, so the player floats up instead of sinking. A water block, kelp, seagrass, a bubble column, and a waterlogged block all count as water. Your own run keeps control: the body lets go of its jump when a run starts and holds nothing while the run slot is taken, so a program that dives stays down.

## Deaths and where you wake up

Mineflayer respawns the player after a death, so a death costs time and the items you carried, not the session. `minebot observe --brief` then shows the last death and your respawn point:

```
last death 5m ago at -286 42 104 (drowned) | respawn: bed at 12 60 -3
```

The full observation has `lastDeath` (`time`, `position`, `cause`) and `spawnPoint`: the bed or respawn anchor the server confirmed for this host session, `null` once the server reset it to the world spawn, and absent while the session has not heard either way. The brief line says `respawn: world spawn` for the reset.

The `death` event data is `position`, `cause`, and `dropped`. `cause` is the server's death message, which names the player, such as `ana drowned`, and `dropped` lists each item you carried as `{ name, count }`. `minebot wait --types death` blocks until one arrives, and `minebot events` shows the deaths you missed.

Read the cause before you walk back to the grave. Drowning, lava, and a fall kill again on the same route, and the dropped items do not wait forever. Take air, another route, or another task first.

If you use the MCP tools, every response starts with one `[since your last call] ...` line when something happened since your previous call: a death with its cause and place, a respawn, a bot host restart, or a kick. Read it before you plan the next step.

<!-- reflexes -->
A reflex that the body switched off appears in the same line as `reflex <name> disabled: <reason>`. Two deaths during or just after a reflex's run switch it off; bind it again to turn it back on, and read `minebot/triggers` first.
<!-- /reflexes -->

## When nothing changes

The one-line observation (`minebot observe --brief`) ends with `no change for N runs` once several runs in a row change neither your position nor your inventory. That is your signal to change your approach, not to repeat the run. See `flows/escape-underground` if you are trapped.

## Waiting

Do not poll. `minebot wait` blocks until something happens, and costs nothing while it waits:

```sh
minebot wait --types chat --from ana          # until that player chats or whispers
minebot wait --match "diamond" --timeout 120000
minebot wait --types night --timeout 600000   # until the sun sets
minebot wait --types day                      # until sunrise
```

It prints the event as JSON, or `timed out`. Filters: `--types` (any of), `--from` (who sent the chat or whisper), `--match` (a case-insensitive regex over chat, whisper, and system messages). With `--since <seq>` it also looks at buffered events after that cursor; without it, only new events count. The body also emits `program_finished` when each program ends, and `night` and `day` when the time of day crosses into night or back into day. It emits `hostile_near` (a hostile creature within 16 blocks, once per creature), `low_health` (below 8), `low_food` (below 6), `item_picked_up`, `block_broken`, `block_placed`, and `item_crafted` for what the player does. The same exists as the `wait_for` MCP tool and `POST /wait`.
