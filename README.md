# minebot SDK

The minebot SDK gives AI agents a body in Minecraft Java Edition. A body is a long-running supervisor process that serves an API and forks a bot host process. The bot host holds one Mineflayer player connection and runs the programs. Any agent harness, such as Claude Code, Codex, or your own loop, controls the body through MCP, a CLI, or HTTP.

The agent acts by writing JavaScript programs. The body runs each program against the live bot and returns the logs and the result.

The SDK does not decide anything for the agent. The harness owns the turn loop, the context, the prompts, and every decision. The body acts on its own only where the connection requires it (it reconnects after a disconnect, restarts a bot host that crashed, and paces inventory clicks) or where the agent registered a trigger. See [docs/sdk.md](docs/sdk.md) for the layers and the boundary between the SDK and a harness.

## Requirements

- Node.js 24 or later. An installed package runs compiled JavaScript. A checkout runs the TypeScript sources directly, without a build step.
- Java 25 or later, for the development server.
- Minecraft 26.1. minebot pins this version in `src/mc/version.ts` (`MC_VERSION`). It is the newest version in Mineflayer 4.39's `testedVersions`.

## Install

```sh
npm install minebot-sdk
npx minebot --help
```

The package is the authoring library plus the `minebot` command. The body stays a separate process: `minebot body` starts it, and everything else talks to it over HTTP. The package has three entry points:

| Import | What it is |
| - | - |
| `minebot-sdk/kit` | The surface for writing kits, built-in and agent-written: `defineKit`, `action`, `z`, and the helpers and types that kits use. |
| `minebot-sdk/client` | A typed HTTP client for a running body (`BodyClient`), and the request and response types of its API. It contains no CLI or MCP code. |
| `minebot-sdk/testing` | A test harness that runs kits against a fake bot. |

The package ships its kit sources (`minebot kits source <kit>` prints one) and the wiki pages. Each entry point resolves to compiled JavaScript with type declarations.

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

4. In a third terminal, send the body a program:

   ```sh
   echo 'return bot.entity.position' | npm run --silent minebot -- run --bot alpha
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

By default, the MCP server serves the core tools. The agent acts through programs, and programs reach everything else through their globals (`notes`, `status()`, `bot.chat`, `kits`, `wiki`, `triggers`). A short tool list keeps the agent's context small.

| Core tool | What it does |
| - | - |
| `observe` | Returns position, vitals, armor, effects, biome, open sky, inventory, nearby creatures, and program state as one line. `full: true` returns the complete JSON. |
| `run_program` | Runs a program and blocks until it returns, fails, or times out. Its description holds the program reference for this body. |
| `stop_program` | Aborts the running program and halts movement, pathfinding, and digging. |
| `get_events` | Returns chat, damage, deaths, joins, disconnects, and what the player did or noticed (items picked up, blocks broken and placed, low health or food, hostile creatures near) since a cursor. |
| `wait_for` | Blocks until a matching event arrives (chat, whisper, system message, night, day, hostile_near, low_health, low_food, item_picked_up, ...) or the timeout, then returns it. The cheap way to idle. |
| `api_reference` | Returns the globals available to programs on this body. |
| `kit_docs` | Returns the action reference for kits. Only on a body that offers kits. |

`minebot mcp --tools full` also serves every other operation as a tool of its own:

| Tool | What it does |
| - | - |
| `status` | Returns deaths and reconnects since the body started, and progress toward the body's milestones. |
| `notes_list`, `notes_set`, `notes_delete` | Read and write the agent's persistent notes. |
| `send_chat` | Sends a chat message or a command as the player. |
| `list_kits` | Lists the kits, their uses and actions, and which kits are active. |
| `use_kits` | Replaces the active kits. |
| `kit_search` | Ranks the kits and actions by what they do (names, descriptions, action docs). |
| `kit_save` | Saves an agent-written kit from TypeScript source and returns its type check. |
| `kit_remove` | Deletes a saved kit. |
| `kit_source` | Prints a kit's source: the model for writing your own. |
| `kit_try` | Runs one action of kit source once, without saving it, and returns the result or the error. The logs hold the type errors of the source. |
| `kit_versions`, `kit_revert` | Lists the saved versions of an agent kit; saves an earlier version again. |
| `trigger_add`, `trigger_list`, `trigger_remove`, `trigger_set_enabled` | Register, list, delete, and switch off triggers: programs the body runs when an event arrives. |
| `wiki_search`, `wiki_read`, `wiki_list` | Search and read the wiki. |
| `wiki_add_lesson` | Adds a lesson to the wiki, when the body allows writes. |

The MCP server reads the body endpoint on every call. If the body restarts, the MCP server keeps working.

The MCP server asks the body which features it offers: before it connects, and before every tool call. It lists the kit tools only when the body offers kits (`use_kits` only when the set can change, `kit_save`, `kit_remove`, `kit_source`, `kit_try`, `kit_versions`, and `kit_revert` only when agent kits are on), the wiki tools only when the wiki is not `off`, `wiki_add_lesson` only in `write` mode, and the `trigger_*` tools only on a body that has triggers. When the answer changes, tools appear or disappear and the server sends `notifications/tools/list_changed`. The `run_program` and `status` descriptions and `minebot api` describe only the offered features. While the body cannot be reached, the MCP server lists only the ungated tools of its tool set: `observe`, `run_program`, `api_reference`, `stop_program`, `get_events`, and `wait_for`, plus `status`, the `notes_*` tools, and `send_chat` with `--tools full`.

## Programs

A program is the body of an async function. These globals are available:

- `bot`: the Mineflayer bot, with the pathfinder plugin loaded.
- `goals`, `Movements`: from `mineflayer-pathfinder`.
- `Vec3`: the vec3 constructor.
- `log(...)` and `console.log(...)`: append to the program output.
- `sleep(ms)`: waits, and rejects when the program is aborted.
- `signal`: an `AbortSignal` that fires on timeout or stop.
- `on(event, handler)`: subscribes to a bot event. When the program ends or is aborted, the body removes the handlers that exist at that moment.
- `setTimeout` and `setInterval`: when the program ends or is aborted, the body clears the timers that exist at that moment.
- `globalThis`: keeps its values between programs. A restart of the body clears them, and so does a restart of the bot host, the process that runs programs. The bot host restarts after a crash, and when the body kills it for a program that does not stop.
- `notes`: the agent's persistent notes. See [Long-running bodies](#long-running-bodies).
- `status()`: resolves to deaths and reconnects, and to progress toward the body's milestones when the body has them.
- `triggers`: register, list, and remove triggers. Only when the body has triggers. See [Triggers](#triggers).
- `kit`, `kits`, `wiki`: only when the body offers kits (`kit` and `kits`), agent kits (`kits.save`, `kits.remove`, `kits.source`, `kits.try`, `kits.versions`, `kits.revert`), or the wiki (`wiki`). A program on a body without them finds no such global; calling one fails with `... is not defined`.

Run `npm run minebot -- api` to print the full reference. The MCP tool description contains the same text.

This program walks to the nearest log and breaks it:

```js
const ids = Object.values(bot.registry.blocksByName)
  .filter((b) => b.name.endsWith("_log"))
  .map((b) => b.id);
