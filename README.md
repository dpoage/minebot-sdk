# minebot SDK

The minebot SDK gives AI agents a body in Minecraft Java Edition. A body is a long-running process that holds one Mineflayer player connection and serves an API. Any agent harness, such as Claude Code, Codex, or your own loop, controls the body through MCP, a CLI, or HTTP.

The agent acts by running modules: TypeScript or JavaScript files that the body evaluates against the live bot. A run returns the logs and the result. The agent can also save a module as a routine, call it by name, and bind it to events. The SDK ships built-in routines for the common work: walking, digging, crafting, gathering, and more.

The SDK does not decide anything for the agent. The harness owns the turn loop, the context, the prompts, and every decision. The body acts on its own only where the connection requires it (it reconnects after a disconnect and paces inventory clicks) or where the agent bound a reflex. See [docs/sdk.md](docs/sdk.md) for the layers and the boundary between the SDK and a harness.

If you used an earlier version with kits, triggers, or programs, read [Migrating from kits, triggers and programs](#migrating-from-kits-triggers-and-programs).

## Requirements

- Node.js 24 or later. An installed package runs compiled JavaScript. A checkout runs the TypeScript sources directly, without a build step.
- Java 25 or later, for the development server.
- Minecraft 26.1. minebot pins this version in `src/mc/version.ts` (`MC_VERSION`). It is the newest version in Mineflayer 4.39's `testedVersions`.

## Install

The package is not published to npm yet, so `npm install minebot-sdk` finds nothing. Install it from a checkout of this repository in one of three ways. In the checkout, run `npm install` first.

- **Tarball.** Run `npm pack` in the checkout. It builds the package and writes `minebot-sdk-0.1.0.tgz`. Then, in your project, run `npm install /path/to/minebot-sdk-0.1.0.tgz`.
- **Path.** Run `npm run build` in the checkout. Then, in your project, run `npm install /path/to/checkout`. Without the build, `tsc` cannot find the type declarations.
- **Link.** Run `npm run build` and `npm link` in the checkout. Then, in your project, run `npm link minebot-sdk`.

A project that `minebot init` wrote lists `"minebot-sdk": "^0.1.0"`, and a plain `npm install` in it fails with a 404 while the package is unpublished. Use one of the commands above instead. Then check the install:

```sh
npx minebot --help
```

The package is the authoring library plus the `minebot` command. The body stays a separate process: `minebot body` starts it, and everything else talks to it over HTTP. The package exports these subpaths:

| Import | What it is |
| - | - |
| `minebot-sdk/routine` | The surface for writing routines: `defineRoutine`, the `RoutineContext` type, `z`, and the helpers that the built-in routines use (`goals`, `Movements`, `Vec3`, `Position`, and more). |
| `minebot-sdk/routines/<module>` | One built-in routine module, such as `minebot-sdk/routines/move`. See [Built-in routines](#built-in-routines). |
| `minebot-sdk/client` | A typed HTTP client for a running body (`BodyClient`), and the request and response types of its API. It contains no CLI or MCP code. |
| `minebot-sdk/testing` | A test harness that runs routines against a fake bot. |

The package has no root export, so a bare `import "minebot-sdk"` does not resolve. The package ships the built-in routine sources (`minebot builtins source <module>` prints one) and the wiki pages. Each subpath resolves to compiled JavaScript with type declarations.

## Quick start

The steps below run from a checkout of this repository. With the installed package, run `npx minebot` where they say `npm run minebot --`. The development server script is part of the checkout only; the installed package works against any Minecraft 26.1 server.

1. Install the dependencies:

   ```sh
   npm install
   ```

2. Read the [Minecraft EULA](https://aka.ms/MinecraftEULA). Then start the development server:

   ```sh
   npm run dev-server -- --accept-eula
   ```

   The script downloads the vanilla 26.1 server jar to `.dev-server/`, checks its SHA-1, and starts it on `127.0.0.1:25565` in offline mode. Type server commands such as `op alpha` into this terminal.

3. In a second terminal, start a body named `alpha`:

   ```sh
   npm run minebot -- body --bot alpha
   ```

4. In a third terminal, send the body a run:

   ```sh
   echo 'export default (ctx) => ctx.bot.entity.position' | npm run --silent minebot -- run --bot alpha
   ```

## Control a body from an agent

Register the MCP server with your harness. For Claude Code, run this in a directory where `minebot-sdk` is installed, such as a workspace from `minebot init`:

```sh
claude mcp add minebot -- npx minebot mcp --bot alpha
```

From a checkout of this repository, point the harness at the source instead:

```sh
claude mcp add minebot -- node --conditions=minebot-sdk:source /absolute/path/to/minebot/src/cli.ts mcp --bot alpha
```

By default, the MCP server serves the core tools. The agent acts through runs, and a run reaches everything else through its context, `ctx` (`ctx.notes`, `ctx.status()`, `ctx.bot.chat`, `ctx.wiki`). A run cannot bind a routine, so the core set holds the tools that call and bind routines, and the one that documents the built-in routines. The core set also holds `send_chat`: while another run holds the slot, a new run is refused, and `send_chat` still speaks. A short tool list keeps the agent's context small.

| Core tool | What it does |
| - | - |
| `observe` | Returns position, vitals, armor, effects, biome, open sky, inventory, nearby creatures, run state, the spawn point, and the last death as one line. `full: true` returns the complete JSON. |
| `run_program` | Runs a module and blocks until it returns, fails, or times out. Its description holds the run reference for this body. |
| `stop_program` | Aborts the running run and halts movement, pathfinding, and digging. |
| `get_run` | Returns a finished run's record: status, logs, and error or result. `seq` is the `run` field in the `data` of the run's `program_finished` event. Do not pass the event's own `seq`: if that number is also the seq of a kept run, `get_run` returns that other run without an error. Without `seq`, it returns the most recent finished run. The body keeps the last 20 finished runs, so a caller that detached (a timeout, a killed CLI) reads the outcome here instead of running again. |
| `get_events` | Returns chat, damage, deaths, respawns, joins, disconnects, and what the player did or noticed (items picked up, blocks broken and placed, low health, food, or air, hostile creatures near) since a cursor. |
| `wait_for` | Blocks until a matching event arrives (chat, whisper, system message, night, day, hostile_near, low_health, low_food, low_oxygen, item_picked_up, ...) or the timeout, then returns it. The cheap way to idle. |
| `send_chat` | Sends a public chat message or a command as the player, or whispers to one player when you pass `to` (sent as `/msg`, so a leading `/` stays text and runs no command). Works while a run is going. |
| `api_reference` | Returns the run reference for this body: what a run is and what `ctx` holds. |
| `builtin_docs` | Returns the reference for the built-in routines: call shapes, arguments, and results. Only on a body that offers built-ins. |
| `call_routine` | Calls an action (a saved routine that `bind_routine` bound to a name) or a built-in routine by its `<module>.<routine>` name, with JSON arguments. Blocks until the call returns, fails, or times out, and answers like `run_program`. Only on a body that offers routines or built-ins. |
| `bind_routine` | Binds a name to a saved routine, as an action or, on a body with reflexes, as a reflex. With `source`, it saves the module first. A routine that the library does not hold is refused: ``no routine named "<name>" in this body's routine library; save it first: pass its TypeScript as `source` to bind_routine (or routine_save), or run `npx minebot routines save <file>.ts`, then bind again``. Only on a body that offers routines. |

`minebot mcp --tools full` also serves every other operation as a tool of its own:

| Tool | What it does |
| - | - |
| `status` | Returns deaths and reconnects since the body started, and progress toward the body's milestones. |
| `notes_list`, `notes_set`, `notes_delete` | Read and write the agent's persistent notes. |
| `list_builtins` | Lists the built-in modules, their uses and routines, and how often each routine worked. |
| `builtin_search` | Ranks the built-in routines and modules by what they do (names, descriptions, argument names). |
| `builtin_source` | Prints a built-in module's source: the model for writing your own. |
| `list_routines` | Lists the saved routines with their versions, and the names bound to them. |
| `routine_save` | Saves a routine from TypeScript source and returns its type check. |
| `routine_source` | Prints a routine's source. |
| `routine_versions`, `routine_revert` | Lists the saved versions of a routine; saves an earlier version again. |
| `unbind_routine` | Removes a binding. The saved routine stays. |
| `wiki_search`, `wiki_read`, `wiki_list` | Search and read the wiki. |
| `wiki_add_lesson` | Adds a lesson to the wiki, when the body allows writes. |

The MCP server reads the body endpoint on every call. If the body restarts, the MCP server keeps working.

Every MCP tool response starts with one `[since your last call] ...` line when something happened to the body since the previous response. The first response of an MCP process has no line: the digest starts at the end of the event log as it was then. The line reports deaths, a respawn point, a bot host restart, a kick, and a reflex that the body disabled. Nothing else adds it: damage, blocks, chat, and the `low_*` events stay in `get_events`. A single death reads `died once, last: drowned at 12 60 -3`; several read `died 3 times (drowned 2, fell 1), last: drowned at 12 60 -3`. A respawn after a death reads `respawned at 12 61 -3 (4 blocks away)`. A disabled reflex reads `reflex <name> disabled: <reason>`. A restart reads `bot host restarted`. The parts are joined with `; `. A response with no news has no line. The digest runs in the MCP process, so an MCP server that started before an upgrade answers without it until you restart that MCP server.

The MCP server asks the body which features it offers: before it connects, and before every tool call. It lists the built-in tools (`builtin_docs`, `list_builtins`, `builtin_search`, `builtin_source`) only when the body offers built-ins, the routine tools (`bind_routine`, `list_routines`, `routine_save`, `routine_source`, `routine_versions`, `routine_revert`, `unbind_routine`) only when the body offers routines, `call_routine` when the body offers either, the wiki tools only when the wiki is not `off`, and `wiki_add_lesson` only in `write` mode. `bind_routine` takes the reflex fields (`on`, `when`, and so on) only when the body also has reflexes. When the answer changes, tools appear or disappear and the server sends `notifications/tools/list_changed`. The `run_program` and `status` descriptions and `minebot api` describe only the offered features. While the body cannot be reached, the MCP server lists only the ungated tools of its tool set: `observe`, `run_program`, `api_reference`, `stop_program`, `get_run`, `get_events`, `wait_for`, and `send_chat`, plus `status` and the `notes_*` tools with `--tools full`.

## Runs

A run is a TypeScript or JavaScript module. The body type-checks it, strips the types, and evaluates it inside the bot host, against the live bot, afresh each time. The check refuses a run that would fail when it runs: a name that is not defined, a call of a member that does not exist, a call of a value that is not a function, an object with a key the type does not have, or the wrong number of arguments. A refused run does not start, and its status is `error` with this first line:

```
the run did not start: the type check found 1 error(s) in your code. Fix them and run again, or put // @ts-nocheck as the first line to run it unchecked.
```

Under it comes one line per error, `line <L>:<C> <message>` with the line and column in your source. Under a call of a `bot` member that does not exist, one more line names the member to use instead, such as `bot.selectItem does not exist: use bot.equip(item, "hand")`. That line appears only for a member on a short curated list of mistakes seen in practice, such as `bot.selectItem`, `bot.entities.values`, or `bot.inventory.items.filter`; any other missing member gets the TypeScript message alone. Other type errors, such as an unresolved module or a type mismatch, do not stop a run. A check that cannot answer is skipped, and the run goes on: without the `typescript` package, or after 3 seconds, the run's log gets one line, `type check skipped: <reason>`. A run that fails at run time on a `bot` member that is not a function gets the same kind of line at the end of its error, such as `bot.selectItem does not exist: use bot.equip(item, "hand")` or `bot.isRaining is a boolean, not a function: read bot.isRaining`. The result of a run is its default export:

- `export default <value>`: the result is the value. A promise is awaited.
- `export default async (ctx, args) => result`: the body calls the function with the run's context and the run's `args` (a JSON object, `{}` when none) and awaits the result.
- A module without a default export has no result.

A `return` statement outside a function is a syntax error, so a run cannot end with one. The body sends the result back as JSON. A static `import` declaration inside a function or block is a syntax error too. When the declaration begins its own line, the load error also says to move it to the top of the module, above `export default`, and, when the import names a module, shows `const name = await import("module")` as the way to load it at run time. An `import` that follows other code on the same line gets the parser's error alone.

`ctx` has these members and no others:

| Member | What it is |
| - | - |
| `bot` | The Mineflayer bot, with the pathfinder plugin loaded. The body refuses a `bot.pathfinder.goto` or `setGoal` value that is not a goal instance, before the pathfinder sees it: `bot.pathfinder.goto needs a goal object, e.g. await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)) with goals from "minebot-sdk/routine"; it got <value>`. `null` still clears the goal through `setGoal`. |
| `log(...)` | Appends to the output of the run. `console.log` appends too, and still prints where the host prints. |
| `sleep(ms)` | Waits, and rejects when the run is aborted. |
| `signal` | An `AbortSignal` that fires on timeout or stop. |
| `on(event, handler)` | Subscribes to a bot event. When the run ends or is aborted, the body removes the handlers that exist at that moment. |
| `notes` | The agent's persistent notes. See [Long-running bodies](#long-running-bodies). |
| `status()` | Resolves to deaths and reconnects, and to progress toward the body's milestones when the body has them. |
| `store(namespace)` | A persistent JSON store with `get`, `set`, `delete`, and `keys`. It survives restarts, and every run that opens the same namespace shares it. A namespace has 1-48 lowercase letters, digits, `_` and `-`, starts with a letter, and is not `notes` or `body`. |
| `wiki` | The wiki. Only when the wiki is not `off`. |

A run imports what it needs:

- Node built-ins, such as `node:fs`.
- The packages that the body ships: `mineflayer`, `mineflayer-pathfinder`, `vec3`, `minecraft-data`, the `prismarine-*` packages, and `zod`. Named imports from these CommonJS packages work: `import { goals, Movements } from "mineflayer-pathfinder"`. `minebot-sdk/routine` exports `goals`, `Movements`, and `Vec3` too.
- The subpaths of the SDK, such as `minebot-sdk/routine` and, for the built-in routines, `minebot-sdk/routines/<module>`.
- On a body with routines, the modules of the library as `./<name>.ts`.
- `require` works for the packages and Node built-ins, with the same resolution as `import`. A module that declares a binding named `require` keeps its own.

The body refuses every other file import: an absolute path, a `file:` URL, and a relative path that names no library module fail. `data:` and `node:` imports work.

This run walks to the nearest log and breaks it:

```ts
import { goals, type RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext): Promise<string> => {
  const { bot } = ctx;
  const ids = Object.values(bot.registry.blocksByName)
    .filter((b) => b.name.endsWith("_log"))
    .map((b) => b.id);
  const block = bot.findBlock({ matching: ids, maxDistance: 64 });
  if (!block) return "no log nearby";
  await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
  await bot.dig(bot.blockAt(block.position)!);
  return block.name;
};
```

Send a run from a file with `minebot run walk-to-log.ts`, or from stdin. `--args <json>` passes the `args` object to the default function, and `--timeout <ms>` limits the run. Without `--args`, `args` is `{}`. `null` is an argument, not a missing one: the CLI, HTTP, and MCP refuse it because `args` is a JSON object.

A run ends with a `program_finished` event. Its data holds `status`, `durationMs`, and `run`, the run's seq. A call adds `call`, the routine's name. A failed run adds `error`, the first line of the error message, and a run that returned a value adds `result`, the value as JSON. `error` and `result` stop at 200 characters, and a longer text ends with `…`. To read the whole outcome later, pass the event's `data.run` (not the event's own `seq`) to `minebot runs <seq>`, `GET /runs/<seq>`, or the `get_run` tool. Without a seq, each returns the most recent finished run. `GET /runs/<seq>` answers HTTP 404 when no run has finished or when the seq is not among the last 20 finished runs; the message lists the kept seqs. A reflex firing is not a kept run. A run during which the player died carries `diedDuringRun`, the number of deaths, in its record and in the run's own answer, and the printed record adds `died during this run (2 times); observe shows the last death`.

The run reference that `api_reference` returns (and that `run_program` carries) holds a complete run to copy and change, after the paragraph on imports and before the list of `ctx` members. On a body with routines that offers `inventory`, `sense`, or `move` (the first one found in that order), the run calls one routine of that module that only reads state or stops what is not running. After the `ctx` members comes a table of the bot members that agents get wrong, with the real member in the right column. On a body that offers built-in routines, the built-ins section at the end of the reference closes with a table of goals, with the built-in routine that already does each one. The reference writes a built-in call with `await`, as `await <module>.<routine>(ctx, { ... })`, and, on a body with routines, the import that brings it in.

The body runs one run at a time: runs, calls, and reflex firings share one slot. A second request gets HTTP 409, and the refusal names the holder: `busy: call_routine "count" has held the run slot for 42 s; wait_for ["program_finished"] or stop_program, then retry`. The holder is `run_program`, `call_routine "<name>"`, or `reflex "<name>"`, and the event to wait for is its `program_finished` or `reflex_finished`. The default timeout is 60 seconds; the maximum is 30 minutes. If a run times out or stops, the body halts pathfinding, digging, and movement keys, `ctx.sleep` rejects, and the body removes the `on` handlers that exist at that moment. The run then gets a grace period to end. If it does not end, the body kills the bot host and restarts it: the restart reconnects as the same player, and the run answers with its `status` (`stopped` or `timeout`) and an `error` that says the run did not stop. Every way to abort a run has this kill deadline: a stop, a timeout, and a preemption by a reflex. The body kills the host 5.5 seconds after the abort (the 5 second grace plus a 0.5 second margin), also when the run blocks the host with synchronous code after it catches the abort. The restart can start late: it waits 1 second, and the wait doubles after each restart in quick succession, up to 60 seconds. See [How it works](#how-it-works). Long loops must check `ctx.signal.aborted` so the run ends in time.

`globalThis` keeps its values between runs. A restart of the body clears them, and so does a restart of the bot host, the process that runs the modules. The bot host restarts after a crash, and when the body kills it for a run that does not stop. A timer that you create yourself outlives the run, and one that throws after the run has ended restarts the bot host. A listener you add to `ctx.bot` (`on`, `once`, `addListener`, `prependListener`, `prependOnceListener`) belongs to the run: the body removes it when the run ends, whatever the end, and `ctx.bot.off` removes it sooner.

An error that reaches the bot host while a run's code is active ends that run instead of restarting the host: a throw in a timer, a throw in a `ctx.bot.on("physicsTick")` listener, or a rejected promise that nothing awaited. A listener that throws is the run's alone: the event still reaches the listeners after it, and the bot keeps receiving packets. A rejection that arrives as the run ends counts as the run's too, for one more macrotask; a throw from a timer after the run has ended is a crash, and the supervisor restarts the host. The run's status is `error`, and its error is the throw's message; for a rejection, the message gains the line ` - this promise was not awaited; add await before the call`. Whatever the run's end, the body halts pathfinding, digging, held controls, and the item in use before the next run starts.

The body adds no notice text to run results beyond the `diedDuringRun` count. Facts stay in the observation: it keeps the open-sky view and `programsWithoutChange`, and `minebot observe --brief` adds `no change for N runs` when 3 or more runs in a row changed neither position nor inventory.

The observation reports, besides position, vitals, inventory, and nearby creatures: `armor` (head, chest, legs, feet) and `offhand`, `effects` (name, `amplifier` where 0 is level I, seconds `remaining`), the `biome`, the block the player is `standingOn`, the block in the line of sight within 5 blocks (`lookingAt`), and the `light` at the feet. `light.sky` is absent when the chunk has no sky light data. `spawnPoint` is the bed or respawn anchor the server confirmed for this host session, `null` once the server reset it to the world spawn, and absent while this host session has not heard either way. `lastDeath` is the most recent death of this host session: its `time`, `position`, and `cause`. The brief line adds the biome, and lists armor, the offhand item, and effects only while there are some; it also adds `last death 5m ago at -286 42 104 (drowned)` and `respawn: bed at 12 60 -3`, or `respawn: world spawn`.

Run `npm run minebot -- api` to print the run reference for a body. The `run_program` tool description contains the same text.

Besides chat, damage, and deaths, the event log records what the player does and notices, its vitals crossing a threshold, and its spawn point. Events about the player's own actions come from the actions themselves, so other players' actions and world updates do not produce them.

| Event | Data | When |
| - | - | - |
| `item_picked_up` | `item`, `count` | The player picks up a dropped item. |
| `block_broken` | `block`, `position` | A dig of the player finishes. |
| `block_placed` | `block`, `position` | A placement of the player is confirmed by the server. |
| `item_crafted` | `item`, `count` | A craft of the player finishes. |
| `hostile_near` | `name`, `id`, `distance` | A hostile creature comes within 16 blocks. Once per creature: it fires again only after the creature was 32 blocks away or gone. Enderman, zombified piglin, and strider do not count. |
| `low_health` | `health` | Health falls below 8. It fires again after health was back at 8 or more. |
| `low_food` | `food` | Food falls below 6. It fires again after food was back at 6 or more. |
| `low_oxygen` | `oxygen` | Air falls below 10 of 20. It fires again after air was back at 10 or more. |
| `death` | `position`, `cause`, `dropped` | The player dies. `cause` is the server's death message, which names the player, such as `ana drowned`, and is absent when the server sent none. `dropped` lists the items the player carried as `{ name, count }`, and is absent when it carried none. |
| `spawn` | `position` | The player spawns, after a join or a death. |
| `spawn_reset` | `{}` | The server reset the player's spawn point to the world spawn. |

## Built-in routines

The SDK ships 19 built-in routine modules in `src/routines/`. Each module holds routines that do one kind of work. A built-in routine has a call name, `<module>.<routine>`, and takes one object argument. Every call validates its arguments and its result against the routine's zod schemas, nested calls included. A bad call fails with the schema.

| Module | Uses | Routines |
| - | - | - |
| `move` | | `to`, `stop` |
| `sense` | | `find`, `look` |
| `dig` | | `dig` |
| `place` | | `place` |
| `inventory` | | `list`, `count`, `equip`, `toss` |
| `craft` | | `craft`, `table` |
| `items` | | `recipes`, `drops`, `rename` |
| `furnace` | | `smelt`, `take` |
| `container` | | `list`, `deposit`, `withdraw` |
| `survival` | | `eat`, `sleep`, `wake`, `armor` |
| `combat` | | `attack`, `fight`, `retreat` |
| `farm` | | `till`, `plant`, `harvest`, `breed` |
| `bucket` | | `fill`, `empty` |
| `gatherer` | move, sense, dig, inventory, items | `gather`, `collectDrops` |
| `crafter` | move, sense, place, inventory, craft, items, furnace | `plan`, `make` |
| `builder` | move, sense, dig, place, inventory | `materials`, `build`, `check`, `line`, `arc`, `fill`, `box`, `combine` |
| `explorer` | move, sense, dig | `scan`, `explore`, `remember`, `places`, `waypoints`, `travel`, `surface` |
| `social` | move, sense, inventory | `say`, `waitForChat`, `players`, `follow`, `give`, `gesture`, `sign`, `book` |
| `trade` | move | `offers`, `buy` |

The first thirteen modules do one thing each. The last six build on them through their public routines, so anything they do, your own routine can do too. See [docs/sdk.md](docs/sdk.md) for the full model.

What the routines do that a first call does not show:

- `move.to` fails fast. After 12 seconds with no progress (no movement, no digging, and no block change near the bot), it throws `stuck at ...`. When the pathfinder ends without a way within `range`, it throws `could not reach ...` and names the cause. It throws `out of air at ...` when the breath bar falls under 10, `the path ended 10.0 blocks short` when a finished path leaves the player short (the distance has one decimal), and `every way down is a drop of 20 blocks (the pathfinder drops at most 4) - dig or build stairs down, or pick a target on this level` when every route needs a deeper fall than the pathfinder takes (the fall is a whole number of blocks).
- `move.to` takes `allowDigOwnBuilds` (default `false`). The pathfinder never breaks a block that this body placed since the player connected, and never scaffolds a cell under one within 16 blocks. A walk that is blocked by one throws `could not reach (10, 64, 0): every way goes through blocks you placed (e.g. oak_planks at (4, 64, 0)); open a door, break one yourself, or call move.to again with allowDigOwnBuilds: true`. Pass `allowDigOwnBuilds: true` to cut through what you built. The record is kept per bot connection: a reconnect, and a restart of the bot host, both forget it.
- `dig.dig` reports success only after the server confirms the break. When the server does not confirm within 3 s, the call throws and the block is still there: `the server did not break <block> at <pos> within 3 s although it is in reach (...)`. A block whose box is 5.5 blocks or more from the eyes throws `the server refused to dig <block> at <pos>: its box is 5.83 blocks from your eyes and the server digs only closer than 5.5. Walk next to it with move.to({ position: { x: <x>, y: <y>, z: <z> }, range: 3 }), then dig again.` (the distance has two decimals). Thin blocks, such as a torch, a sign, a flower, or short grass, are dug the same way as stone.
- `survival.sleep` fails in daylight with `it is not night (time of day N); a bed works from 12541 to 23458, or in a thunderstorm; the window opens in N s. To wait for it, call survival.sleep with { wait: true } and a call timeout_ms of at least <ms>`. With `wait: true` it walks to the bed, waits there up to `timeoutMs` (default 660000), and sleeps when the window opens. Give the call a `timeout_ms` above the wait: the wait logs `... If this call's timeout_ms is shorter, it is cut off first: call again with timeout_ms >= <ms>`. A clock that never reaches night fails at once.
- `combat.attack` returns `reason` when `killed` is false: the target is gone, still in reach when the time ran out, it outran you, or the way to it is blocked. Each reason ends with what to do next.
- `items.recipes` returns every recipe for an item, one per variant, so `stick` lists 13. `crafter.plan({ item, count })` is the dry run: it returns `{ item, count, have, missing, alternatives }` and acts on nothing. `missing` holds the raw materials still to gather, `{}` means `crafter.make` can make the item now, and `alternatives` lists a material that would do instead.
- `place.place` does not refuse a placement up front because another body stands in the cell. It tries, and then throws, with the cause, when the block does not end up in every cell it needs. It accepts the variants that placing an item gives (`wall_torch` for `torch`, `oak_wall_sign` for `oak_sign`). For a block of two cells (a door, a bed), it verifies both cells. It sneaks when it places against a block that opens a window or takes the item, such as a crafting table or a chest. It walks closer only when no neighbor face is within 5.0 blocks of the eyes.
- `gatherer.collectDrops` returns `{ reached, unreachable }`. `reached` counts the positions it walked to (several stacks in one block count once), and `unreachable` lists the positions it could not reach.
- `craft.craft` closes a window that earlier code left open before it crafts, and logs `closed the open <type> window first`. It waits for the inventory to settle after the craft, and returns how many items the inventory gained. When the inventory has no room for the result, it throws `InventoryFullError`: the items fell at the bot's feet, and the message says how to recover them. When nothing arrives, it throws `crafted 0 of ...`.
- `builder.line`, `builder.arc`, `builder.fill`, `builder.box`, and `builder.combine` make a blueprint from a few numbers and return `{ origin, blueprint }` in world coordinates. `builder.build` and `builder.check` take that result as it is: `await builder.build(ctx, await builder.box(ctx, { from, to, wall: "cobblestone", roof: "cobblestone" }))`. A blueprint cell of `air` digs out the block there; it needs no material.
- `trade.offers` walks to the nearest villager or wandering trader and returns its offers. `trade.buy` makes offer number `index` up to `times` times, and returns `{ traded, gave, got, shortfall? }`, measured from the inventory. `shortfall` says why a run that traded fewer than `times` times stopped early. When no trade happens at all, `trade.buy` throws and names the cause, such as `did not trade: the inventory has no room ...`.

There are two ways to call a built-in routine:

- **By name.** `minebot call move.to --args '{"position":[13,92,-9],"range":2}'` calls it as a run. It needs no binding. MCP serves it as `call_routine`, and HTTP as `POST /call`.
- **By import.** A routine or a run imports the module and calls the routine with its own `ctx`: `move.to(ctx, { position: [13, 92, -9], range: 2 })`.

```ts
import { defineRoutine, z } from "minebot-sdk/routine";
import * as crafter from "minebot-sdk/routines/crafter";
import * as gatherer from "minebot-sdk/routines/gatherer";

export default defineRoutine(
  {
    description: "Dig logs, then craft a crafting table.",
    args: z.object({ logs: z.number().int().positive().default(4) }),
    returns: z.number(),
  },
  async (ctx, { logs }) => {
    await gatherer.gather(ctx, { blocks: "*_log", count: logs });
    return crafter.make(ctx, { item: "crafting_table" });
  },
);
```

The operator decides which built-in modules a body **offers**. The flag `--builtins <a,b|none>` names them:

- Without `--builtins`, the body offers every built-in module.
- `minebot body --bot ana --builtins gatherer,crafter` offers the two named modules and every module they use (`move`, `sense`, `dig`, `inventory`, `items`, `place`, `craft`, and `furnace`).
- `--builtins none` offers none. A name that is not a built-in module stops the start.
- A module that the body does not offer is absent from every surface: it is not listed, documented, searched, or called, and a routine that imports `minebot-sdk/routines/<module>` for it fails. That refusal is not a security boundary: an import of an encoded subpath reaches the module.

There is no active set to choose from. Every offered routine is callable at any time.

The reference is generated from the routines' schemas: argument names, types, and defaults.

| What | CLI | MCP | HTTP |
| - | - | - | - |
| List the modules, with how often each routine worked | `minebot builtins` | `list_builtins` | `GET /builtins` |
| Print the reference | `minebot builtins docs [module...]` | `builtin_docs` | `GET /builtins/docs?names=` |
| Find a routine by what it does | `minebot builtins search <query>` | `builtin_search` | `GET /builtins/search?q=&limit=` |
| Print a module's source | `minebot builtins source <module>` | `builtin_source` | `GET /builtins/source?name=` |
| Call a routine | `minebot call <module>.<routine>` | `call_routine` | `POST /call` |

Some routines keep state in a store of their own, which every run that opens the namespace shares. The store survives runs and body restarts. Explorer places, for example, persist across restarts.

The body counts every call of every built-in routine, nested calls included: how often it returned and how often it failed, and the message of the last failure. A call that fails because the run was stopped, timed out, or was preempted does not count as a failure. The counts are per body, live in the state directory (`kit-stats.json`), and survive restarts. `minebot builtins` prints them under the module (`calls: gather: 12 ok / 3 failed`), so an agent can prefer the routines that work. To find a routine by what it does, search: `minebot builtins search "collect logs"`, the `builtin_search` tool, or `GET /builtins/search`.

Built-in search and wiki search match words in the same way. A query word matches a word exactly, by prefix (`craf` finds `crafting`, `smelting` finds `smelt`), or with typos: one when both words have 4 or more letters, two when both have 7 or more (`furnce` finds `furnace`). A prefix or typo match of a query word counts only where the exact word is missing, and it counts less than an exact match. Every result that contains a query word exactly ranks above every result that contains none, so a one-word query ranks its exact results as it would without fuzzy matching.

## Routines

A routine is a TypeScript module that the agent saves in a library on the body. The agent calls a routine by name, or binds it to events. A routine is a real ES module, not run text: it uses `import`, it imports other routines, and its source stays on the body between runs. A body offers routines unless it starts with `--no-routines` or `--routines ""`.

```ts
// helper.ts
export const double = (n: number): number => n * 2;
```

```ts
// count-logs.ts
import { defineRoutine, z } from "minebot-sdk/routine";
import { double } from "./helper.ts";

export default defineRoutine(
  {
    description: "Counts the logs in the inventory, doubled.",
    args: z.object({ prefix: z.string().default("oak") }),
    returns: z.object({ count: z.number() }),
  },
  async (ctx, { prefix }) => {
    const count = ctx.bot.inventory.items().filter((i) => i.name.startsWith(prefix)).reduce((sum, i) => sum + i.count, 0);
    ctx.log("counted", count);
    return { count: double(count) };
  },
);
```

```sh
minebot routines save helper.ts count-logs.ts   # list the imported module first
minebot bind action count count-logs            # name the routine for calls
minebot call count --args '{"prefix":"birch"}'  # runs it and prints the status, the logs, and the result
minebot routines                                # the saved routines, and the names bound to them
```

### Write a routine

The default export of the module is a function `(ctx, args) => result`. `defineRoutine({ name?, description?, args?, returns? }, fn)` declares it with types and checks. A plain default-exported function works too. A routine receives the same `ctx` as a run; see [Runs](#runs).

- `args`: a zod schema. The body checks the arguments of every call against it and gives the routine the parsed value, with defaults applied. A call with bad arguments fails before the routine runs, and the error holds the schema. Without `args`, the routine gets its arguments unchecked.
- `returns`: a zod schema. The body checks the result of every call against it. A result that does not match fails the call.
- `name`: the routine's name in the error messages of a direct call of the routine value, such as a call from another routine that imports it (`routine` when it has none). A built-in routine declares `<module>.<routine>`, and [the test harness](#test-a-routine) records the calls of every routine named that way, yours too.
- `description`: text for the readers of the source. The body does not show it.

Only a missing argument becomes `{}`. A call without `--args` passes `{}`, and a reflex passes `{ event }`. `null` is an argument: a direct call `routine(ctx, null)` and `h.run(routine, null)` hand `null` to the routine's schema, and a `z.object` refuses it.

A routine imports `Vec3`, `goals`, and `Movements` rather than finding them on `ctx`. Take them from `minebot-sdk/routine` (`import { goals, Movements, Vec3 } from "minebot-sdk/routine"`) or from the packages (`import { goals, Movements } from "mineflayer-pathfinder"` and `import { Vec3 } from "vec3"`). Named imports from these CommonJS packages work, and so does `require`.

`ctx.on`, `ctx.sleep`, `ctx.signal`, and the listeners the routine adds to `ctx.bot` end with the call. The body removes a `ctx.bot` listener at every end of the call, whatever the end, and `ctx.bot.off` removes one sooner; one that throws ends the call with status `error`, and the bot keeps its connection and its other listeners keep hearing events. A listener that must outlive the call is added to the bot itself: `unscopedBot(ctx.bot)` (`import { unscopedBot } from "minebot-sdk/routine"`) returns the plain bot, and removing that listener is then the routine's job. The timers the routine creates itself are real: they outlive the call, and the body never clears them. A leftover timer that throws after the call has ended crashes the bot host. The supervisor then restarts the host, and the agent sees a `disconnected` event.

### The library

The library is a flat directory of `<name>.ts` files. `--routines <dir>` picks the directory; the default is `routines/` in the state directory. `--routines ""` turns routines off, as `--no-routines` does. Bodies that share the directory share the routines.

- A name has 1-48 lowercase letters, digits, `_`, and `-`, and starts with a letter. Bindings use the same rule.
- A source has at most 128 KiB. Saving a bad name or an oversize source fails and writes nothing.
- A save takes effect at the next call or firing, without a restart. A module that other routines import reloads them too.
- Saving over a routine keeps the old source as a numbered version, in `.history/<name>/<n>.ts` and `<n>.json` (`version`, `savedAt`, `savedBy` — the name of the body that saved it). Saving the source that is already current adds no version. `routines versions <name>` lists the versions.
- `routines revert <name> <version>` saves an earlier version again as a new version, so the history only grows.
- A file whose bytes are in no version, because someone edited it by hand, becomes a version saved by `unknown` before the next save or revert writes over it.
- No command deletes a routine. `unbind` removes only a binding.

A save returns `typeCheck`: `passed`, `failed` with one `<name>.ts(line,col): error TS...` entry per error, or `skipped` with a reason. A failed check does not stop the save. The check uses strict options that match how Node loads the file: Node strips the types and changes nothing else, so an `enum`, a namespace that holds code, or a type imported as a value fails the check.

### Imports

A routine imports what a [run](#runs) imports: Node built-ins, the packages that the body ships, the subpaths of the SDK (`minebot-sdk/routine`, `minebot-sdk/routines/<module>`, `minebot-sdk/client`, and `minebot-sdk/testing`), and other routines in the same library, as a relative import that names the `.ts` file: `import { double } from "./helper.ts"`. An import that leaves the library fails. A routine cannot import a built-in module that the body does not offer.

These limits apply:

- When you save several routines, list the imported modules first (`routines save helper.ts count-logs.ts`). The type check of a routine runs when it is saved, and it reports TS2307 for a module that is not saved yet.
- The type check does not catch a relative import that names `.js` for a `.ts` file. The save passes, and the call fails with `Cannot find module`.
- The library must not live under `node_modules`. Node does not strip types there, and the call fails.
- Node versions before 24.3 print a type-stripping warning when a routine loads.
- The type check needs the `typescript` package. Without it, the check is `skipped` and says why.
- The type check finds `@types/node` where a hoisted install puts it. In an `npm install --install-strategy=nested` install it is missing, and imports of Node built-ins fail the check with TS2591. The routine still runs.

### Actions

An action is a routine that the agent calls by name. `bind action <name> <routine>` names a saved routine; binding the same name again replaces the binding. The bind checks that the routine exists, and it does not load the module. Bindings persist in `bindings.json` in the state directory.

`call <name>` runs the routine with the JSON arguments and answers like `run`: `status` (`ok`, `error`, `timeout`, or `stopped`), the `result` (what the routine returned), the `error`, and the `logs`. A name with a dot, `<module>.<routine>`, is a built-in routine and needs no binding. A call is a run:

- The body runs one run, call, or reflex at a time. A call that arrives while another run is going gets HTTP 409.
- The default timeout is 60 seconds and the maximum is 30 minutes (`--timeout <ms>`).
- `minebot stop` and the timeout abort the call, and the kill deadline of [Runs](#runs) applies.
- A call that names no bound action, or no offered built-in routine, gets HTTP 404.
- The history (`--history`) records the call with an empty `code` and `call: { name, routine, args }`, without `args` when the call had none. A built-in's line has `call: { name, args }`, the same way.

### Reflexes

A reflex is a routine that the body calls when an event arrives, so the agent can install reflexes that act between its turns: eat when food is low, flee when hurt, answer a chat. The agent writes every reflex. The body decides nothing that the agent did not bind. `bind reflex <name> <routine> --on <types>` binds one. The body calls the routine as `(ctx, { event })`. The `event` is `{ seq, type, time, data }`, as in the event log.

```ts
// note-chat.ts
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

| Field | Meaning |
| - | - |
| `name` | 1-48 lowercase letters, digits, `_`, and `-`, starting with a letter. Binding an existing reflex name replaces the reflex. |
| `routine` | The saved routine to call. |
| `on` | Event types that fire the reflex: any event in the log, such as `hurt`, `chat`, `night`, `low_food`, `hostile_near`. A reflex cannot listen to `reflex_*` events. |
| `when` | A JavaScript expression over `event` and `bot`. The reflex fires only when it is truthy. It is cut off after 100 ms. |
| `from`, `match` | Filters for `chat` and `whisper` events, as for `wait`. |
| `cooldownMs` | Least time between two firings. Default 1000. |
| `timeoutMs` | The run is aborted after this long. Default 30000. |
| `preempt`, `priority` | Whether the firing may stop the running run, and the order of waiting firings. |
| `enabled` | Default true. |

A reflex run is a run, so the body runs one at a time. A firing that arrives while another run goes waits until that run ends. A reflex waits at most once, so repeated events while it waits do not queue repeats. Waiting reflexes run highest `priority` first. With `preempt: true`, the firing stops the running run (it ends as `stopped`, like `minebot stop`) and runs when that run has ended; it does not stop a running reflex of equal or higher priority. A `run` or `call` request that arrives while a reflex runs gets HTTP 409.

- Each firing adds a `reflex_fired { name, event }` event and, when the run ends, `reflex_finished { name, status, durationMs, error?, logs? }`. A reflex run ends with `reflex_finished` and not with `program_finished`. An event that arrives while the body is not connected fires nothing.
- A reflex that fails 3 times in a row (an error or a timeout) disables itself and adds `reflex_disabled { name, failures, reason }`. A failure never affects the body. No route enables a reflex again: bind it again. A new bind replaces the reflex, resets its counts, and enables it.
- Deaths disable a reflex too. A death counts against a reflex when it falls during that reflex's firing or within 180 seconds after the firing ends. When 2 counted deaths fall within 10 minutes, the body disables the reflex and adds `reflex_disabled { name, failures, reason }` with the reason `the player died 2 times within 10 min during or right after its runs (last: drowned at 12 63 -4); bind it again with bind_routine and its full settings (list_routines shows them) to turn it back on`. A death that this breaker charges does not fire the reflex it disabled. Bind the reflex again to turn it back on. The rule exists for reflexes that walk the player back to a grave: an underwater grave that drowns the player again is not worth the loot.
- Reflexes persist in the state directory, so they survive a restart of the body. The reflex statistics (fired counts and last status) restart at zero.
- One name belongs to one action or reflex at a time. A bind that clashes with a name of another kind gets HTTP 409. Run `unbind` first.
- A body keeps at most 50 reflexes. A body started with `--no-reflexes` has none, and `bind reflex` is unavailable there.
- `minebot routines` and `GET /bindings` list a reflex with what it did since the body started.
- The history records a bind as a line with status `registered` and the reflex's `when` as its `code`, and each firing with `trigger` (the reflex's name), `routine`, and `event`.

### HTTP, CLI, and MCP

| Operation | HTTP | CLI | MCP (full set unless noted) |
| - | - | - | - |
| List routines | `GET /routines` | `minebot routines` | `list_routines` |
| Save | `POST /routines/save` `{ name, source }` | `minebot routines save <file...>` | `routine_save`, or `bind_routine` with `source` |
| Read the source | `GET /routines/source?name=` | `minebot routines source <name>` | `routine_source` |
| List versions | `GET /routines/versions?name=` | `minebot routines versions <name>` | `routine_versions` |
| Revert | `POST /routines/revert` `{ name, version }` | `minebot routines revert <name> <version>` | `routine_revert` |
| Bind | `POST /bind` `{ kind, name, routine, ... }` | `minebot bind action\|reflex ...` | `bind_routine` (core set) |
| List bindings | `GET /bindings` | `minebot routines` | `list_routines` |
| Unbind | `POST /unbind` `{ name }` | `minebot unbind <name>` | `unbind_routine` |
| Call | `POST /call` `{ name, args?, timeoutMs? }` | `minebot call <name>` | `call_routine` (core set) |

The MCP tools take `timeout_ms` and `cooldown_ms`, as the other MCP tools do; HTTP and the CLI use `timeoutMs` and `--timeout`.

## Authoring workspace

`minebot init [dir]` scaffolds a TypeScript workspace for writing routines and runs. The body stays a separate process; the workspace holds source files and a type checker.

```sh
npm run minebot -- init ../ws && cd ../ws    # from a checkout; an installed package: npx minebot init ws
npm install /path/to/minebot-sdk-0.1.0.tgz   # while the package is unpublished; see Install
npx minebot body --bot dev                   # in another terminal
npx minebot routines save --bot dev routines/*.ts  # save the routines into the body's library
npx minebot bind --bot dev action hello hello
npx minebot call --bot dev hello
npx minebot run --bot dev runs/say-hello.ts
npx tsc                                      # checks routines/, runs/, and test/
npm test
```

`init` writes `package.json` (dependency `minebot-sdk`, dev dependencies `typescript` and `@types/node`), a strict `tsconfig.json`, `routines/hello.ts` (an example routine that says a message in chat, reports where the player stands, and counts the matching items in the bot's inventory itself, with no built-in), `runs/say-hello.ts` (a run that calls it), `test/hello.test.ts` (a routine test on the harness, run with `npm test`), `.gitignore`, and a README. It never overwrites a file that exists.

A routine imports its helpers from `"minebot-sdk/routine"` and the built-in modules from `"minebot-sdk/routines/<module>"`. A run is a module like a routine, so it may use top-level `await` and `export default`. Its relative imports (`./hello.ts`) name modules of the body's library. The `tsconfig.json` lists `routines` and `runs` in `rootDirs`, so `tsc` reads a run's `./hello.ts` as `routines/hello.ts`. Give a run a file name that no routine has: `runs/hello.ts` would import itself. `minebot run` sends the file as it is, and the body type-checks it before it runs and strips the types.

The tsconfig uses the same compiler options as the two checks that the body runs: the one on a routine save, and the one before a run starts (`erasableSyntaxOnly`, `verbatimModuleSyntax`, and the rest), so `npx tsc` and the body agree. `minebot init` does not upgrade a workspace: see [Migrating from kits, triggers and programs](#migrating-from-kits-triggers-and-programs).

## Test a routine

`minebot-sdk/testing` runs a routine in a test, with no Minecraft server. `createHarness` builds a fake Mineflayer bot on the real registry for the version the body targets, and gives routines the body's contract: argument and result validation, `ctx.store` namespaces in memory, and the observation of built-in calls. `h.run(routine, args?)` calls a `defineRoutine` value, a plain function, or a module namespace through the same code as the body. Each call gets a `ctx` of its own. `h.logs` holds what the routine logged. `init` scaffolds a workspace with an example test (`npm test`).

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import countLogs from "../routines/count-logs.ts";

test("count-logs doubles the logs it finds", async () => {
  const h = createHarness({ inventory: { oak_log: 3 } });
  assert.deepEqual(await h.run(countLogs), { count: 6 });
  assert.deepEqual(h.logs, ["counted 3"]);
});
```

`h.calls` records the calls of the routine values named `module.routine`, nested calls included, in the order they started: every built-in routine, and a routine of yours whose `defineRoutine` declares such a `name`. Each record is `{ kit, action, args }`: `kit` is the module, `action` is the routine, and `args` are the arguments as the caller passed them. The harness does not record a routine value without such a name, such as a plain function.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import hello from "../routines/hello.ts";

test("hello counts the logs through inventory.count", async () => {
  const h = createHarness({ inventory: { oak_log: 3 } });
  await h.run(hello);
  assert.deepEqual(h.calls, [{ kit: "inventory", action: "count", args: { items: "*_log" } }]);
});
```

In `h.run`, `ctx.status` and `ctx.wiki` throw `UnsupportedApiError`, because the harness has no body to ask.

Options (all optional): `inventory` (`{ item: count }`), `equipment` (`{ head: "iron_helmet" }`, from the inventory), `blocks` (a block at `at`, or a box `from`/`to`, with block `properties`), `ground` (a one-block-thick layer, default stone at y 63; `false` for a world of air), `entities` (`{ name: "cow", at }`, a player with `username`, a dropped item with `name: "item", item`), `position` (default the top of the ground at the origin), `time` (ticks since dawn), `health`, `food`, and `username`. The harness gives back `run`, `calls`, `logs`, `chat`, `inventory`, `count`, `give`, `blockAt`, `setBlock`, `position`, `teleport`, `spawn`, `entities`, `advance(ticks)`, `abort(reason)`, `furnaceAt`, and the `bot`.

What the fake bot does:

- **World.** `blockAt`, `findBlock`, and `findBlocks` over the ground layer and the blocks you set (real prismarine blocks, so harvest tools and dig times follow the registry). `findBlocks` follows Mineflayer: the point is floored, `maxDistance` and `count` default when 0, a predicate is first called with a position-less block, and a function `useExtraInfo` filters. Air is the rest of the world and is not enumerable. Digging removes the block, advances the clock by the dig time, and drops the items: the registry's drops, plus what it leaves out (the crop item of ripe wheat and beetroots, a bed's head). Placing sets a block, spends the held item, and refuses a cell the bot or another creature stands in. Digging, placing, crafting at a table, and opening furnaces are limited to 4.5 blocks from the eyes: out of reach, the real server ignores the click and Mineflayer waits forever, so the harness throws instead.
- **Inventory.** Mineflayer's slot layout with `items()`, `equip`, `toss` (a null count tosses one), `heldItem`, `quickBarSlot`, `emptySlotCount()`, and `getEquipmentDestSlot`; crafting with the real recipes (`recipesFor`, `recipesAll`, `craft`). Item drops are entities: walk over them to pick them up.
- **Pathfinding.** `goto` and `setGoal` teleport to the nearest standable spot that satisfies the goal (`goals.GoalNear`, `GoalBlock`, `GoalInvert`, ...), or fail with `No path to the goal!`: within 12 blocks of the goal, or for `GoalInvert` within 64 blocks of the bot. Like the plugin, `setGoal` returns at once and emits `goal_reached` on a later turn, then clears a goal that is not dynamic.
- **Furnaces.** Furnace blocks open as windows, and their contents cook on the harness clock with the real burn and smelt times; an open window emits `update` and reports `fuel` as a fraction of the fuel item burning. `ctx.sleep(ms)` passes `ms / 50` ticks and then yields to the event loop, so a routine that polls with `ctx.sleep` lets `within` timeouts and timed `abort()` calls fire. `advance(ticks)` passes more.
- **Entities, time, health, food, and chat.** Entities with registry categories (`isHostile` works), the day clock (`time.day` counts days), `bot.chat` into `chat`, `bot.consume` for food. Data members the harness does not model read as Mineflayer's idle value (`currentWindow` and `targetDigBlock` are null, `usingHeldItem` is false).

Scope is decision logic, not physics: nothing walks, collides, or takes time except where listed (dropped items do fall to the ground). The harness clock is its own: it does not fake `Date.now()`, so a loop bounded by wall-clock time (a deadline built from `Date.now()`) still ends by that deadline in real time. Everything else in Mineflayer is unsupported, and calling it throws `not supported by minebot-sdk/testing: bot.attack` (an `UnsupportedApiError`) instead of returning `undefined`. That covers combat, sleeping, containers, raycasts, using items, and the raw client. A passing test shows the routine's logic holds; a call on a live body shows how it behaves there.

## Long-running bodies

A body can run for days or weeks. The agent's context can be reset, the agent harness can change, and the body can restart. These features help an agent continue where it stopped.

| Feature | What it does |
| - | - |
| Notes | A notepad for the agent: up to 200 notes of up to 8000 characters. Keys use lowercase letters, digits, and `. _ / -`. |
| Milestones | An ordered set, in the same format as a benchmark task's `milestones.json`. A body started with `--no-milestones` has none: the agent cannot read, set, or grade them, and `status`, the CLI, the MCP tools, and the wiki do not mention them. |
| Status | Deaths and reconnects since the body started, and progress toward the milestones. |
| Brief observation | The observation as one line, to keep the agent's context small. |
| `explorer.surface` | Digs a staircase to open sky when the player is trapped underground. It tunnels sideways when a stair step is impossible, swims up through water, and avoids lava. Under water it checks the air supply first: it does not start a dig that the air cannot cover, and swims to air instead. |
| `explorer.remember`, `explorer.places` | Typed place memory. `remember({ name, kind, tags, note, contents })` saves a chest, bed, farm, ore, base, portal, or other place with a note and, for a chest, its contents. `places({ kind, near, radius, limit })` lists them nearest first. `waypoints` and `travel` use the same places, and a store written before places existed loads as places of kind `other`. |
| Blocking wait | `minebot wait` (also `POST /wait` and the `wait_for` MCP tool) blocks until a matching event arrives: chat or whisper from a player, a system message, `night`, `day`, `hostile_near`, `low_health`, `low_food`, `low_oxygen`, `item_picked_up`, or any other event. Filters: types, sender, a regex over the message. The cheap way to idle. |
| Idle float | While no run or reflex holds the run slot and the player's eyes are in water, the body holds jump, so the player floats up instead of sinking and drowning between your calls. A water block, kelp, seagrass, a bubble column, and a waterlogged block all count. A run that dives keeps its own control: the float lets go of its jump when a run starts and holds nothing while the slot is taken. |
| Death awareness | The `death` event carries the death's `position`, the server's `cause`, and the `dropped` items. `observe` reports `spawnPoint` and `lastDeath`, and the MCP tools report a death since your last call. Two deaths during or just after a reflex's run disable that reflex. See [Reflexes](#reflexes). |

```sh
minebot notes set plan --bot ana "1. wood 2. stone tools 3. shelter"
minebot notes --bot ana
minebot milestones set my-milestones.json --bot ana
minebot status --bot ana
minebot observe --brief --bot ana
```

The body keeps notes, milestones, reflexes, bindings, the stores of `ctx.store`, the built-in call counts, and routines in its state directory: `--state <dir>`, default `.minebot/state/<bot>/`. The state files are JSON, and the body writes each one atomically; routines are `.ts` files with their version history beside them. Start a body with `--milestones <file>` to replace the stored set.

Status reads the server's statistics for the player. The body asks the server for them, so status works on any server, also on servers you do not run. The benchmark verifier grades the same statistics from the server's stats file.

Milestones count what the player obtained, from the statistics. `picked_up` alone would count an item again each time the player picks it up, so a milestone has a `via`:

- `crafted` counts the `crafted` statistic.
- `gathered` (the default) counts the smaller of two numbers: blocks dug minus blocks placed (`mined` minus `used`), and items picked up minus items thrown (`picked_up` minus `dropped`). Tossing an item and collecting it again, collecting the drops after a death, and placing a block and digging it again do not raise the count. `blocks` names the blocks to count when they differ from the items, for example `stone` for `cobblestone`.

If the connection drops, the body reconnects after 5 seconds. Each failed attempt doubles the wait, up to 5 minutes. A session that lasted at least 60 seconds resets the wait; a server that kicks the body right after it joins therefore sees the waits grow instead of a reconnect every 5 seconds. The event log records each scheduled reconnect.

### After an upgrade

An upgrade changes the code that the body and the MCP server run, and a running process keeps the code it started with. Do all three steps:

1. Install the new version, and, in a checkout, run `npm run build` to compile `src/` to `dist/`. An installed package ships compiled JavaScript, so a rebuild is only for a checkout.
2. Restart the body daemon (`minebot body`). Its bot host restarts with it: the player reconnects as the same player, and `globalThis`, the running run, and the reflex statistics are lost. Notes, routines, bindings, stores, and the other state files stay.
3. Restart the agent's MCP session. A running MCP server keeps its old tool descriptions and adds no `[since your last call]` line until it restarts.

## Wiki

The wiki is a set of markdown pages in `wiki/` about game mechanics, step-by-step flows, and quirks of Minecraft 26.1 and Mineflayer. Agents search it before they guess. For example, a search for the error text `Server refused to place crafting_table` finds the page that explains it.

```sh
minebot wiki search --bot ana "iron pickaxe"
minebot wiki read --bot ana quirks/drops-fall-out-of-reach
```

Runs use `ctx.wiki`: `ctx.wiki.search(query)`, `ctx.wiki.read(id)`, `ctx.wiki.list(section)`, and in `write` mode `ctx.wiki.addLesson({ title, tags, body })`. MCP clients use the `wiki_*` tools.

A body without built-ins does not see built-in content: pages that need them are hidden, and the built-in shortcuts in other pages are cut from the page and from search results. The same holds for milestones, routines, and reflexes. Pages teach the Mineflayer way first. See [wiki/README.md](wiki/README.md).

Each page shows a status:

- `verified`: someone confirmed the page on the pinned Minecraft version.
- `stale`: someone confirmed the page on another version.
- `unverified`: general knowledge that nobody has checked in game.
- `lesson`: an agent wrote it, and nobody has reviewed it.
- `stale-lesson`: an agent wrote it, and a module that it names changed since. The page then carries a `[stale: <module> changed since this lesson was written; check it against builtins docs <module> before relying on it]` mark for each changed module, joined on one line with spaces above the body.

The body's `--wiki` option controls access:

- `off`: the wiki is unavailable.
- `read` (the default): the agent can search and read.
- `write`: the agent can also add lessons.

Lessons go to `--lessons <dir>` (default `.minebot/lessons/`). Bodies that share the directory share their lessons: a body reads lessons that others add while it runs, and a lesson never overwrites another one (a taken name gets a number). The wiki mentions lessons to an agent only when the body is in `write` mode or lessons exist.

A lesson records the SDK version it was written against, and the identity of each built-in module or shipped package that its title or tags name: a tag that is the module's name, or the name as a whole word in the title. When a module changed since, the body marks the lesson `stale-lesson` and puts one `[stale: ...]` mark per changed module above the body, on one line with the marks separated by spaces, so the reader checks those modules' reference before trusting the lesson. A lesson without a record is never marked.

Some pages name a check program in `wiki/checks/`. Run the checks against a live body after you change the Minecraft version or upgrade Mineflayer:

```sh
npm run wiki:check -- --bot ana
```

The pages in `wiki/reference/` (recipes, which tool each block needs, drops, foods, mobs, enchantments) are generated, not written. Run `npm run wiki:reference` after you change `MC_VERSION` or upgrade `minecraft-data`. It reads `minecraft-data` and the vanilla server's data generator, so it needs Java and the server jar that `npm run dev-server` downloads.

See [wiki/README.md](wiki/README.md) for the page format and the rules for adding pages.

## CLI

| Command | What it does |
| - | - |
| `body` | Starts a body and connects it to a server. Options: `--username`, `--auth <offline\|microsoft>`, `--host`, `--port`, `--api-host`, `--api-port`, `--history <file>`, `--builtins <a,b\|none>`, `--wiki <off\|read\|write>`, `--wiki-dir <dir>`, `--lessons <dir>`, `--state <dir>`, `--milestones <file>`, `--no-milestones`, `--no-reflexes`, `--routines <dir>`, `--no-routines`. |
| `list` | Lists the running bodies and their connection state. |
| `init [dir]` | Scaffolds an authoring workspace; see [Authoring workspace](#authoring-workspace). Needs no body. |
| `observe` | Prints the observation as JSON. `--brief` prints one line. |
| `status` | Prints deaths, reconnects, and progress toward the body's milestones. |
| `milestones` | Prints the milestones. `milestones set <file>` replaces them; `milestones clear` removes them. Not on a body with `--no-milestones`. |
| `notes` | Lists notes. `notes get <key>`, `notes set <key> [text]` (stdin when the text is omitted), `notes rm <key>`. |
| `run [file]` | Runs a module from a file, or from stdin. `--args <json>` passes the arguments of its default function. Exits with status 2 if the run does not end `ok`. |
| `stop` | Aborts the running run. |
| `events` | Prints buffered events. Use `--since <seq>` to get only newer events. |
| `runs` | `runs [seq]` prints a finished run's record: its seq and, for a call, its name, then status, logs, and error or result. `seq` is the `run` field of the run's `program_finished` event. Without it, the command prints the most recent finished run. |
| `wait` | Blocks until a matching event arrives, then prints it as JSON, or `timed out`. Options: `--types a,b`, `--from <name>`, `--match <regex>`, `--since <seq>`, `--timeout <ms>`. |
| `chat <message>` | Sends a chat message. |
| `routines` | Lists the saved routines and what is bound to them. `routines save <file...>` saves each `.ts` or `.js` file under its file name, in the order given (list the modules that a routine imports first). `routines source <name>`, `routines versions <name>`, and `routines revert <name> <version>`. Only on a body that offers routines. |
| `bind` | `bind action <name> <routine>` names a routine for `call`. `bind reflex <name> <routine> --on a,b` runs a routine when an event arrives (options `--from`, `--match`, `--when`, `--cooldown`, `--timeout`, `--priority`, `--preempt`); it needs a body with reflexes. Only on a body that offers routines. |
| `unbind <name>` | Removes a binding. The routine stays saved. Also removes a stored entry that the body skipped at start (see [Migrating](#migrating-from-kits-triggers-and-programs)). Only on a body that offers routines. |
| `call <name>` | Calls the action bound to the name, or a built-in routine named `<module>.<routine>`. `--args <json>` passes the arguments and `--timeout <ms>` limits the run. Exits with status 2 if the routine does not return normally. Only on a body that offers routines or built-ins. |
| `builtins` | Lists the built-in modules and how often their routines worked. `builtins docs [module...]` prints the reference. `builtins search <query>` finds routines by what they do (`--limit <n>`, default 5). `builtins source <module>` prints a module's source. Only on a body that offers built-ins. |
| `wiki` | `wiki search <query>`, `wiki read <page>`, `wiki list [section]`, and in `write` mode `wiki lesson --title <t> [--tags a,b]` with the body text on stdin. Only on a body with the wiki. |
| `mcp` | Serves the body as MCP tools over stdio: the core tools by default, every tool with `--tools full`. See [Control a body from an agent](#control-a-body-from-an-agent). |
| `api` | Prints the run reference for the body: only the features it offers. |

All commands take `--bot <name>`. The default is `$MINEBOT_BOT`, or `bot` if that variable is not set.

`minebot --help` and the answer to an unknown command show only the commands that the body offers. A command for a feature that the body lacks answers `unknown command`. When no body can be reached, the help shows everything on an install that can start bodies, and only the base commands on a client-only install (the benchmark's `main` image has no `body` command).

To reach a body in another container, set `MINEBOT_URL` and `MINEBOT_TOKEN`. Clients then ignore `--bot`. For `body`, `MINEBOT_TOKEN` sets the API token. A body refuses to serve on a non-loopback `--api-host` without a token.

`--history <file>` appends one JSON line per run when the run ends: the code, status, logs, result, and duration. A run that got `--args` carries `args`. A routine call or reflex firing has an empty `code` and carries `call`, or `trigger`, `routine`, and `event`, instead. A reflex's `when` expression has a line of status `registered` when the reflex is bound. A run that never produced a result has no line.

`--auth` defaults to `offline`, which joins servers in offline mode as `--username`. An online-mode server kicks such a player with `multiplayer.disconnect.unverified_username`; use `--auth microsoft` for it. On the first start, the body prints a Microsoft device code to its terminal (`[minebot] Microsoft sign-in: open <url> and enter code <code>`). Sign in with an account that owns Minecraft: Java Edition. The body caches the tokens in `<state>/auth`, so later starts and reconnects sign in without a code. The in-game name is the account's profile name; `--username` only keys the cache.

## How it works

Each body serves its API on `127.0.0.1` with a random bearer token. On start, the body writes its URL and token to `.minebot/<name>.json` with mode 0600. The URL names the address the body listens on (IPv6 addresses in brackets), or loopback when the body listens on a wildcard address. Clients find a body by its name through this file. On SIGINT or SIGTERM, the body shuts down its bot host, which disconnects the player, and deletes the file.

A body is two processes. The supervisor (`src/body/`) serves the API, keeps the event log, writes the run history when `--history` is set, and writes the endpoint file. It answers health, events, wait, and stop itself, and forwards every other request to the bot host (`src/host/`), a child process that it forks. The bot host holds the Minecraft connection, runs the modules, the calls, and the reflexes, and keeps the notes, the routine library, the built-in routines, and the wiki. The two processes talk over the channel that the fork opens; `src/protocol/host.ts` defines its messages.

If the bot host crashes, or the supervisor kills it, the supervisor forks a replacement that reconnects as the same player. The first restart waits 1 second. Each restart in quick succession doubles the wait, up to 60 seconds, and a host that stays up for 60 seconds starts the schedule over. A request that arrives during a restart waits for the new host; if the new host fails to start, the supervisor retries on the same schedule and requests get HTTP 503 until a host is ready.

A restart loses what the old host held in memory, such as `globalThis`, the run that ran, the reflex statistics (fired counts and last status), and the count of runs without change. The supervisor ends that run with an `error` that says the bot host was restarted, and adds a `disconnected` event. Notes, milestones, the stores of `ctx.store`, built-in call counts, reflexes, bindings, and routines are on disk and stay. The replacement counts the restart as a reconnect and continues the death count and each reflex's count of failures.

If the server disconnects or kicks the body, the body records the event and reconnects, with the waits described in [Long-running bodies](#long-running-bodies). Mineflayer respawns the player after a death.

The bot host waits 100 ms after each inventory click. Mineflayer 4.39 sends clicks without waiting for the server. On 26.1, the server's resync packets then arrive between clicks and corrupt Mineflayer's model of the inventory. Without the wait, crafting loses or duplicates items. See `CLICK_PACE_MS` in `src/host/connection.ts`.

## Security

A run, a routine, and a reflex are modules in the bot host process, with the whole Node API: `process`, `fs`, and network access. There is no sandbox. The bearer token is the only barrier, and anyone who has the token can run code as your user. Keep the API on loopback, and keep `.minebot/` private.

The body does not try to prevent what a module does, and it does not scan a module's source. The history records the source of each run; nothing flags or blocks a run. Anything that relies on `--no-milestones` for more than fair play needs a real boundary, such as a separate container for the agent, as in the benchmark.

The history line of a call has an empty `code`: the source of a saved routine is in the library, not in the history.

## Migrating from kits, triggers and programs

Earlier versions had kits, agent kits, code triggers, and programs. This version has built-in routines, library routines, reflexes, and module runs. The code that implements them was deleted, with no alias. This section lists what to change.

### Flags and commands

A removed flag stops `minebot body` with `Unknown option`. A removed command answers `unknown command`, and a removed route answers 404.

| Removed | Replacement |
| - | - |
| `--kits <a,b>` | `--builtins <a,b\|none>`. It offers the named built-in modules and the modules they use. |
| `--lock-kits` | None. A body has no active set: every offered built-in routine is callable. |
| `--agent-kits <dir>`, `--no-agent-kits` | `--routines <dir>`, `--no-routines`. The routine library replaces agent kits. The body does not convert an agent kit. |
| `--no-triggers` | `--no-reflexes`. |
| `minebot kits`, `kits docs`, `kits search`, `kits source` | `minebot builtins`, `builtins docs`, `builtins search`, `builtins source`. |
| `minebot kits use`, `kits save`, `kits rm`, `kits try`, `kits versions`, `kits revert` | `use` has no replacement. `minebot routines save`, `routines versions`, and `routines revert` manage saved routines. A routine is tried by calling it: `minebot call`. No command deletes a routine. |
| `minebot triggers add`, `rm`, `enable`, `disable` | `minebot bind reflex <name> <routine> --on <types>` and `minebot unbind <name>`. A bind enables a reflex. |
| `minebot types` | None. Type-check with `npx tsc` in a workspace. `minebot builtins docs` prints the call shapes. |
| MCP `kit_docs`, `list_kits`, `use_kits`, `kit_search`, `kit_source`, `kit_save`, `kit_remove`, `kit_try`, `kit_versions`, `kit_revert` | `builtin_docs`, `list_builtins`, `builtin_search`, `builtin_source`, and the routine tools. `use_kits`, `kit_try`, and `kit_remove` have no replacement. |
| MCP `trigger_add`, `trigger_list`, `trigger_remove`, `trigger_set_enabled` | `bind_routine` with `kind: "reflex"`, `list_routines`, `unbind_routine`. |
| HTTP `/kits*`, `/triggers*` | `/builtins*`, `/bind`, `/unbind`, and `/bindings`. |
| Events `trigger_fired`, `trigger_finished`, `trigger_disabled` | `reflex_fired`, `reflex_finished`, `reflex_disabled`. |

### Custom wiki pages

A page that lists `requires: [kits]`, `requires: [agentKits]`, or `requires: [triggers]` stops the body at start. The body exits with status 1 and prints the page id and the rule:

```
[minebot] wiki page <id>: ✖ Invalid option: expected one of "builtins"|"milestones"|"reflexes"|"routines"
  → at requires[0]
```

Rename `kits` to `builtins` and `triggers` to `reflexes`. Remove `agentKits`: no feature replaces it. A cut block that uses a marker with a removed name, such as `<!-- kits -->`, is not cut: the text and the markers stay in the page for every body. Rename the marker too.

### Agent kits on disk

The body no longer reads, writes, or deletes `<state>/agent-kits/`. When that directory holds `.ts` files, the body prints one line to stderr at start:

```
[minebot] <state>/agent-kits holds 1 agent kit file: agent kits are no longer loaded
```

The files stay where they are. Rewrite each kit as a routine: `defineRoutine` replaces `defineKit` and `action`, a call of `ctx.kits.<kit>.<action>(args)` becomes an import of `minebot-sdk/routines/<module>` and a call of `<module>.<routine>(ctx, args)`, and `ctx.store` becomes `ctx.store("<name>")`.

### Stored code triggers

A body skips every code trigger that an earlier version stored in the state directory's reflex file (`triggers.json`). The body does not run it and does not delete it. At each start the body adds a `reflex_error` event for it. The entry keeps its name and counts toward the limit of 50 reflexes until you remove it.

- If the name fits the rule `unbind` accepts (1-48 lowercase letters, digits, `.`, `_`, and `-`, starting with a letter or digit), run `minebot unbind <name>`. Then bind a routine as a reflex under a name the bind rule accepts (1-48 lowercase letters, digits, `_`, and `-`, starting with a letter). That can be the old name only when it has no `.` and starts with a letter.
- If the name breaks that rule (an uppercase letter or a space, say), `unbind` refuses it. Stop the body, delete the key from `triggers.json` in the state directory, and start the body again.
- An action in `bindings.json` whose name a reflex or a skipped entry also holds is skipped too, and the body reports a `binding_error` event that tells you to unbind the other entry and restart the body. After the unbind, the action is callable once the body has restarted.

### Programs become module runs

A run is a module, not the body of an async function. These changes follow:

- `echo 'return bot.entity.position' | minebot run` becomes `echo 'export default (ctx) => ctx.bot.entity.position' | minebot run`. A `return` outside a function is a syntax error.
- The globals `bot`, `log`, `sleep`, `signal`, `on`, `notes`, `status`, and `wiki` are members of `ctx`, the first argument of the default function. `minebot run file.ts --args <json>` passes the second argument.
- `goals`, `Movements`, and `Vec3` are imports: `import { goals, Movements, Vec3 } from "minebot-sdk/routine"`.
- `kit.<module>.<routine>(args)` becomes `<module>.<routine>(ctx, args)` after `import * as <module> from "minebot-sdk/routines/<module>"`. From outside a run, use `minebot call <module>.<routine>`.
- The globals `kit`, `kits`, and `triggers` have no replacement.

### createKitHarness becomes createHarness

`createKitHarness` is now `createHarness`, from the same `minebot-sdk/testing` path. The options `kits`, `builtins`, and `active` are gone. `h.call("kit.action", args)` and `h.kit` are gone. Run a routine with `h.run(routine, args)`, and call a built-in as an import. `h.calls` records `{ kit, action, args }` for the routine values named `module.routine`: the built-ins, and a routine of yours that declares such a name.

### An old workspace

`minebot init` writes only the files that do not exist, and never changes a file that does. In an old workspace it keeps your `package.json`, `tsconfig.json`, and `test/hello.test.ts`. The old `package.json` and `tsconfig.json` lack the routine compiler options and `rootDirs`. `init` adds only the missing files, such as `routines/hello.ts` and `runs/say-hello.ts`, beside your `kits/` and `programs/`. Run `minebot init` in a new directory, then move your files into it.

### Install while the package is unpublished

See [Install](#install): a tarball from `npm pack`, a path, or `npm link`.

## Development

```sh
npm run typecheck
npm test
```

The tests cover the run loader, the routine contract, the built-in routines, reflexes, the wiki, the capability table, the package boundaries, what each kind of body shows an agent, and the benchmark grading. They do not need a Minecraft server.

A checkout runs from source. The `minebot-sdk/...` entry points in `package.json` have a `minebot-sdk:source` condition (package-scoped, so a consumer that turns on a generic `source` condition does not load files the package does not ship) that points at `src/`, and the npm scripts, the type checker (`customConditions` in `tsconfig.json`), and the benchmark images pass it (`node --conditions=minebot-sdk:source`). Built-in routines import `minebot-sdk/routine` and each other as `minebot-sdk/routines/<module>`, and the condition makes those imports resolve to `src/routine/public.ts` and `src/routines/<module>.ts` here and to `dist/` in an installed package. Run a script that loads routines as `node --conditions=minebot-sdk:source <file>`.

`npm run build` compiles `src/` to `dist/` (JavaScript and `.d.ts`; `tsconfig.build.json`), and `npm pack` runs it first. The tarball holds `dist/`, the built-in routine sources in `src/routines/`, `wiki/`, the license, and this README. `npm publish --dry-run` lists what a release would ship.

## Benchmark

`bench/` contains Minecraft tasks in the Harbor format, with server-side verifiers and reference solutions. See [bench/README.md](bench/README.md).

## License

MIT. See [LICENSE](LICENSE).
