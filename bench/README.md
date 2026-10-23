# minebot bench

minebot bench is a set of Minecraft tasks in the [Harbor](https://harborframework.com) task format. Harbor runs an agent harness such as Claude Code or Codex against each task and grades the result.

Each trial starts four containers, and a fifth for grading after the agent is done:

| Service | Image | Role |
| - | - | - |
| `main` | `minebot.local/minebot-client:dev` | The agent's terminal. It has the `minebot` CLI and MCP server (without the `body` command), pointed at the body, and the Mineflayer and pathfinder documentation that the instructions name. It has no body code, built-in routines, wiki, oracle, or verifier. |
| `body` | `minebot.local/minebot:dev` | One minebot body, logged in as the player `agent`. It records each program run to `/var/log/minebot/programs.jsonl` when the run ends. A run that has not ended when the body stops or is killed, or when Harbor collects the file, leaves no line. It holds neither the RCON password nor the world volume. |
| `minecraft` | `minebot.local/minebot-server:26.1` | A vanilla server with a fixed seed, in offline mode, with RCON on. Only the player `agent` may log in (a whitelist), and RCON accepts connections on the loopback interface only. The tag tracks the pinned version in `src/mc/version.ts`. |
| `grader` | `minebot.local/minebot:dev` | The body's image, which holds the snapshot code. It shares the network namespace of `minecraft`, holds the RCON password and the world volume (read-only), and sits idle until Harbor runs the snapshot hook in it after an agent session ends. |
| verifier | `minebot.local/minebot-verifier:dev` plus the task's `tests/` | Grades after an agent session ends, in a container of its own. Harbor builds it from `tests/Dockerfile`. |

## Isolation

The agent runs as root in `main`. These rules keep the grading out of its reach. The reasons are in `compose()` in `gen-tasks.ts`.

- **The verifier is a separate Harbor environment** (`[verifier.environment]` in `task.toml`). It runs in a container of its own, apart from `main`, so it never runs code that the agent could have changed. Its inputs are the task's spec and the grading snapshot that Harbor copies from `grader`. It reads nothing from `body` or `main`. A `[[verifier.collect]]` hook runs `verify/snapshot.ts` in the `grader` container after each agent session ends. Harbor stops `main` before the hook only for the last (or only) session of a task, so the hook does not depend on `main` being stopped: RCON, the world volume, and `/var/log/grading` are not reachable from `main`. The snapshot makes the server save its world over RCON, then writes two files to `/var/log/grading`: `stats.json`, the player's statistics, and `world.json`, which holds what the saved world shows (the containers, the overworld clock, and the player's position; see [Grading](#grading)).
- **`main` is on the `agent` network and on the internal `api` network, which it shares with `body` only.** `minecraft` is on the internal `game` network with `body`. `main` cannot resolve `minecraft` and has no mount of the world volume, which only `minecraft` (read-write) and `grader` (read-only) mount. The server container also drops connections to the game and RCON ports from outside its own network (`RESTRICT_TO_OWN_SUBNET`, with the `NET_ADMIN` capability), because rootless podman routes between the networks of a project: without that rule, `main` reaches the server by IP address. The `agent` network is not internal, so agent harnesses can still call their model APIs from `main`. Both networks of `body` (`api` and `game`) are internal, so the body has no route of its own to the internet. `main` has one, and `body` can reach `main` over `api`: an agent in `main` can fetch content from the internet itself, or run a process that listens on a port, which a module in the body reaches at `http://main:<port>/`.
- **The grader holds the RCON password and the world; the body holds neither.** `grader` shares the network namespace of `minecraft` (`network_mode: service:minecraft`), and the server accepts connections to the RCON port on the loopback interface only (`RCON_LOOPBACK_ONLY`, with the `NET_ADMIN` capability). `body` and `main` therefore cannot reach RCON even if they learn the password, and the password is in the environment of `minecraft` and `grader` alone.
- **Only the agent's player can log in.** The server runs with a whitelist (`white-list` and `enforce-whitelist`) that holds one entry, `agent`, so code that runs in the body cannot log in a second player. The generator writes the entry from the one name that also sets the body's `--bot=`, the snapshot's player, and the verifier's player, and the server image writes the `WHITELIST` environment variable verbatim to `whitelist.json`. The `minecraft` healthcheck fails closed: the server is healthy only when RCON answers and the server applied both protections (`white-list=true` in its `server.properties`, and the loopback-only RCON rule is loaded), so a server image that predates them never becomes healthy and the trial fails at start. Rebuild the images with `bench/build-images.sh`.
- **Milestones are off; routines and reflexes are on.** Every task body starts with `--no-milestones`: the agent cannot read, set, or grade milestones, so it has no live grader. No flag turns routines or reflexes off, so in every tier the agent saves its own routines, binds them to names, and binds them to events, and the history (`--history`) records each run, call, and reflex firing. The agent writes every routine and reflex itself; the body decides nothing that the agent did not bind. `status` shows deaths and reconnects only.
- **Programs are not sandboxed, and nothing flags them.** A program is a module that runs in the body's bot host process, a child of the supervisor. That process is not a security boundary: it has the whole Node API, so `process` and the body's files are in reach, and a program can import any package that the image holds. A program does not reach RCON, the world volume, or the grading files, which the body does not hold (`grader` holds all three, and `minecraft` holds the RCON password and the world). The body records each run in the history when the run ends. A run that has not ended when the body stops or is killed, or when Harbor collects the history, leaves no line. The verifier does not read the history. No program is flagged, and no trial is disqualified for what a program does.
- **Tiers are enforced by absence.** The body service's command runs `bench/tier/remove.ts` with the body's own flags, and starts the body only when the script succeeds (`sh -c 'node … remove.ts "$@" && exec minebot "$@"'`). The script reads the flags the way the body does, then deletes the source file of every built-in module that the offer does not include (`src/routines/<module>.ts`, after closing the offer over what its modules use). With `--wiki=off`, it deletes the wiki. Otherwise it rewrites each wiki page to what the body serves, so the pages and blocks of a withheld feature or module are gone from the files too. The deletion happens in the container's own layer, before any agent code runs. Code in the body runs as root with the container's default capabilities, and it cannot mount, remount, or reach the image layer below, so it cannot restore the files. If the script fails, `&&` stops the container before the body starts, and the trial fails at start. The `grader` container uses the same image with its own command, so the removal does not touch it. Three residuals remain:
  - For 0.18 to 0.96 s (measured), `sh` is the container's first process, and a stop signal in that window waits for the 10 s timeout.
  - The body has no route of its own to the internet, but `main` has one, and it can fetch content or relay it to the body (see the `api` network above). The removal cannot hold back what an agent fetches from outside the container.
  - This repository is public on GitHub (github.com/dpoage/minebot-sdk), so an agent in `main` can fetch the sources and the wiki pages that a tier withholds from the body. The agent's trajectory is the only record of such a fetch.
- **What `main` still contains.** The client is a thin program, but its source (`/opt/minebot/src`) names the commands that bodies may offer (`builtins`, `wiki`, `milestones`, `routines`, `bind`, `call`). An agent that reads the client source learns that these exist, not what they do. Nothing there depends on the tier. The public repository tells more: see the last residual of the tier lock above.

## Tasks and tiers

Each task exists in four tiers. A tier sets which built-in routines and which wiki the agent gets besides the base body. The task directory is named `<task>-<tier>`, for example `craft-stone-pickaxe-full`.

| Tier | Built-in routines offered | Wiki |
| - | - | - |
| `raw` | none | off |
| `kits` | move, sense, dig, place, inventory, craft, items, furnace, gatherer, crafter, builder, explorer, social | off |
| `wiki` | none | read |
| `full` | move, sense, dig, place, inventory, craft, items, furnace, gatherer, crafter, builder, explorer, social | read |

A tier starts the body with `--builtins=<modules>` (`--builtins=none` for no built-ins) and `--wiki=<off|read>`. The body offers the modules that the flag names and the modules they use. The generator computes that closure from the catalog in `src/routines/index.ts`, and `task.toml` lists it as `builtins` in `[metadata]`, next to `wiki`. The instructions describe the call shape (`minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'`, or `import * as gatherer from "minebot-sdk/routines/gatherer"` in a module) and name the whole offer. A task can add modules to the `kits` and `full` tiers (`extraBuiltins` in `gen-tasks.ts`): `survive-nights` and `diamond-night` add `survival` and `combat`, and `stock-chest` and `two-sessions` add `container`; no other module is task-specific.

The body's command is `sh -c 'node --conditions=minebot-sdk:source /opt/minebot/bench/tier/remove.ts "$@" && exec minebot "$@"' tier body <flags>`. It runs `bench/tier/remove.ts` with the body's own flags, and starts the body only if that succeeds. Compose reads `$` in a value as interpolation, so the generator writes each `"$@"` as `"$$@"`. podman-compose passes a lone `$@` through unchanged, and docker compose is untested.

Every tier has the base body: Mineflayer plus notes, status (deaths and reconnects), the event log with blocking waits, the one-line observation, and the routine library. In the library, the agent saves modules as routines, calls them by name, and binds them to events (reflexes). The built-in routines and the wiki are the tier features, and the tier table is the only difference between tiers. Every tier starts the body with `--no-milestones` and with no flag that turns routines or reflexes off. In every tier, the instruction teaches module runs (a default export that takes `ctx`, named imports, and `require`), routines, action bindings, and reflexes with their event names. It describes the built-in routines and the wiki only in the tiers that offer them.

Results of runs on this version are not comparable with results of runs from before routines. Every tier now has routines and reflexes, and a run is a module that can use named imports and `require`.

An agent does not learn about a feature that its tier lacks. For a tier without built-ins, the CLI help, `minebot builtins`, `minebot api`, the MCP tool list and descriptions, the injected globals, the observation, and error messages show nothing about built-in routines; the same holds for the wiki, lessons, and milestones. A test turns each capability off and asserts that no surface mentions it. The instruction describes the built-in routines and the wiki only when the tier has them. In the wiki tier, the pages teach the Mineflayer way. Report results for each tier separately, because the built-in routines and the wiki change what the score measures.

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

- **`iron-tools`** is the long crafting chain. The raw and wiki tiers have to build the smelting loop themselves (a furnace window, fuel, waiting for the output); the kits tiers offer `crafter.make({ item: "iron_pickaxe" })`, which smelts, and the wiki tiers have the pages on smelting and on finding ore. Iron ore is mostly underground, so every tier has to explore. Smelting counts as crafting in the statistics (the player's `crafted` count rises when the output is taken from the furnace), so the `iron_ingot` milestone is graded like any crafted item. Iron ingots and tools also occur in generated chests (villages, shipwrecks, dungeons, mineshafts), and a pickaxe crafted from a looted ingot would pass a grade on the last milestone alone. The task therefore sets `allRequired`: the reward needs every milestone, so the ore has to be mined and the ingots smelted.
- **`diamond-night`** is the hardest task: the whole iron chain, then a descent of 60 blocks and more to diamond ore (most common under the deepslate, near caves and lava), the diamond pickaxe, and no death before the server's clock passes the first dawn (24000 ticks, 20 minutes of real time). The built-in routines do not cover it end to end: `crafter.make` makes the pickaxes once the ore is in the inventory, but the descent, staying alive in the dark, and waiting out the night are the agent's own, which is what it measures beside the long chain. Every tier has reflexes, and the kits tiers add `survival` and `combat`, as in `survive-nights`. Every milestone is required, so a looted ingot or diamond does not pass it.
- **`survive-nights`** measures staying alive over a long stretch of real time: about 40 minutes at 20 ticks per second, with nothing to craft. Reflexes matter in every tier: the agent can bind a routine to `hurt`, `low_health`, `hostile_near`, or `night` that acts between its turns. The kits tiers also offer `survival` (eat, sleep in a bed, wear armor) and `combat` (attack, fight, retreat). The grade comes from the server's clock and the player's death count, which only the server knows: a checkpoint is the clock at 1 and at 2 days (24000 ticks each), and a death fails the trial. Sleeping through a night advances the clock like waiting does, so a bed is one valid way to finish.
- **`stock-chest`** adds containers, which the statistics do not show. Every tier can open a chest with Mineflayer, and the kits tiers add the `container` built-in. The verifier reads the contents of the chest from the saved world (see [Grading](#grading)).
- **`two-sessions`** measures continuity across a reset of the agent's context. It is a Harbor multi-step task: one trial, one set of containers and one world, and a new agent session at each step. See [Two sessions](#two-sessions).

`bench/gen-tasks.ts` generates every directory under `bench/tasks/` from its task catalog and tier list. Do not edit the generated files.

## Grading

The verifier (`verify/check.ts`) runs in its own container and grades from two artifacts and the task's spec:

1. `/var/log/grading/stats.json`: the player's statistics. After the agent is done, the grader makes the server save its world over RCON and copies the player's file (`verify/snapshot.ts`).
2. `/var/log/grading/world.json`: what the saved world shows, which the statistics do not: `clock`, the overworld clock in ticks (`/time query time`, which sleeping advances like waiting does); `player`, the player's position (`/data get entity`); and `containers`, every block entity with an inventory in the saved chunks, with its item totals. The snapshot reads the containers from the region files of the world volume (`verify/world.ts`), so the contents are the server's own record, found without knowing where the agent put a chest. The verifier reads this file only for a task that has checks.

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

`stored`, `nights`, and `distance` grade the snapshot of the current step. A `distance` check with `"snapshot": "previous"` grades the snapshot of the step before instead, and it is not met when the task has no step before. No other check takes `snapshot`; `withdrawn` already compares a step with the step before.

The reward is 1 when the last milestone and every check are met (every milestone, for a task with `allRequired`). A task with checks may have no milestones (`survive-nights`), and `progress` is the fraction of milestones and checks that are met. The snapshot counts every chest in the saved world that has an inventory. An unopened loot chest has none (it holds a loot table until someone opens it), but one that the agent or a creature opened does, and loot tables do hold logs (`village_taiga_house`: spruce, `pillager_outpost`: dark oak, `spawn_bonus_chest`: every kind) but no cobblestone. A `stored` check therefore counts what any chest holds, so pair it with milestones that the agent has to earn (as `stock-chest` and `two-sessions` do), and use `withdrawn`, which keys on the chest that an earlier step recorded, where a chest must be the one that was filled. A new `stored` check should name items that loot does not hold.

The verifier writes these files to `/logs/verifier/`:

- `reward.json` contains exactly `reward` (1 if the last milestone, or every milestone for `allRequired`, and every check are met, else 0) and `progress` (the fraction of milestones and checks met). The reward is a function of the spec, the statistics, and the world facts.
- `milestones.json` contains the statistics behind each milestone and the numbers behind each check.

Each task lists its milestones and checks in `tests/milestones.json`.

### Two sessions

`two-sessions` is a Harbor multi-step task (`[[steps]]` in `task.toml`, `steps/<name>/` for each step's instruction, tests, and solution). Harbor runs the steps one after another in one trial: the containers, the world, and the body stay, and the agent harness starts a new session for each step with that step's instruction. The session reset is the harness's own, so the task asks only what a reset costs: a new session has none of the previous session's context and the same body.

1. `stash`: collect logs, craft a chest, place it, put eight logs in it, and walk at least 200 blocks from the chest. The instruction says that a second session will continue and will be asked to craft a stone pickaxe from the logs in this chest, and that it can read the notes, list the saved routines, and see the world. Graded: the chest crafted, eight logs in a chest, and the player 200 blocks from it. The step has `min_reward = 1.0`: Harbor stops the trial when it is not met, so a second session never runs against a chest that does not exist.
2. `retrieve`: a new session, which knows only its own instruction. It has to find the chest, take at least four logs out of it, and craft a stone pickaxe. Graded: the stone pickaxe (statistics, which carry over from the first step), the `withdrawn` check (the chest that held the eight logs at the end of the first step is still there and holds four or fewer; any other chest, empty or not, does not count), and `first_session_far_away`, a `distance` check on the `previous` snapshot: the grader's snapshot of the first step shows the player at least 200 blocks from the chest. The check repeats the first step's `far_away` because Harbor runs that step's verifier while `main` is still up, and `main` shares the directory the verifier writes its reward to. A process that the agent leaves running can rewrite the first step's reward there, and the grader's snapshot is out of its reach.

The first step ends with the player far from the chest, so the second session cannot find it by looking. The body loads the chunks within the server's view distance (8 chunks, 128 blocks and the rest of the chunk at the edge, so under 144 blocks), and `bot.findBlocks` sees only loaded chunks; 200 blocks leaves the chest outside them. What the second session can use is whatever the first session left on the body: the notes and the saved routines (the instruction of both steps names them), the places of `explorer.remember` in the tiers that offer it, the event log, and the world. The verifier of each step runs after that step, and the trial's reward is the last step's (`multi_step_reward_strategy = "final"`); Harbor reports both. The grader keeps `/var/log/grading` between the steps, so the snapshot of the second step carries the first one as `previous`, and the verifier compares the two.

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
- `artifacts/minebot/programs.jsonl`: each program the agent ran, with its status, logs, and result, one line when the program ends. A run that has not ended when the body stops or is killed, or when Harbor collects the file, leaves no line. A reflex's `when` expression has a line of status `registered`. The verifier does not read this file.
- `artifacts/grading/stats.json`: the statistics that were graded.
- `agent/`: the harness transcript.

Run `harbor view bench/runs` to browse the results.

## Add a task

1. Add the task to `TASKS` in `bench/gen-tasks.ts`. It has one stage for each agent session (several stages make a multi-step task). A stage has the goal, the milestones (`gathered` for items from the world, `crafted` for items that are made) or checks, the agent timeout, and the `oracleTarget` for the reference solution. A task can add built-in modules to the kits tiers (`extraBuiltins`); the instruction and `task.toml` list the offer of that task. Every task has routines and reflexes in every tier, and the instruction teaches them; say in the task's goal text what else the agent needs to know.
2. Teach `oracle/progression.ts` the new `target`, and add it to the `OracleTarget` type in the generator.
3. Run `node --conditions=minebot-sdk:source bench/gen-tasks.ts`. It rewrites `bench/tasks/`.
4. Run the oracle job, and confirm that every tier of the new task gets a reward of 1.

## The reference solution

`oracle/progression.ts` is a minebot module: its default export is a routine `(ctx, { target, builtins })` that throws when it fails. The generator copies it into each task's `solution/` directory (into `steps/<name>/solution/` for a multi-step task), and Harbor uploads that directory to `/solution` in `main` only when the oracle agent runs. `builtins` is true in the kits and full tiers, whose body offers built-in routines, and false in raw and wiki. The reference solution uses the same API as the agent, and the agent's image does not contain it. Three paths reach the module:

- Most `solve.sh` files run it: `minebot run /solution/progression.ts --args '{"target":"<target>","builtins":<b>}' --timeout 900000`.
- `collect-logs` saves it as a routine, binds the action `oracle`, and calls it, as an agent does with a routine of its own: `minebot routines save /solution/progression.ts`, `minebot bind action oracle progression`, `minebot call oracle --args '{"target":"logs","builtins":<b>}'`.
- `craft-wooden-pickaxe` saves and binds it the same way and then runs `oracle/run-saved.ts`, a run that imports the saved module (`./progression.ts`) from the library and calls it. Its `solution/` directory holds `run-saved.ts` too.

Both saved paths run in every tier, so every trial of those two tasks goes through the library, the binding, and a call or a library import. The body's type check of the saved `progression.ts` reports `failed` in every tier. In raw and wiki, the body offers no built-in module for its `import("minebot-sdk/routines/<module>")` to resolve. In kits and full, `progression.ts` also imports `container`, which these two tasks do not offer. The save still succeeds, the CLI exits 0, and the module runs: it evaluates an import only when its target calls that module, and with `builtins: false` it evaluates none.

The first three targets (`logs`, `wooden_pickaxe`, `stone_pickaxe`) use Mineflayer alone in every tier. The newer ones call the built-in routines where the body offers them (`builtins` is true) and use Mineflayer where it does not, so one program solves a task in all four tiers. Each built-in module is imported where it is called, so a body that does not offer a module never evaluates its import, and a body that should offer one and does not fails the run:

| `target` | Task | What it does |
| - | - | - |
| `iron_pickaxe` | `iron-tools` | Collects seven logs of one species, makes the wooden and stone pickaxes, mines 11 cobblestone, finds three iron ore within 96 blocks (the server sends buried ore too, so it needs no cave), smelts them at a furnace, and crafts the pickaxe. With built-ins: `gatherer.gather`, `crafter.make` (which smelts). |
| `diamond_pickaxe` | `diamond-night` | Collects nine logs and runs the `iron_pickaxe` program. Then, for the nearest diamond ore within 128 blocks, it walks over the ore, digs straight down to its level in legs of 8 blocks (`GoalY`), and digs toward it in hops of five blocks (the pathfinder gives up planning one long dig through rock, but plans a short one fast, around lava and water); ore it cannot reach is skipped with its cluster. It strikes hostile creatures that come within 4 blocks between legs, mines three diamonds, crafts the pickaxe at a table it places down there, and walls itself in. `solve.sh` then runs the `dawn` target, which waits until the server's clock passes 24000 ticks. With built-ins: `crafter.make` for the pickaxes; the diamonds are dug with Mineflayer in every tier. |
| `shelter` | `survive-nights` | Digs a shaft three blocks deep into soft ground that has solid walls and floor, and seals it from inside. `solve.sh` then waits for as many `day` events as there are nights (`minebot wait --types day`), about 40 minutes. |
| `stock_chest` | `stock-chest` | The wooden pickaxe, 16 cobblestone, a chest placed next to the table, and the cobblestone in it. With built-ins: `gatherer.gather`, `crafter.make`, `container.deposit`. |
| `stash_chest` | `two-sessions`, step 1 | Collects 11 logs, makes the chest, stores 8 logs in it, writes the position to the note `stash` (and, with built-ins, to `explorer.remember`), and walks away in legs of 80 blocks until it is 200 blocks from the chest. |
| `retrieve_logs` | `two-sessions`, step 2 | Reads the chest's position from `explorer.places` or the note, walks there in legs of 80 blocks, takes the logs out (`container.withdraw` with built-ins), and crafts the stone pickaxe. |
| `dawn` | `diamond-night`, after `diamond_pickaxe` | Strikes hostile creatures within 3.5 blocks, once a second, until the server's day counter reaches 1, the end of the first night. `solve.sh` runs it with a timeout of 30 minutes. |

Run the reference solution of every task with `harbor run -c bench/jobs/oracle.yaml -y`, or of some tasks with `--include-task-name "iron-tools-*"` (Harbor's glob). `survive-nights` runs for about 45 minutes of real time per tier, because night falls on the server's clock.

Without Harbor, run a task's solution against a development server (`npm run dev-server`) with a body that has the tier's flags (see `compose()`), and grade it with the verifier's own code: `node bench/verify/snapshot.ts <player>` (with `RCON_HOST=127.0.0.1`, `RCON_PASSWORD`, `WORLD_DIR=.dev-server/world`, `GRADING_DIR=<dir>`; `CONTAINER_AREA=minX,minZ,maxX,maxZ` keeps the containers of other players on that server out of the grade), then `node bench/verify/check.ts tests/milestones.json` (with `STATS_FILE`, `WORLD_FILE`, `REWARD_DIR`).