const block = bot.findBlock({ matching: ids, maxDistance: 64 });
if (!block) return "no log nearby";
await bot.pathfinder.goto(new goals.GoalLookAtBlock(block.position, bot.world));
await bot.dig(bot.blockAt(block.position));
return block.name;
```

The body runs one program at a time. A second request gets HTTP 409. The default timeout is 60 seconds; the maximum is 30 minutes. If a program times out or stops, the body halts pathfinding, digging, item use, and movement keys, clears the timers that exist at that moment, and removes the `on` handlers that exist at that moment. The program then gets a grace period to end. If it does not end, the body can kill the bot host and restart it: the restart reconnects as the same player, and the run answers with its `status` (`stopped` or `timeout`) and an `error` that says the program did not stop. The kill time is not fixed: a program that blocks the host with synchronous code after it catches the abort can run on without being killed. The restart can start late: it waits 1 second, and the wait doubles after each restart in quick succession, up to 60 seconds. See [How it works](#how-it-works). Long loops must check `signal.aborted` so the program ends in time.

The body does not add notices to run results. Facts stay in the observation: it keeps the open-sky view and `programsWithoutChange`, and `minebot observe --brief` adds `no change for N programs` when 3 or more programs in a row changed neither position nor inventory.

The observation reports, besides position, vitals, inventory, and nearby creatures: `armor` (head, chest, legs, feet) and `offhand`, `effects` (name, `amplifier` where 0 is level I, seconds `remaining`), the `biome`, the block the player is `standingOn`, the block in the line of sight within 5 blocks (`lookingAt`), and the `light` at the feet. `light.sky` is absent when the chunk has no sky light data. The brief line adds the biome, and lists armor, the offhand item, and effects only while there are some.

Besides chat, damage, and deaths, the event log records what the player does and notices. Events about the player's own actions come from the actions themselves, so other players' actions and world updates do not produce them.

| Event | Data | When |
| - | - | - |
| `item_picked_up` | `item`, `count` | The player picks up a dropped item. |
| `block_broken` | `block`, `position` | A dig of the player finishes. |
| `block_placed` | `block`, `position` | A placement of the player is confirmed by the server. |
| `item_crafted` | `item`, `count` | A craft of the player finishes. |
| `hostile_near` | `name`, `id`, `distance` | A hostile creature comes within 16 blocks. Once per creature: it fires again only after the creature was 32 blocks away or gone. Enderman, zombified piglin, and strider do not count. |
| `low_health` | `health` | Health falls below 8. It fires again after health was back at 8 or more. |
| `low_food` | `food` | Food falls below 6. It fires again after food was back at 6 or more. |

## Kits

A kit is a composable library of typed actions. Programs call them namespaced, with one object argument:

```js
await kit.move.to({ position: [x, y, z], range: 1 });
await kit.gatherer.gather({ blocks: "*_log", count: 4 });
```

Every action validates its arguments on every call, nested calls included. A bad call fails with the action's schema. Kits come in two layers:

| Layer | Kit | Actions |
| - | - | - |
| Primitives | `move` | `to`, `stop` |
| Primitives | `sense` | `find`, `look` |
| Primitives | `dig` | `dig` |
| Primitives | `place` | `place` |
| Primitives | `inventory` | `list`, `count`, `equip`, `toss` |
| Primitives | `craft` | `craft`, `table` |
| Primitives | `items` | `recipes`, `drops` |
| Primitives | `furnace` | `smelt`, `take` |
| Primitives | `container` | `list`, `deposit`, `withdraw` |
| Primitives | `survival` | `eat`, `sleep`, `wake`, `armor` |
| Primitives | `combat` | `attack`, `fight`, `retreat` |
| Primitives | `farm` | `till`, `plant`, `harvest`, `breed` |
| Primitives | `bucket` | `fill`, `empty` |
| Routines | `gatherer` (uses move, sense, dig, inventory, items) | `gather`, `collectDrops` |
| Routines | `crafter` (uses move, sense, place, inventory, craft, items, furnace) | `make` |
| Routines | `builder` (uses move, sense, dig, place, inventory) | `materials`, `build`, `check` |
| Routines | `explorer` (uses move, sense, dig) | `scan`, `explore`, `remember`, `places`, `waypoints`, `travel`, `surface` |
| Routines | `social` (uses move, sense, inventory) | `say`, `waitForChat`, `players`, `follow`, `give` |

Primitives do one thing. Routine kits are built from public primitives through `ctx.kits`, so anything a routine kit does, an agent's own kit can do too. See [docs/sdk.md](docs/sdk.md) for the full model.

The operator decides which kits a body **offers**; the agent picks the **active** set among them:

- At start: `minebot body --bot ana --kits gatherer,crafter`. Without `--kits`, the body offers every built-in kit. Used kits are offered too.
- From a program: `kits.use("builder", "explorer")`. The next `kit.<kit>.<action>` call uses the new set. `kits.active` and `kits.available()` list both sets.
- From the CLI: `minebot kits use builder explorer`. Run `minebot kits` to list kits, and `minebot kits docs` to print the reference, which is generated from the action schemas: argument names, types, and defaults.
- From MCP: the `use_kits` tool (with `--tools full`), or `kits.use` in `run_program`.

`--lock-kits` fixes the active set. A locked body hides the kits that are not active: they do not appear in `minebot kits`, `kits docs`, or the MCP tools, and a program finds no `kits.use`. Every benchmark task starts its body with `--lock-kits`. The lock stops an agent that uses the body as intended, but programs run in a `node:vm` context that is not a security boundary, so it is advisory. See [Security](#security) and [bench/README.md](bench/README.md).

Each kit keeps its own JSON store in the body's state directory. The store survives programs, kit swaps, and body restarts, and no kit reads another's. Explorer places, for example, persist across restarts.

The framework counts every call of every action, nested calls included: how often it returned and how often it failed, and the message of the last failure. A call that fails because the program was stopped, timed out, or was preempted does not count as a failure. The counts are per body, live in the state directory (`kit-stats.json`), and survive restarts. `kits.available()` returns them as `stats` on each kit, and `minebot kits` prints them under the kit (`calls: gather: 12 ok / 3 failed`), so an agent can prefer the actions that work. A new source for an agent kit, or removing it, resets that kit's counts. To find an action by what it does, search: `kits.search("collect logs")` in a program, `minebot kits search <query>` in the CLI, or the `kit_search` tool. The search ranks kits and actions by name, kit description, and action doc, and marks the active kits and the actions' counts.

Kit search and wiki search match words in the same way. A query word matches a word exactly, by prefix (`craf` finds `crafting`, `smelting` finds `smelt`), or with typos: one when both words have 4 or more letters, two when both have 7 or more (`furnce` finds `furnace`). A prefix or typo match of a query word counts only where the exact word is missing, and it counts less than an exact match. Every result that contains a query word exactly ranks above every result that contains none, so a one-word query ranks its exact results as it would without fuzzy matching.

## Agent kits

An agent can save kits of its own, in the same shape as the built-ins: one import, `import { defineKit, action, z } from "minebot-sdk/kit"` (the only import a kit may have; it also exports the helpers the built-ins use), then one exported kit, `export default defineKit({ name, description, uses }, { actionName: action({ doc, args, returns, run }) })` or, as the built-ins are written, `export const <name> = defineKit(...)` (other `export const` and `export function` declarations are ignored, so the output of `minebot kits source <kit>` can be saved under a new name as it is). `returns` is a zod schema of what the action returns, checked on every call and typed for callers; `uses` types `ctx.kits` inside the actions.

```js
await kits.save(source);       // in a program
await kits.source("move");     // a built-in kit's source, the model to start from
await kits.remove("woodcutter");
await kits.try(source, { action: "chop", args: { times: 2 } });  // run one action, save nothing
await kits.versions("woodcutter");
await kits.revert("woodcutter", 1);
```

The CLI serves the same over `minebot kits save [file]` (stdin when omitted), `minebot kits rm <kit>`, `minebot kits source <kit>`, `minebot kits try [file] --action <name> [--args <json>]`, `minebot kits versions <kit>`, and `minebot kits revert <kit> <version>`; MCP serves `kit_save`, `kit_remove`, `kit_source`, `kit_try`, `kit_versions`, and `kit_revert`; HTTP serves `POST /kits/save`, `POST /kits/remove`, `GET /kits/source`, `POST /kits/try`, `GET /kits/versions`, and `POST /kits/revert`.

Saving validates before it writes, and nothing is written when the source is rejected: it must compile, pass the escape audit, use only kits this body offers, and not take a built-in kit's name. A saved kit is offered and active immediately. `kits.try` runs the same validation, then calls one action once against the live bot, as part of the current program, and returns the action's result or throws its error. It writes nothing and registers nothing: the `ctx.store` of the tried kit and of every kit it calls is a throwaway, and no call is counted in the statistics. Over MCP, CLI, and HTTP, a try is a program run, so it is recorded in the history like one.

Saving and trying also type-check the source, as `tsc` checks a kit in a workspace: against `minebot-sdk/kit`, with `ctx.kits` typed from `uses`, and with the body's agent kits typed from their schemas. Type errors never stop a save or a try. A save returns `typeCheck`: `{ status: "passed" }`, `{ status: "failed", errors }` with one `<kit>.ts(line,col): error TS...` entry per error, or `{ status: "skipped", reason }`. A try writes the type errors to the program log. The check needs the `typescript` package (5.0 or later), an optional peer dependency of `minebot-sdk`. Without it, the check is skipped and says why.

Saving over an existing kit keeps the old source. Each different source is a numbered version, stored with the time and the body that saved it in `.history/<kit>/<n>.ts` and `<n>.json` inside the agent-kit directory. `kits.versions(name)` lists them, and `kits.revert(name, version)` saves an earlier one again as a new version, validated like any save, so the history only grows. Removing a kit keeps its history. Agent kits are a capability of their own: on by default, off with `--no-agent-kits`, and `--agent-kits <dir>` picks the directory (default: the state directory's `agent-kits/`). Several bodies can share the directory; a kit one body saves works on the others without a restart, and they share the history, each version noting which body saved it. A bad file on disk never stops a body: it is skipped and reported as a `kit_error` event.

## Authoring workspace

`minebot init [dir]` scaffolds a TypeScript workspace for writing kits and programs. The body stays a separate process; the workspace holds source files and a type checker.

```sh
npx -p minebot-sdk minebot init ws && cd ws
npm install                                    # minebot-sdk and typescript
npx minebot body --bot dev --agent-kits ./kits  # in another terminal: the body loads kits/*.ts
npx minebot types --bot dev --out minebot-env.d.ts
npx tsc                                        # checks kits/ and programs/
npx minebot run --bot dev programs/hello.ts
```

`init` writes `package.json` (dependency `minebot-sdk`, dev dependency `typescript`), a strict `tsconfig.json`, `kits/hello.ts` (an example kit that calls the `move` kit), `programs/hello.ts` (a program that calls it), `test/hello.test.ts` (a kit test on the harness, run with `npm test`), `.gitignore`, and a README. It never overwrites a file that exists.

A kit imports its helpers from `"minebot-sdk/kit"`. The body loads every `.ts` file in `kits/` and reloads a file when you save it. Programs are the body of an async function, so they may use top-level `await` but not a top-level `return`; `minebot run` strips the types of a `.ts` file before it sends the program.

`minebot types [--out <file>]` writes one declaration file for the body it asks. It declares the kits that the package does not ship — the operator's and the agents' — in `KitRegistry`, with each action's arguments and result typed from its zod schemas, and it declares the program globals (`bot`, `kit`, `kits`, `notes`, `wiki`, `triggers`, `status`, ...) for what that body offers. A body without a feature gets no declaration for it. The output depends only on the body's kits, so regenerate it after they change, and commit it if you like. The kit schemas are also served as `GET /kits/schemas`; a body without kits gets the globals only. Type checking of the workspace is plain `tsc`. The body type-checks a kit only when it is saved or tried through the API; it does not type-check the kit files that it loads from `kits/`.

## Testing kits

`minebot-sdk/testing` runs a kit's actions in a test, with no Minecraft server. `createKitHarness` builds the real kit framework (`KitHost`: argument and result validation, `uses`, per-kit in-memory stores, the active set) around a fake Mineflayer bot on the real registry for the version the body targets. `init` scaffolds a workspace with an example test (`npm test`).

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createKitHarness } from "minebot-sdk/testing";
import woodcutter from "../kits/woodcutter.ts"; // the kit from the wiki page minebot/writing-kits

test("chop digs two logs and keeps the drops", async () => {
  const h = createKitHarness({
    kits: [woodcutter],                                              // joins the built-in kits; a same-named kit replaces one
    blocks: [{ name: "oak_log", from: [6, 64, 0], to: [6, 66, 0] }],  // a trunk, three blocks tall
    inventory: { stone_axe: 1 },
  });
  const result = await h.call("woodcutter.chop", { times: 2 });       // "kit.action": validated like a body call
  assert.deepEqual(result, { chopped: 2, standingAt: { x: 5, y: 64, z: 0 } });
  assert.equal(h.count("oak_log"), 2);
  assert.equal(h.blockAt([6, 64, 0]).name, "air");
  assert.ok(h.calls.some((c) => c.kit === "dig" && c.action === "dig")); // every action call is recorded, nested ones too
});
```

