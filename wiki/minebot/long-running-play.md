---
title: Notes and status for long-running play
tags: [notes, memory, plan, status, restart, context, long, persistent, deaths]
mc_version: "26.1"
verified_by: "notes and status checked on the dev server, 2026-10-18"
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
