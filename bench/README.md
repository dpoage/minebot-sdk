# minebot bench

minebot bench is a set of Minecraft tasks in the [Harbor](https://harborframework.com) task format. Harbor runs an agent harness such as Claude Code or Codex against each task and grades the result.

Each trial starts three containers, and a fourth for grading after the agent is done:

| Service | Image | Role |
| - | - | - |
| `main` | `minebot.local/minebot-client:dev` | The agent's terminal. It has the `minebot` CLI and MCP server (without the `body` command), pointed at the body, and the Mineflayer and pathfinder documentation that the instructions name. It has no body code, kits, wiki, oracle, or verifier. |
| `body` | `minebot.local/minebot:dev` | One minebot body, logged in as the player `agent`. It records every program run to `/var/log/minebot/programs.jsonl`. |
| `minecraft` | `minebot.local/minebot-server:26.1` | A vanilla server with a fixed seed, in offline mode, with RCON on. The tag tracks the pinned version in `src/mc/version.ts`. |
| verifier | `minebot.local/minebot-verifier:dev` plus the task's `tests/` | Grades after `main` has stopped. Harbor builds it from `tests/Dockerfile`. |

## Isolation

The agent runs as root in `main`. These rules keep the grading out of its reach. The reasons are in `compose()` in `gen-tasks.ts`.

- **The verifier is a separate Harbor environment** (`[verifier.environment]` in `task.toml`). It starts after `main` is stopped, so it never runs code that the agent could have changed. Its inputs are artifacts that Harbor copies from the `body` sidecar: the program history, and the grading snapshot. A `[[verifier.collect]]` hook runs `verify/snapshot.ts` in the `body` container after `main` stops. The snapshot makes the server save its world over RCON, then writes two files to `/var/log/grading`: `stats.json`, the player's statistics, and `world.json`, which holds what the saved world shows (the containers, the overworld clock, and the player's position; see [Grading](#grading)).
- **`main` is on the `agent` network with `body` only.** `minecraft` is on the internal `game` network with `body`. `main` cannot resolve `minecraft` and has no mount of the world volume, which the `body` mounts read-only. The server container also drops connections to the game and RCON ports from outside its own network (`RESTRICT_TO_OWN_SUBNET`, with the `NET_ADMIN` capability), because rootless podman routes between the networks of a project: without that rule, `main` reaches the server by IP address. The `agent` network is not internal, so agent harnesses can still call their model APIs from `main`.
- **Milestones, agent kits, and triggers are off.** Every task body starts with `--no-milestones`, `--no-agent-kits`, and, except in `survive-nights`, `--no-triggers`: the agent cannot read, set, or grade milestones, so it has no live grader; the per-trial library stays clean; and the body runs only the programs the agent submits, so a trial's history is the whole record of what acted. `survive-nights` starts its bodies with triggers, because a reflex that does not wait for the agent's next turn is what the task measures. The agent writes every trigger itself, and the history records a trigger's code when it is saved and each firing, so the history is still the whole record. `status` shows deaths and reconnects only.
- **Escape attempts fail the trial.** Programs run in a `node:vm` context, which is not a security boundary: `bot.constructor.constructor("return process")()` reaches the body's process, and from there the RCON password and the statistics volume. The body therefore audits every program (`src/audit.ts`): it flags `constructor.constructor`, `process`, `getBuiltinModule`, `require(`, `import(`, `globalThis.constructor`, and `Function(`, and records the flags in the history before the program runs. The verifier reads the history, scans the program source again, and gives reward 0 to a trial with a flagged program. This is an audit, not a security boundary: code that builds the names at run time passes it. The instruction tells the agent about the audit, and a comment that contains `process` is flagged too.
- **The kit lock is advisory.** `--lock-kits` hides the kits that a tier lacks, and a program that stays inside the program environment cannot change the tier. A program that escapes can, which is why escapes fail the trial.
- **What `main` still contains.** The client is a thin program, but its source (`/opt/minebot/src`) names the commands that bodies may offer (`kits`, `wiki`, `milestones`, `triggers`). An agent that reads the client source learns that these exist, not what they do. Nothing there depends on the tier.

## Tasks and tiers

Each task exists in four tiers. A tier sets what the agent gets besides raw Mineflayer. The task directory is named `<task>-<tier>`, for example `craft-stone-pickaxe-full`.

| Tier | Kits offered | Wiki |
| - | - | - |
| `raw` | none | off |
| `kits` | move, sense, dig, place, inventory, craft, items, furnace, gatherer, crafter, builder, explorer, social | off |
| `wiki` | none | read |
| `full` | move, sense, dig, place, inventory, craft, items, furnace, gatherer, crafter, builder, explorer, social | read |

`--kits` names the routine kits; the primitives they use are offered with them. The instructions describe the call shape (`kit.gatherer.gather({ blocks: "*_log", count: 4 })`) and name the whole offer. A task can add kits to the `kits` and `full` tiers (`extraKits` in `gen-tasks.ts`): the instruction and `task.toml` list the offer of that task. `survive-nights` adds `survival` and `combat`, and `stock-chest` and `two-sessions` add `container`; no other kit is task-specific.

Every tier has the base body: Mineflayer plus notes, status (deaths and reconnects), the event log with blocking waits, and the one-line observation. Kits and the wiki are the tier features, and the tier table is the only difference between tiers. Every tier starts the body with `--lock-kits`, `--no-agent-kits`, and `--no-milestones`, and with `--no-triggers` unless the task enables triggers.

An agent does not learn about a feature that its tier lacks. For a tier without kits, the CLI help, `minebot kits`, `minebot api`, the MCP tool list and descriptions, the injected globals, the observation, error messages, and the wiki pages and search results show nothing about kits; the same holds for the wiki, lessons, milestones, and triggers. (The one task with triggers, `survive-nights`, describes them in its instruction.) A test turns each capability off and asserts that no surface mentions it. The instruction describes the kits and the wiki only when the tier has them. In the wiki tier, the pages teach the Mineflayer way. Report results for each tier separately, because kits and the wiki change what the score measures.

| Task | Goal | Graded by |
| - | - | - |
| `collect-logs` | Collect eight logs. | 1, 4, and 8 logs |
| `craft-wooden-pickaxe` | Craft a wooden pickaxe. | log, planks, crafting table, sticks, pickaxe |
| `craft-stone-pickaxe` | Craft a stone pickaxe. | the wooden pickaxe chain, 3 cobblestone, stone pickaxe |
| `iron-tools` | Craft an iron pickaxe. | every milestone: the stone pickaxe chain, 3 raw iron, a furnace, 3 smelted iron ingots, the iron pickaxe |
| `diamond-night` | Craft a diamond pickaxe and be alive at dawn after the first night. | every milestone: the iron pickaxe chain, 3 diamonds, the diamond pickaxe; the overworld clock at 1 day, no deaths |
| `survive-nights` | Survive two in-game nights without dying. | the overworld clock at 1 and 2 days, no deaths |
| `stock-chest` | Craft a chest, place it, and store 16 cobblestone in it. | the wooden pickaxe chain, 16 cobblestone, a chest, and 16 cobblestone in a chest of the saved world |
| `two-sessions` | Two sessions of the agent. First: put 8 logs in a chest and walk 200 blocks away. Second, as a new session: craft a stone pickaxe with the logs from that chest. | first step: the chest crafted, 8 logs in a chest, 200 blocks from it; second step: the stone pickaxe, and the chest that the first step filled down to 4 logs |

### What each family measures, and in which tiers

Every task exists in all four tiers. Each of the newer families is meaningful in every tier, for different reasons, and the tier comparison is the point of running them:

- **`iron-tools`** is the long crafting chain. The raw and wiki tiers have to build the smelting loop themselves (a furnace window, fuel, waiting for the output); the kits tiers have `kit.crafter.make({ item: "iron_pickaxe" })`, which smelts, and the wiki tiers have the pages on smelting and on finding ore. Iron ore is mostly underground, so every tier has to explore. Smelting counts as crafting in the statistics (the player's `crafted` count rises when the output is taken from the furnace), so the `iron_ingot` milestone is graded like any crafted item. Iron ingots and tools also occur in generated chests (villages, shipwrecks, dungeons, mineshafts), and a pickaxe crafted from a looted ingot would pass a grade on the last milestone alone. The task therefore sets `allRequired`: the reward needs every milestone, so the ore has to be mined and the ingots smelted.
- **`diamond-night`** is the hardest task: the whole iron chain, then a descent of 60 blocks and more to diamond ore (most common under the deepslate, near caves and lava), the diamond pickaxe, and no death before the server's clock passes the first dawn (24000 ticks, 20 minutes of real time). The routine kits do not cover it end to end: `crafter.make` makes the pickaxes once the ore is in the inventory, but the descent, staying alive in the dark, and waiting out the night are the agent's own, which is what it measures beside the long chain. The body starts with triggers in every tier, and the kits tiers add `survival` and `combat`, as in `survive-nights`. Every milestone is required, so a looted ingot or diamond does not pass it.
- **`survive-nights`** measures staying alive over a long stretch of real time: about 40 minutes at 20 ticks per second, with nothing to craft. The reflex features matter in every tier, so the task starts its body with triggers in every tier (see [Isolation](#isolation)). The kits tiers also offer `survival` (eat, sleep in a bed, wear armor) and `combat` (attack, fight, retreat). The grade comes from the server's clock and the player's death count, which only the server knows: a checkpoint is the clock at 1 and at 2 days (24000 ticks each), and a death fails the trial. Sleeping through a night advances the clock like waiting does, so a bed is one valid way to finish.
- **`stock-chest`** adds containers, which the statistics do not show. Every tier can open a chest with Mineflayer, and the kits tiers add the `container` kit. The verifier reads the contents of the chest from the saved world (see [Grading](#grading)).
- **`two-sessions`** measures continuity across a reset of the agent's context. It is a Harbor multi-step task: one trial, one set of containers and one world, and a new agent session at each step. See [Two sessions](#two-sessions).

`bench/gen-tasks.ts` generates every directory under `bench/tasks/` from its task catalog and tier list. Do not edit the generated files.

## Grading

The verifier (`verify/check.ts`) runs in its own container and grades from three artifacts:

1. `/var/log/grading/stats.json`: the player's statistics. After the agent is done, the body makes the server save its world over RCON and copies the player's file (`verify/snapshot.ts`).
2. `/var/log/grading/world.json`: what the saved world shows, which the statistics do not: `clock`, the overworld clock in ticks (`/time query time`, which sleeping advances like waiting does); `player`, the player's position (`/data get entity`); and `containers`, every block entity with an inventory in the saved chunks, with its item totals. The snapshot reads the containers from the region files of the world volume (`verify/world.ts`), so the contents are the server's own record, found without knowing where the agent put a chest. The verifier reads this file only for a task that has checks.
3. `/var/log/minebot/programs.jsonl`: every program the agent ran.

A milestone is met when the player has obtained enough matching items. Statistics keep counting after an item is used, so the crafting table milestone stays met after the agent places the table. Each milestone counts in one of two ways (`grade` in `src/milestones/milestones.ts`):

- `crafted`: the `crafted` statistic. Crafting consumes ingredients, so it cannot be repeated for free. The server also counts a smelted item here when the player takes it out of a furnace.
- `gathered`: the smaller of blocks dug minus blocks placed (`mined` minus `used`) and items picked up minus items thrown (`picked_up` minus `dropped`). Tossing an item and picking it up again, collecting the drops after a death, and placing a block and digging it again do not raise the count. Items that only drop from leaves, such as sticks, do not count for a crafted milestone.

A task can also list checks, for facts that no statistic records (`verify/checks.ts`, pure and tested in `test/bench-checks.test.ts`). A check is met or not; its result shows the number behind it and the requirement.

| Check | Met when |
| - | - |
| `stored` | The items that match `items` (`*_log`, `cobblestone`) add up to at least `min` across all the containers of the given blocks (default: chests and trapped chests), and at least one such container exists. |
| `withdrawn` | In a task with several steps: the containers that held at least `held` of the items at the step before (the snapshot carries the one before it as `previous`) are still at the same position and hold at most `max` of them now. An empty chest that was never filled, or a chest that was broken, does not satisfy it, and neither does a task whose step before recorded no such chest. |
| `nights` | The overworld clock has completed `nights` days (24000 ticks each). The night of day `n` is over when the clock reaches `n` days. |
| `deaths` | The statistic `deaths` is at most `max`. The server writes it after the first death only, so a missing statistic is 0. |
| `distance` | The player is at least `min` blocks, horizontally, from every container (the nearest counts). |

The reward is 1 when the last milestone and every check are met (every milestone, for a task with `allRequired`). A task with checks may have no milestones (`survive-nights`), and `progress` is the fraction of milestones and checks that are met. The snapshot counts every chest in the saved world that has an inventory. An unopened loot chest has none (it holds a loot table until someone opens it), but one that the agent or a creature opened does, and loot tables do hold logs (`village_taiga_house`: spruce, `pillager_outpost`: dark oak, `spawn_bonus_chest`: every kind) but no cobblestone. A `stored` check therefore counts what any chest holds, so pair it with milestones that the agent has to earn (as `stock-chest` and `two-sessions` do), and use `withdrawn`, which keys on the chest that an earlier step recorded, where a chest must be the one that was filled. A new `stored` check should name items that loot does not hold.

If any program in the history is flagged as an escape attempt, the trial gets reward 0 (see Isolation).

The verifier writes these files to `/logs/verifier/`:

- `reward.json` contains `reward` (1 if the last milestone, or every milestone for `allRequired`, and every check are met and no program was flagged, else 0), `progress` (the fraction of milestones and checks met), and `disqualified` (1 when a program was flagged, else 0).
- `milestones.json` contains the statistics behind each milestone and the numbers behind each check. For a disqualified trial, it also has `disqualified.reason` and the flagged program numbers with their pattern names. The verifier prints the same reason.

Each task lists its milestones and checks in `tests/milestones.json`.

### Two sessions

`two-sessions` is a Harbor multi-step task (`[[steps]]` in `task.toml`, `steps/<name>/` for each step's instruction, tests, and solution). Harbor runs the steps one after another in one trial: the containers, the world, and the body stay, and the agent harness starts a new session for each step with that step's instruction. The session reset is the harness's own, so the task asks only what a reset costs: a new session has none of the previous session's context and the same body.

1. `stash`: collect logs, craft a chest, place it, put eight logs in it, and walk at least 200 blocks from the chest. The instruction says that a second session will continue and will be asked to craft a stone pickaxe from the logs in this chest, and that it can read the notes and see the world. Graded: the chest crafted, eight logs in a chest, and the player 200 blocks from it. The step has `min_reward = 1.0`: Harbor stops the trial when it is not met, so a second session never runs against a chest that does not exist.
2. `retrieve`: a new session, which knows only its own instruction. It has to find the chest, take at least four logs out of it, and craft a stone pickaxe. Graded: the stone pickaxe (statistics, which carry over from the first step) and the `withdrawn` check: the chest that held the eight logs at the end of the first step is still there and holds four or fewer. Any other chest, empty or not, does not count.

The first step ends with the player far from the chest, so the second session cannot find it by looking. The body loads the chunks within the server's view distance (8 chunks, 128 blocks and the rest of the chunk at the edge, so under 144 blocks), and `bot.findBlocks` sees only loaded chunks; 200 blocks leaves the chest outside them. What the second session can use is whatever the first session left on the body: the notes (the instruction of both steps names them), the places of `kit.explorer.remember`, the event log, and the world. The verifier of each step runs after that step, and the trial's reward is the last step's (`multi_step_reward_strategy = "final"`); Harbor reports both. The body keeps `/var/log/grading` between the steps, so the snapshot of the second step carries the first one as `previous`, and the verifier compares the two.

What this does not measure is a harness that resumes its own transcript: Harbor can resume a previous step's native session (`agent.resume_trajectory`) for agents that support it, and the benchmark starts every session fresh. A trial where the agent keeps a file in `main` instead of using the body's notes is valid too, since `main` persists between steps.

## Setup

1. Create the Python environment for Harbor and podman-compose:

   ```sh
   python3 -m venv .venv
   .venv/bin/pip install -r bench/requirements.txt
   ```

   `bench/requirements.txt` pins Harbor to a commit. Harbor 0.24.0 on PyPI does not detect podman-compose.

2. Read the [Minecraft EULA](https://aka.ms/MinecraftEULA). The task compose files set `EULA=true` on the server container.

3. Build the images: the server, the body (`minebot`), the agent's client (`minebot-client`), and the verifier. Rebuild them after every change to `src/` or `bench/`:

   ```sh
   bench/build-images.sh
   ```

4. Put the virtual environment first on `PATH`. Podman then finds podman-compose there:

   ```sh
   export PATH="$PWD/.venv/bin:$PATH"
   ```

## Run

Run the reference solutions. This checks that every task is solvable and that every verifier works:

```sh
harbor run -c bench/jobs/oracle.yaml -y
```

The job starts three trials at a time (`n_concurrent_trials`). Each trial starts a Minecraft server that generates its spawn area, and Harbor gives an environment 300 seconds to start; a machine that is too busy fails a trial with `EnvironmentStartTimeoutError` before the agent runs. Lower the concurrency with `-n` if that happens. The `survive-nights` oracle runs for about 41 minutes per tier, because night falls on the server's clock, and `two-sessions` runs two agent sessions in one trial.

Run Claude Code, three attempts per task:

```sh
CLAUDE_CODE_OAUTH_TOKEN=... harbor run -c bench/jobs/claude-code.yaml -y
```

### Local Qwen

`bench/qwen.ts` runs Terminus 2, Harbor's terminal agent, with the local Qwen model (`bench/jobs/qwen.yaml`):

```sh
node bench/qwen.ts --tier raw --tier full -y
node bench/qwen.ts --task craft-wooden-pickaxe-full -k 1 -y
```

The script does these steps:

1. It reads the API key from `~/.config/hyperqwen.key`. Set `QWEN_KEY_FILE` to use another file.
2. It asks the endpoint for the model's context length. Terminus 2 needs the context length to summarize the conversation before it overflows.
3. It runs `harbor run` with the job file. `--tier` and `--task` select tasks by glob. All other arguments go to `harbor run`, for example `-k 1` for one attempt per task.

Terminus 2 calls the model from the Harbor process on this machine, so only this machine needs to reach the endpoint. The job runs one trial at a time, because one GPU serves every request.

### Watch a running job

```sh
node bench/watch.ts --follow             # the newest job under bench/runs/
node bench/watch.ts bench/runs/<job>     # one report for a given job
```

For each trial, the watcher shows the reward when the trial is done. For a running trial, it shows the elapsed time, the agent's turn count and latest reasoning, the number of programs and the last program error, and the player's position, health, and inventory. It reads the trajectory that Harbor writes during the trial, and it runs `podman exec` in the trial's containers. With `--follow`, it reports every 15 seconds.

Harbor writes results to `bench/runs/<job>/`. Each trial directory contains:

- `verifier/reward.json` and `verifier/milestones.json`.
- `artifacts/minebot/programs.jsonl`: every program the agent ran, with its status, logs, result, and `escapeAttempts`. A flagged program has two lines: one with status `started`, written before it ran, and one with its result.
- `artifacts/grading/stats.json`: the statistics that were graded.
- `agent/`: the harness transcript.

Run `harbor view bench/runs` to browse the results.

## Add a task

1. Add the task to `TASKS` in `bench/gen-tasks.ts`. It has one stage for each agent session (several stages make a multi-step task). A stage has the goal, the milestones (`gathered` for items from the world, `crafted` for items that are made) or checks, the agent timeout, and the `TARGET` for the reference solution. A task can add kits to the kits tiers (`extraKits`) and enable triggers (`triggers`); say in the task's goal text what the agent needs to know about them.
2. Teach `oracle/progression.js` the new `TARGET`, and add it to the `OracleTarget` type in the generator.
3. Run `node --conditions=minebot-sdk:source bench/gen-tasks.ts`. It rewrites `bench/tasks/`.
4. Run the oracle job, and confirm that every tier of the new task gets a reward of 1.

## The reference solution

`oracle/progression.js` is a minebot program. The generator copies it into each task's `solution/` directory (into `steps/<name>/solution/` for a multi-step task), and Harbor uploads that directory to `/solution` in `main` only when the oracle agent runs. Each `solve.sh` puts a `TARGET` line in front of the program and sends it to the body with `minebot run`. The reference solution uses the same API as the agent, and the agent's image does not contain it.

The first three targets (`logs`, `wooden_pickaxe`, `stone_pickaxe`) use Mineflayer alone in every tier. The newer ones use the kits where the body offers them (`kit` is defined) and Mineflayer where it does not, so one program solves a task in all four tiers:

| `TARGET` | Task | What it does |
| - | - | - |
| `iron_pickaxe` | `iron-tools` | Collects seven logs of one species, makes the wooden and stone pickaxes, mines 11 cobblestone, finds three iron ore within 96 blocks (the server sends buried ore too, so it needs no cave), smelts them at a furnace, and crafts the pickaxe. With kits: `gatherer.gather`, `crafter.make` (which smelts). |
| `diamond_pickaxe` | `diamond-night` | Collects nine logs and runs the `iron_pickaxe` program. Then, for the nearest diamond ore within 128 blocks, it walks over the ore, digs straight down to its level in legs of 8 blocks (`GoalY`), and digs toward it in hops of five blocks (the pathfinder gives up planning one long dig through rock, but plans a short one fast, around lava and water); ore it cannot reach is skipped with its cluster. It strikes hostile creatures that come within 4 blocks between legs, mines three diamonds, crafts the pickaxe at a table it places down there, and walls itself in. `solve.sh` then runs a program that waits until the server's clock passes 24000 ticks. With kits: `crafter.make` for the pickaxes; the diamonds are dug with Mineflayer in every tier. |
| `shelter` | `survive-nights` | Digs a shaft three blocks deep into soft ground that has solid walls and floor, and seals it from inside. `solve.sh` then waits for as many `day` events as there are nights (`minebot wait --types day`), about 40 minutes. |
| `stock_chest` | `stock-chest` | The wooden pickaxe, 16 cobblestone, a chest placed next to the table, and the cobblestone in it. With kits: `gatherer.gather`, `crafter.make`, `container.deposit`. |
| `stash_chest` | `two-sessions`, step 1 | Collects 11 logs, makes the chest, stores 8 logs in it, writes the position to the note `stash` (and, with kits, to `explorer.remember`), and walks away in legs of 80 blocks until it is 200 blocks from the chest. |
| `retrieve_logs` | `two-sessions`, step 2 | Reads the chest's position from `explorer.places` or the note, walks there in legs of 80 blocks, takes the logs out (`container.withdraw` with kits), and crafts the stone pickaxe. |

Run the reference solution of every task with `harbor run -c bench/jobs/oracle.yaml -y`, or of some tasks with `--include-task-name "iron-tools-*"` (Harbor's glob). `survive-nights` runs for about 45 minutes of real time per tier, because night falls on the server's clock.

Without Harbor, run a task's solution against a development server (`npm run dev-server`) with a body that has the tier's flags (see `compose()`), and grade it with the verifier's own code: `node bench/verify/snapshot.ts <player>` (with `RCON_HOST=127.0.0.1`, `RCON_PASSWORD`, `WORLD_DIR=.dev-server/world`, `GRADING_DIR=<dir>`; `CONTAINER_AREA=minX,minZ,maxX,maxZ` keeps the containers of other players on that server out of the grade), then `node bench/verify/check.ts tests/milestones.json` (with `STATS_FILE`, `WORLD_FILE`, `HISTORY_FILE`, `REWARD_DIR`).