Options (all optional): `kits`, `builtins` (offer the built-in kits, default true), `active`, `inventory` (`{ item: count }`), `equipment` (`{ head: "iron_helmet" }`, from the inventory), `blocks` (a block at `at`, or a box `from`/`to`, with block `properties`), `ground` (a one-block-thick layer, default stone at y 63; `false` for a world of air), `entities` (`{ name: "cow", at }`, a player with `username`, a dropped item with `name: "item", item`), `position` (default the top of the ground at the origin), `time` (ticks since dawn), `health`, `food`, and `username`. The harness gives back `call(path, args)`, `kit` (the built-in kits, typed, as a program sees them), `calls`, `logs`, `chat`, `inventory`, `count`, `give`, `blockAt`, `setBlock`, `position`, `teleport`, `spawn`, `entities`, `advance(ticks)`, `abort(reason)`, `furnaceAt`, the `bot`, and the `host`.

What the fake bot does:

- **World.** `blockAt`, `findBlock`, and `findBlocks` over the ground layer and the blocks you set (real prismarine blocks, so harvest tools and dig times follow the registry). `findBlocks` follows Mineflayer: the point is floored, `maxDistance` and `count` default when 0, a predicate is first called with a position-less block, and a function `useExtraInfo` filters. Air is the rest of the world and is not enumerable. Digging removes the block, advances the clock by the dig time, and drops the items: the registry's drops, plus what it leaves out (the crop item of ripe wheat and beetroots, a bed's head). Placing sets a block, spends the held item, and refuses a cell the bot or another creature stands in. Digging, placing, crafting at a table, and opening furnaces are limited to 4.5 blocks from the eyes: out of reach, the real server ignores the click and Mineflayer waits forever, so the harness throws instead.
- **Inventory.** Mineflayer's slot layout with `items()`, `equip`, `toss` (a null count tosses one), `heldItem`, `quickBarSlot`, `emptySlotCount()`, and `getEquipmentDestSlot`; crafting with the real recipes (`recipesFor`, `recipesAll`, `craft`). Item drops are entities: walk over them to pick them up.
- **Pathfinding.** `goto` and `setGoal` teleport to the nearest standable spot that satisfies the goal (`goals.GoalNear`, `GoalBlock`, `GoalInvert`, ...), or fail with `No path to the goal!`: within 12 blocks of the goal, or for `GoalInvert` within 64 blocks of the bot. Like the plugin, `setGoal` returns at once and emits `goal_reached` on a later turn, then clears a goal that is not dynamic.
- **Furnaces.** Furnace blocks open as windows, and their contents cook on the harness clock with the real burn and smelt times; an open window emits `update` and reports `fuel` as a fraction of the fuel item burning. `ctx.sleep(ms)` passes `ms / 50` ticks and then yields to the event loop, so a kit that polls with `ctx.sleep` lets `within` timeouts and timed `abort()` calls fire. `advance(ticks)` passes more.
- **Entities, time, health, food, and chat.** Entities with registry categories (`isHostile` works), the day clock (`time.day` counts days), `bot.chat` into `chat`, `bot.consume` for food. Data members the harness does not model read as Mineflayer's idle value (`currentWindow` and `targetDigBlock` are null, `usingHeldItem` is false).

Scope is decision logic, not physics: nothing walks, collides, or takes time except where listed (dropped items do fall to the ground). The harness clock is its own: it does not fake `Date.now()`, so a loop bounded by wall-clock time (a deadline built from `Date.now()`) still ends by that deadline in real time. Everything else in Mineflayer is unsupported, and calling it throws `not supported by minebot-sdk/testing: bot.attack` (an `UnsupportedApiError`) instead of returning `undefined`. That covers combat, sleeping, containers, raycasts, using items, and the raw client. A passing test shows the kit's logic holds; `kits.try` on a live body shows how it behaves there.

## Triggers

A program runs when the agent starts it. A trigger is a program that the body starts when an event arrives, so the agent can install reflexes: eat when food is low, flee when hurt, answer a chat. The agent writes every trigger. The body decides nothing that the agent did not register.

```sh
minebot triggers add eat --bot ana --on low_food --cooldown 10000 eat.js
minebot triggers --bot ana            # each trigger, and what it did since the body started
minebot triggers disable eat --bot ana
minebot triggers rm eat --bot ana
```

In a program: `triggers.add({ name, on, run, ... })`, `triggers.list()`, `triggers.enable(name)`, `triggers.disable(name)`, `triggers.remove(name)`. MCP serves `trigger_add`, `trigger_list`, `trigger_remove`, and `trigger_set_enabled`. HTTP serves `GET /triggers`, `POST /triggers`, `POST /triggers/remove`, and `POST /triggers/enabled`.

| Field | Meaning |
| - | - |
| `name` | 1-48 lowercase letters, digits, `.`, `_`, `-`. Saving a trigger with an existing name replaces it. |
| `on` | Event types that fire the trigger: any event in the log, such as `hurt`, `chat`, `night`, `low_food`, `hostile_near`. A trigger cannot listen to `trigger_*` events. |
| `run` | Program source, with the globals of a program plus `event` (`{ seq, type, data }`). It must compile when the trigger is saved. |
| `when` | A JavaScript expression over `event` and `bot`. The trigger fires only when it is truthy. It is cut off after 100 ms. |
| `from`, `match` | Filters for `chat` and `whisper` events, as for `wait`. |
| `cooldownMs` | Least time between two firings. Default 1000. |
| `timeoutMs` | The run is aborted after this long. Default 30000. |
| `preempt`, `priority` | Whether the firing may stop the running program, and the order of waiting firings. |
| `enabled` | Default true. |

The body runs one program at a time, and a trigger run is a program. A firing that arrives while a program runs waits until the program ends. A trigger waits at most once, so repeated events while it waits do not queue repeats. Waiting triggers run highest `priority` first. With `preempt: true`, the firing stops the running program (it ends as `stopped`, like `minebot stop`) and runs when that program has ended; it does not stop a running trigger of equal or higher priority. A `run` request that arrives while a trigger runs gets HTTP 409.

Each firing adds a `trigger_fired { name, event }` event and, when the run ends, `trigger_finished { name, status, durationMs, error?, logs? }`. A trigger run ends with `trigger_finished` and not with `program_finished`. A trigger that fails three times in a row (an error or a timeout) disables itself and adds `trigger_disabled { name, failures, reason }`. A failure never affects the body. An event that arrives while the body is not connected fires nothing.

Triggers persist in the state directory (`triggers.json`), so they survive a restart of the body. A body started with `--no-triggers` has none: the agent cannot register them, and the CLI, the MCP tools, the program reference, and the wiki do not mention them. The benchmark starts its bodies with `--no-triggers`, except in `survive-nights`, where reflexes are the task.

The history (`--history`) records a trigger's code when it is saved (status `registered`), with the escape audit over its program and its `when`, and each firing as a program run with the `trigger` name and the `event` that fired it.

## Long-running bodies

A body can run for days or weeks. The agent's context can be reset, the agent harness can change, and the body can restart. These features help an agent continue where it stopped.

| Feature | What it does |
| - | - |
| Notes | A notepad for the agent: up to 200 notes of up to 8000 characters. Keys use lowercase letters, digits, and `. _ / -`. |
| Milestones | An ordered set, in the same format as a benchmark task's `milestones.json`. A body started with `--no-milestones` has none: the agent cannot read, set, or grade them, and `status`, the CLI, the MCP tools, and the wiki do not mention them. |
| Status | Deaths and reconnects since the body started, and progress toward the milestones. |
| Brief observation | The observation as one line, to keep the agent's context small. |
| `kit.explorer.surface()` | Digs a staircase to open sky when the player is trapped underground. It tunnels sideways when a stair step is impossible, swims up through water, and avoids lava. Under water it checks the air supply first: it does not start a dig that the air cannot cover, and swims to air instead. |
| `kit.explorer.remember()`, `kit.explorer.places()` | Typed place memory. `remember({ name, kind, tags, note, contents })` saves a chest, bed, farm, ore, base, portal, or other place with a note and, for a chest, its contents. `places({ kind, near, radius, limit })` lists them nearest first. `waypoints` and `travel` use the same places, and a store written before places existed loads as places of kind `other`. |
| Blocking wait | `minebot wait` (also `POST /wait` and the `wait_for` MCP tool) blocks until a matching event arrives: chat or whisper from a player, a system message, `night`, `day`, `hostile_near`, `low_health`, `low_food`, `item_picked_up`, or any other event. Filters: types, sender, a regex over the message. The cheap way to idle. |

```sh
minebot notes set plan --bot ana "1. wood 2. stone tools 3. shelter"
minebot notes --bot ana
minebot milestones set my-milestones.json --bot ana
minebot status --bot ana
minebot observe --brief --bot ana
```

The body keeps notes, milestones, triggers, per-kit stores, and agent kits in its state directory: `--state <dir>`, default `.minebot/state/<bot>/`. Each file is JSON, and the body writes it atomically. Start a body with `--milestones <file>` to replace the stored set.

Status reads the server's statistics for the player. The body asks the server for them, so status works on any server, also on servers you do not run. The benchmark verifier grades the same statistics from the server's stats file.

Milestones count what the player obtained, from the statistics. `picked_up` alone would count an item again each time the player picks it up, so a milestone has a `via`:

- `crafted` counts the `crafted` statistic.
- `gathered` (the default) counts the smaller of two numbers: blocks dug minus blocks placed (`mined` minus `used`), and items picked up minus items thrown (`picked_up` minus `dropped`). Tossing an item and collecting it again, collecting the drops after a death, and placing a block and digging it again do not raise the count. `blocks` names the blocks to count when they differ from the items, for example `stone` for `cobblestone`.

If the connection drops, the body reconnects after 5 seconds. Each failed attempt doubles the wait, up to 5 minutes. A session that lasted at least 60 seconds resets the wait; a server that kicks the body right after it joins therefore sees the waits grow instead of a reconnect every 5 seconds. The event log records each scheduled reconnect.

## Wiki

The wiki is a set of markdown pages in `wiki/` about game mechanics, step-by-step flows, and quirks of Minecraft 26.1 and Mineflayer. Agents search it before they guess. For example, a search for the error text `Server refused to place crafting_table` finds the page that explains it.

```sh
minebot wiki search --bot ana "iron pickaxe"
minebot wiki read --bot ana quirks/drops-fall-out-of-reach
```

Programs use the `wiki` global: `wiki.search(query)`, `wiki.read(id)`, `wiki.list(section)`, and in `write` mode `wiki.addLesson({ title, tags, body })`. MCP clients use the `wiki_*` tools.

A body without kits does not see kit content: pages about kits are hidden, and the kit shortcuts in other pages are cut from the page and from search results. The same holds for milestones and for agent kits. Pages teach the Mineflayer way first. See [wiki/README.md](wiki/README.md).

Each page shows a status:

- `verified`: someone confirmed the page on the pinned Minecraft version.
- `stale`: someone confirmed the page on another version.
- `unverified`: general knowledge that nobody has checked in game.
- `lesson`: an agent wrote it, and nobody has reviewed it.

The body's `--wiki` option controls access:

- `off`: the wiki is unavailable.
- `read` (the default): the agent can search and read.
- `write`: the agent can also add lessons.

Lessons go to `--lessons <dir>` (default `.minebot/lessons/`). Bodies that share the directory share their lessons: a body reads lessons that others add while it runs, and a lesson never overwrites another one (a taken name gets a number). The wiki mentions lessons to an agent only when the body is in `write` mode or lessons exist.

Some pages name a check program in `wiki/checks/`. Run the checks against a live body after you change the Minecraft version or upgrade Mineflayer:

```sh
npm run wiki:check -- --bot ana
```

The pages in `wiki/reference/` (recipes, which tool each block needs, drops, foods, mobs, enchantments) are generated, not written. Run `npm run wiki:reference` after you change `MC_VERSION` or upgrade `minecraft-data`. It reads `minecraft-data` and the vanilla server's data generator, so it needs Java and the server jar that `npm run dev-server` downloads.

See [wiki/README.md](wiki/README.md) for the page format and the rules for adding pages.

## CLI

| Command | What it does |
| - | - |
| `body` | Starts a body and connects it to a server. Options: `--username`, `--auth <offline\|microsoft>`, `--host`, `--port`, `--api-host`, `--api-port`, `--history <file>`, `--kits <a,b>`, `--lock-kits`, `--no-agent-kits`, `--agent-kits <dir>`, `--wiki <off\|read\|write>`, `--wiki-dir <dir>`, `--lessons <dir>`, `--state <dir>`, `--milestones <file>`, `--no-milestones`, `--no-triggers`. |
| `list` | Lists the running bodies and their connection state. |
| `init [dir]` | Scaffolds an authoring workspace; see [Authoring workspace](#authoring-workspace). Needs no body. |
| `observe` | Prints the observation as JSON. `--brief` prints one line. |
| `status` | Prints deaths, reconnects, and progress toward the body's milestones. |
| `milestones` | Prints the milestones. `milestones set <file>` replaces them; `milestones clear` removes them. Not on a body with `--no-milestones`. |
| `notes` | Lists notes. `notes get <key>`, `notes set <key> [text]` (stdin when the text is omitted), `notes rm <key>`. |
| `run [file]` | Runs a program from a file, or from stdin. Exits with status 2 if the program does not return normally. |
| `stop` | Aborts the running program. |
| `events` | Prints buffered events. Use `--since <seq>` to get only newer events. |
| `wait` | Blocks until a matching event arrives, then prints it as JSON, or `timed out`. Options: `--types a,b`, `--from <name>`, `--match <regex>`, `--since <seq>`, `--timeout <ms>`. |
| `chat <message>` | Sends a chat message. |
| `types` | Prints TypeScript declarations for the body's program globals and kits; `--out <file>` writes them. See [Authoring workspace](#authoring-workspace). |
| `triggers` | Lists triggers. `triggers add <name> --on a,b [file]` saves one (the program comes from stdin when the file is omitted; options `--from`, `--match`, `--when`, `--cooldown`, `--timeout`, `--priority`, `--preempt`). `triggers rm <name>`, `triggers enable <name>`, and `triggers disable <name>`. Only on a body that has triggers. |
| `kits` | Lists the kits and how often their actions worked. `kits use <kit...>` replaces the active kits (not on a locked body). `kits docs [kit...]` prints the reference. `kits search <query>` finds kits and actions by what they do. `kits save [file]`, `kits rm <kit>`, `kits source <kit>`, `kits try [file] --action <name> [--args <json>]`, `kits versions <kit>`, and `kits revert <kit> <version>` manage agent kits. Only on a body that offers kits. |
| `wiki` | `wiki search <query>`, `wiki read <page>`, `wiki list [section]`, and in `write` mode `wiki lesson --title <t> [--tags a,b]` with the body text on stdin. Only on a body with the wiki. |
| `mcp` | Serves the body as MCP tools over stdio: the core tools by default, every tool with `--tools full`. See [Control a body from an agent](#control-a-body-from-an-agent). |
| `api` | Prints the program reference for the body: only the features it offers. |

All commands take `--bot <name>`. The default is `$MINEBOT_BOT`, or `bot` if that variable is not set.

`minebot --help` and the answer to an unknown command show only the commands that the body offers. A command for a feature that the body lacks answers `unknown command`. When no body can be reached, the help shows everything on an install that can start bodies, and only the base commands on a client-only install (the benchmark's `main` image has no `body` command).

To reach a body in another container, set `MINEBOT_URL` and `MINEBOT_TOKEN`. Clients then ignore `--bot`. For `body`, `MINEBOT_TOKEN` sets the API token. A body refuses to serve on a non-loopback `--api-host` without a token.

`--history <file>` appends one JSON line per program run: the code, status, logs, result, duration, and `escapeAttempts`. See [Security](#security).

`--auth` defaults to `offline`, which joins servers in offline mode as `--username`. An online-mode server kicks such a player with `multiplayer.disconnect.unverified_username`; use `--auth microsoft` for it. On the first start, the body prints a Microsoft device code to its terminal (`[minebot] Microsoft sign-in: open <url> and enter code <code>`). Sign in with an account that owns Minecraft: Java Edition. The body caches the tokens in `<state>/auth`, so later starts and reconnects sign in without a code. The in-game name is the account's profile name; `--username` only keys the cache.

## How it works

Each body serves its API on `127.0.0.1` with a random bearer token. On start, the body writes its URL and token to `.minebot/<name>.json` with mode 0600. The URL names the address the body listens on (IPv6 addresses in brackets), or loopback when the body listens on a wildcard address. Clients find a body by its name through this file. On SIGINT or SIGTERM, the body shuts down its bot host, which disconnects the player, and deletes the file.

A body is two processes. The supervisor (`src/body/`) serves the API, keeps the event log, writes the program history when `--history` is set, and writes the endpoint file. It answers health, events, wait, and stop itself, and forwards every other request to the bot host (`src/host/`), a child process that it forks. The bot host holds the Minecraft connection, runs the programs and the triggers, and keeps the kits, the notes, and the wiki. The two processes talk over the channel that the fork opens; `src/protocol/host.ts` defines its messages.

If the bot host crashes, or the supervisor kills it, the supervisor forks a replacement that reconnects as the same player. The first restart waits 1 second. Each restart in quick succession doubles the wait, up to 60 seconds, and a host that stays up for 60 seconds starts the schedule over. A request that arrives during a restart waits for the new host; if the new host fails to start, the supervisor retries on the same schedule and requests get HTTP 503 until a host is ready.

A restart loses what the old host held in memory, such as `globalThis`, the program that ran, the trigger statistics (fired counts and last status), and the count of programs without change. The supervisor ends that program's run with an `error` that says the bot host was restarted, and adds a `disconnected` event. Notes, milestones, kit stores, agent kits, and triggers are on disk and stay. The replacement counts the restart as a reconnect and continues the death count, the active kits, and each trigger's count of failures.

If the server disconnects or kicks the body, the body records the event and reconnects, with the waits described in [Long-running bodies](#long-running-bodies). Mineflayer respawns the player after a death.

The bot host waits 100 ms after each inventory click. Mineflayer 4.39 sends clicks without waiting for the server. On 26.1, the server's resync packets then arrive between clicks and corrupt Mineflayer's model of the inventory. Without the wait, crafting loses or duplicates items. See `CLICK_PACE_MS` in `src/host/connection.ts`.

## Security

A program runs inside the bot host process in a `node:vm` context. The VM context is not a sandbox. The bearer token is the only barrier, and anyone who has the token can run code as your user. Keep the API on loopback, and keep `.minebot/` private.

A program can leave the context with `bot.constructor.constructor("return process")()`, and then load any module. The body does not try to prevent that. It audits instead: `src/audit.ts` scans the source of every program for `constructor.constructor` (also as `["constructor"]`), `process`, `getBuiltinModule`, `require(`, `import(`, `globalThis.constructor`, and `Function(`. A program that matches has the pattern names in `escapeAttempts` on its history line. The body writes that line before it runs a flagged program, so a program that kills the body is still recorded, and the benchmark verifier fails the trial. The agent is not told mid-run; the audit record is what counts. The scan is an audit, not a security boundary: code that builds the names at run time passes it, and a comment that contains `process` is flagged. Anything that relies on `--lock-kits`, `--no-agent-kits`, or `--no-milestones` for more than fair play needs a real boundary, such as a separate container for the agent, as in the benchmark.

## Development

```sh
npm run typecheck
npm test
```

The tests cover the program runner, the kit framework, agent kits, the wiki, the capability table, the package boundaries, what each kind of body shows an agent, the escape audit, and the benchmark grading. They do not need a Minecraft server.

A checkout runs from source. The `minebot-sdk/...` entry points in `package.json` have a `minebot-sdk:source` condition (package-scoped, so a consumer that turns on a generic `source` condition does not load files the package does not ship) that points at `src/`, and the npm scripts, the type checker (`customConditions` in `tsconfig.json`), and the benchmark images pass it (`node --conditions=minebot-sdk:source`). Built-in kits import `minebot-sdk/kit` like any other kit, and the condition makes that import resolve to `src/kit/public.ts` here and to `dist/kit/public.js` in an installed package. Run a script that loads kits as `node --conditions=minebot-sdk:source <file>`.

`npm run build` compiles `src/` to `dist/` (JavaScript and `.d.ts`; `tsconfig.build.json`), and `npm pack` runs it first. The tarball holds `dist/`, the kit sources in `src/kit/kits/`, `wiki/`, the license, and this README. `npm publish --dry-run` lists what a release would ship.

## Benchmark

`bench/` contains Minecraft tasks in the Harbor format, with server-side verifiers and reference solutions. See [bench/README.md](bench/README.md).

## License

MIT. See [LICENSE](LICENSE).
