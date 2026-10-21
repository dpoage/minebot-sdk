# The minebot SDK

The minebot SDK is the part of a Minecraft agent that is the same for every agent: a body in the game, the actions and observations of that body, and the state that belongs to it. An agent harness supplies the rest: the model, the turn loop, the context, and the decisions.

## Layers

| Layer | Contents | Who uses it |
| - | - | - |
| Body | The supervisor (API transport, event log, program history) and the bot host it forks (one Mineflayer player connection, the program runner, the body's state) | Every agent, through an adapter |
| Adapters | HTTP API, `minebot` CLI, MCP server | Harnesses |
| Libraries | Kits — built-in and agent-written — and the wiki | Agents, when the body offers them |
| Bench | Harbor tasks, the verifier, the escape audit, launchers | People who evaluate agents |

```mermaid
flowchart LR
  H[Agent harness: model, loop, context] -->|MCP / CLI / HTTP| A[Adapters]
  A --> B[Body]
  B --> L[Libraries: kits and the wiki]
  B --> S[(State: notes, milestones, triggers, kit stores, agent kits)]
  B -->|Mineflayer| M[Minecraft server]
  E[Bench: tasks, verifier] -.-> B
```

One module map holds the boundaries: `src/protocol/` holds the wire contract (zod schemas for every request, the response types, the endpoint file, the capability table, and the TypeScript declarations derived from kit schemas) and, in `host.ts`, `request.ts`, and `event-filter.ts`, the contract between the supervisor and the bot host; `src/mc/` holds neutral Mineflayer helpers; `src/milestones/` is pure grading; `src/program/` runs programs; `src/kit/` is the kit framework and the kits; `src/body/` is the supervisor: the HTTP transport, the event log, the program history, and the code that forks, watches, and restarts the bot host; `src/host/` is the bot host: the Mineflayer connection, the body's state, the API routes, and the triggers; `src/wiki/` serves pages; `src/client/` is the CLI, the MCP server, and the renderers. The client loads only the wire-contract part of `src/protocol/` (not `host.ts`, `request.ts`, or `event-filter.ts`) and what the protocol itself needs (`src/milestones/` and `src/mc/names.ts`) plus `src/package.ts`, which `minebot init` uses to find the package manifest. A test resolves the runtime import closure of the client and of the verifier, fails when either leaves its set, and checks that the image copy lists match it. Two more tests check that the supervisor loads no code from `src/host/`, `src/kit/`, `src/program/`, or `src/wiki/` and no Minecraft library, and that the bot host loads nothing from `src/body/`.

The npm package `minebot-sdk` is the authoring library plus the CLI; the body stays a separate runtime process that the CLI starts and that every other layer reaches over HTTP. Three entry points are public: `minebot-sdk/kit` (`src/kit/public.ts`, the one surface that built-in and agent kits write against), `minebot-sdk/client` (`src/client/public.ts`, the typed HTTP client and the wire types, with no CLI or MCP code), and `minebot-sdk/testing` (`src/testing/index.ts`, the kit test harness). Each export has a package-scoped `minebot-sdk:source` condition that resolves to the TypeScript under `src/`, and a default that resolves to the compiled `dist/`. The repository runs with `--conditions=minebot-sdk:source` and a published package without it, so a specifier such as `minebot-sdk/kit` means the same module in both. A test that resolves import closures follows these self-references to their `source` files. Kit sources (`src/kit/kits/`) and the wiki ship beside `dist/`, found through `PACKAGE_ROOT` (`src/package.ts`), so `kits source` and the default wiki directory work from either layout.

A body is two processes. The supervisor answers health, events, waits, and stop, and forwards every other request to the bot host, which holds the player connection and runs the programs. If the bot host crashes, or the supervisor kills it for a program that does not stop, the supervisor forks a replacement that reconnects as the same player. The restart waits 1 second; each restart in quick succession doubles the wait, up to 60 seconds, and a host that stays up for 60 seconds starts over at 1 second. A restart loses what the old host held in memory, such as `globalThis` and the running program; state on disk stays. The supervisor ends the lost program's run with an error that says the bot host was restarted.

The MCP server has two tool sets. `core`, the default, serves what an agent needs to act through programs: `observe`, `run_program`, `stop_program`, `wait_for`, `get_events`, `api_reference`, and `kit_docs`. Programs reach every other operation through their globals, so the core set loses no capability and keeps the tool list small. `minebot mcp --tools full` also serves notes, status, chat, kit management, the wiki, and triggers as tools of their own. In both sets, the capability table decides which gated tools appear (`toolPlan` in `src/client/mcp.ts`).

## The boundary between the SDK and a harness

Two rules decide where a feature belongs.

1. **If a feature acts without the agent asking, it belongs to the agent.** The body does not eat, flee, plan, retry, or give advice. The exceptions are things the connection requires: the body reconnects after a disconnect, it restarts a bot host that crashed, and it pauses after each inventory click so that crafting does not lose items. A trigger is not an exception: the agent wrote its code, chose its events, and can remove it, so the body acts only because the agent registered it.
2. **If every harness needs a feature in the same form, it belongs to the SDK.** Observations, actions, events, and waits are the same for every harness. Context compaction, planning, todo lists, and restart loops differ between harnesses, so the harness supplies them.

State that must outlive a harness session belongs to the body. The body is the only part that persists when the context resets, the harness restarts, or the operator changes the harness. For this reason, notes, agent kits, and triggers live on the body.

| In the SDK | In the harness |
| - | - |
| Observe, run programs, stop, chat | Choose the next action |
| Events and blocking waits | Decide when to wait and for what |
| Notes, milestones, kits, kit stores, and triggers, on disk | What to keep in the context window |
| Status: deaths, reconnects | Plans and todo lists |
| Running the triggers the agent registered | Which reflexes to install, and what they do |
| Reconnect, host restart, and click pacing | Restarts of the agent session |
| Kits and the wiki, when offered | Prompts and instructions |

## Kits

A kit is a composable library of typed actions. One authoring model covers the built-in kits and the kits agents write: every kit is a file that declares itself with `defineKit`, and every action with `action`.

```ts
import { action, defineKit, Point, z } from "minebot-sdk/kit";

export default defineKit(
  { name: "woodcutter", description: "Chops the nearest logs and reports where the player ends up.", uses: ["move", "sense", "dig"] },
  {
    chop: action({
      doc: "Walks to each of the `times` nearest logs within 16 blocks and digs it. Returns how many it dug and where the player then stands.",
      args: z.object({ times: z.number().int().positive().default(1) }),
      returns: z.object({ chopped: z.number(), standingAt: Point }),
      run: async (ctx, { times }) => {
        const logs = await ctx.kits.sense.find({ blocks: "*_log", radius: 16, count: times });
        for (const log of logs) {
          await ctx.kits.move.to({ position: log, range: 3 });
          await ctx.kits.dig.dig({ at: log });
        }
        const here = ctx.bot.entity.position.floored();
        return { chopped: logs.length, standingAt: { x: here.x, y: here.y, z: here.z } };
      },
    }),
  },
);
```

### Units

- **Action**: `action({ doc, args, returns, run })`. `args` is a zod object schema; `doc` says what the action does. Every action takes one object argument, validated on every call — nested calls included. A bad call fails with the action's schema in the error. `returns` is a zod schema of the result: `run` must return a value that fits it (checked by the type system), the result is validated on every call, and a mismatch fails the call naming `kit.<kit>.<action>` and the schema. Callers get the validated value, typed. Every built-in action declares `returns`.
- **Kit**: `defineKit({ name, description, uses }, actions)`. `uses` names the kits this kit calls; nothing else is reachable. It is the first argument, apart from the actions, so that `ctx.kits` in every action is typed from it.
- **`ctx`**: what `run` receives. It holds `bot`, `log`, `sleep`, `signal`, and `on` from the calling program (so cancellation propagates into nested actions), a time-limit helper `within`, the kits named in `uses` as `ctx.kits.<kit>.<action>({ ... })`, and `store` — persistent JSON scoped to this kit alone.

### Layers

Primitive kits do one thing. Routine kits are built only from public primitives through `ctx.kits`, so anything a routine kit does, an agent kit can do too, and combine differently. `surface` lives in `explorer` because it is a climb-to-open-sky routine built from `move` and `dig`.

| Primitive | Actions |
| - | - |
| `move` | `to`, `stop` |
| `sense` | `find`, `look` |
| `dig` | `dig` |
| `place` | `place` |
| `inventory` | `list`, `count`, `equip`, `toss` |
| `craft` | `craft`, `table` |
| `items` | `recipes`, `drops` |
| `furnace` | `smelt`, `take` |
| `container` | `list`, `deposit`, `withdraw` |
| `survival` | `eat`, `sleep`, `wake`, `armor` |
| `combat` | `attack`, `fight`, `retreat` |
| `farm` | `till`, `plant`, `harvest`, `breed` |
| `bucket` | `fill`, `empty` |

| Routine kit | Uses |
| - | - |
| `gatherer` | move, sense, dig, inventory, items |
| `crafter` | move, sense, place, inventory, craft, items, furnace |
| `builder` | move, sense, dig, place, inventory |
| `explorer` | move, sense, dig |
| `social` | move, sense, inventory |

The partition keeps each primitive small enough to learn from its source (`minebot kits source <kit>` prints it) and each routine honest about its dependencies. `inventory.count` and `items.drops` are separate because counting what you hold and finding what lies on the ground answer different questions; `craft` works at a table within reach while `crafter` is the routine that ensures a table exists; `furnace` smelts at a furnace within reach while `crafter` ensures one and smelts furnace outputs such as iron ingots.

### Namespaces and uses

Programs call actions as `kit.<kit>.<action>({ ... })`, so no two kits can collide on a name and every call says which kit it costs. Dependencies are explicit: a kit whose `uses` are not available fails when it is saved or loaded, never mid-run. Activating a kit activates the kits it uses.

### Offered and active

The operator decides which kits a body **offers** with `--kits <a,b>`; without the flag, every built-in kit is offered, plus saved agent kits. The agent picks the **active** set among the offered kits with `kits.use(...)`; a call to an offered but inactive kit names the kit to activate. `--lock-kits` fixes the active set: the other kits disappear from every surface, and a program finds no `kits.use`. On a locked body a saved kit is offered but not active; it joins the active set on the next start without the lock.

Docs come from the kits themselves: `kits.docs()` (and `minebot kits docs`) render each action's call shape, argument types and defaults, and return shape from its zod schemas, next to its `doc`.

Search and statistics help an agent choose. `kits.search(query, limit?)` ranks the kits and actions the body lists by name, kit description, and action doc (`minebot kits search`, `kit_search`, `GET /kits/search`). The ranker (`src/rank.ts`) is shared with the wiki search. A query word matches a word exactly, by prefix, or within one typo (both words 4 or more letters) or two (both 7 or more). Exact matches score as they would without fuzzy matching. A fuzzy match of a query word counts only in a document that lacks the word, scaled by its kind (prefix above typo). Documents with no exact match rank below every document with one. The framework counts every call of every action, nested calls included — returned, failed, and the message of the last failure — in `kit-stats.json` in the state directory. The counts are per body and survive restarts; `kits.available()` and `minebot kits` show them, so an agent prefers the actions that work.

### Agent kits

An agent saves a kit as TypeScript source: `kits.save(source)` in a program, `minebot kits save [file]` in the CLI, `kit_save { source }` over MCP, or `POST /kits/save` over HTTP. The source uses the shape above, with one import from `minebot-sdk/kit`: the body binds the named imports to the real module's values and injects nothing else. `import type` from any specifier is erased; every other import, `require`, `import()`, and `import.meta` is rejected, and so is the old form with `defineKit`, `action`, and `z` as globals (the error names the import line to add). The scan for these skips comments, strings, and templates, and `import()` is blocked again when the kit runs, so a spelling the scan misses still cannot load a module. The source exports exactly one kit: `export default defineKit(...)` or `export const <name> = defineKit(...)`, the form the built-ins use; other `export const` and `export function` declarations are ignored, so `kits.source("move")` can be saved under a new name unchanged. Types are stripped with node's own stripper; the body does not type-check a save, a workspace's `tsc` does (see Authoring workspace).

Saving validates before it writes, and writes atomically: the source must compile, pass the escape audit, use only kits this body offers, and not take a built-in kit's name. Nothing is written when the source is rejected. A saved kit is offered and active at once. `kits.remove(name)` deletes it; `kits.source(name)` prints any kit's source, starting point included.

Trying comes before saving. `kits.try(source, { action, args })` (`minebot kits try [file] --action <name> [--args <json>]`, `kit_try`, `POST /kits/try`) validates the source exactly like a save, then calls one action once against the live bot as part of the current program, and returns its result or throws its error. Nothing is written or registered, the `ctx.store` of the tried kit and of every kit it calls is thrown away, and no call is counted. Over MCP, CLI, and HTTP the try runs as a program, so it appears in the history like one.

Saving and trying type-check the source (`src/host/typecheck.ts`). The body writes the source and a `KitRegistry` block for its other agent kits (from their schemas, the same printer as `minebot types`) to a temporary directory, and runs the TypeScript compiler on it with the options of the `minebot init` workspace and `minebot-sdk/kit` mapped onto the package's own types. Only diagnostics in the kit's file count. The check never blocks: `kits.save` returns `typeCheck` (`passed`, `failed` with the errors, or `skipped` with a reason), and `kits.try` runs the check beside the action and writes failures to the program log. TypeScript is an optional peer dependency; without it the check reports `skipped`.

Saving over a kit keeps the old source as a numbered version: `.history/<kit>/<n>.ts` and `<n>.json` (`version`, `savedAt`, `savedBy` — the body's name) inside the agent-kit directory. A save of the source that is already saved adds no version. `kits.versions(name)` lists the versions and marks the current one; `kits.revert(name, version)` saves an earlier version again as a new version, validated like any save, so the history only grows. A removed kit keeps its history. Saving a different source for a kit, and removing it, resets that kit's counts, whichever body did it.

Several bodies may share the agent-kit directory (`--agent-kits <dir>`, default the state directory's `agent-kits/`); each re-reads it when it changes, so a kit one body saves works on the others without a restart, and the history is shared the same way: a version's number is claimed with an exclusive file create, so two bodies saving at once get different numbers. A bad file on disk never stops a body: it is skipped and reported as a `kit_error` event.

### Authoring workspace

`minebot init [dir]` scaffolds a workspace: `package.json` (dependency `minebot-sdk`, dev dependency `typescript`), a strict `tsconfig.json` that includes `kits/`, `programs/`, `test/`, and the generated declarations, an example kit, an example program, an example kit test (`test/hello.test.ts`, below), and a README. The body is not part of the workspace; it runs as a separate process with `--agent-kits ./kits`, so saving a kit file reloads it there.

`minebot types [--out <file>]` generates the declarations. It asks the body for the JSON Schema of every listed kit action (`GET /kits/schemas`, only on a body that offers kits, from zod 4's `toJSONSchema`: the argument as callers write it, the result as callers read it) and prints TypeScript for them. The file is a module with two parts: `declare module "minebot-sdk/kit" { interface KitRegistry { ... } }` for the kits the package does not ship, and `declare global { ... }` for the program globals. The globals follow the capability table (`CAPABILITY_GATES`): no `kit` or `kits` without kits, no `wiki.addLesson` without lessons, no `kits.use` on a locked body, and so on. `kit` is typed against `KitRegistry` for the active kits. Output is sorted and stable. A schema the printer cannot express becomes `unknown`.

Programs checked this way are `.ts` files: `minebot run file.ts` strips the types and sends JavaScript. They are function bodies, so they use top-level `await` (the tsconfig sets `moduleDetection: "force"`) and never a top-level `return`.

### Testing kits

`minebot-sdk/testing` (`src/testing/index.ts`) is the kit test harness. `createKitHarness({ kits, inventory, blocks, entities, position, time, ... })` builds the real `KitHost` around a fake Mineflayer bot, so an action runs through the same code as in a body: arguments and results are validated, `ctx.kits` offers only the kits in `uses`, each kit gets an in-memory store, and the active set applies. `h.call("kit.action", args)` runs one action; `h.kit` is the typed `kit` object a program sees; `h.calls` records every call, nested ones with the caller's arguments; `h.abort()` fires the program's signal.

The bot is built on the registry that `prismarine-registry` loads for `MC_VERSION`, with real prismarine blocks, items, entities, and recipes. It implements a slice of Mineflayer on purpose: a block world over a ground layer (`blockAt`, `findBlock`, `findBlocks`, `dig` with drops, `placeBlock`), an inventory with Mineflayer's slot layout (`equip`, `toss`, crafting through the real recipes), entities and the day clock, furnaces that cook on the clock, and a pathfinder whose `goto` and `setGoal` teleport to the nearest standable spot that satisfies the goal. The harness tests decision logic, not physics. Every other Mineflayer member is wrapped so that calling it throws `UnsupportedApiError`: `not supported by minebot-sdk/testing: bot.attack`. A kit never continues with an `undefined` from an API the harness does not model, and a missing capability shows up as a named failure, not a wrong answer.

The harness imports the framework and the shipped kits from the package itself, so it ships in `dist/testing/` and runs the same from a checkout and from an installed package. The repository's own kit tests use it where they exercise a kit (`crafter.make` from seven logs, smelting, the framework's call, signal, and uses tests); helper-level tests of pure functions stay as they are.

## Triggers

A trigger is a program that the body runs when an event arrives. It gives an agent reflexes that act between its turns: eat when food is low, flee when hurt, answer a chat. The agent registers a trigger with `triggers.add({ name, on, run, ... })` in a program, `minebot triggers add <name> --on <types> [file]` in the CLI, `trigger_add` over MCP, or `POST /triggers` over HTTP.

- **Events.** `on` lists event types from the event log. The filters `from` and `match` work as in `wait`, and `when` is a JavaScript expression over `event` and `bot` that must be truthy. A trigger cannot listen to `trigger_*` events, so reflexes do not trigger each other.
- **The run.** `run` is a program with the usual globals plus `event`. It uses the same runner as every program, so one program runs at a time, and the run ends with a `trigger_finished` event, not `program_finished`.
- **Scheduling.** A firing waits until no program is running. It waits at most once per trigger, and waiting firings run by `priority`. A trigger with `preempt: true` stops the running program instead, unless that is a trigger of equal or higher priority. The firing runs when the stopped program has ended. `cooldownMs` limits how often a trigger fires.
- **Failure.** A failing trigger never affects the body. A trigger that errors or times out three times in a row disables itself and emits `trigger_disabled`; enabling it again clears the count.
- **State.** Triggers persist in the state directory as `triggers.json`, written atomically, so they survive a restart. A stored trigger that no longer loads is skipped and reported as a `trigger_error` event.
- **Audit.** The code of a trigger is checked with the escape audit like a program. The history records it when it is saved and records each firing with the trigger's name.

A body started with `--no-triggers` has no trigger routes, tools, commands, global, or wiki page, and its program reference does not mention them.

## Primitives

| Primitive | What it does |
| - | - |
| Observe | Returns the player's state as JSON, or as one line with `--brief`. |
| Run | Runs a JavaScript program against the live bot and returns logs and a result. |
| Stop | Aborts the running program and halts movement and digging. |
| Events | Returns chat, damage, deaths, joins, disconnects, day and night changes, finished programs, and what the player did or noticed (items picked up, blocks broken or placed, items crafted, hostile creatures near, low health or food) since a cursor. |
| Wait | Blocks until an event matches a filter, or until a timeout. An agent uses it to idle at the cost of one call. |
| Chat | Sends a chat message as the player. |
| Notes | Stores text that the agent writes, on the body. |
| Agent kits | Stores typed kits that the agent writes, on the body. Programs call them as `kit.<kit>.<action>({ ... })`. |
| Triggers | Stores programs that the agent writes, on the body, and runs each one when an event of its kind arrives. |
| Status | Returns deaths and reconnects since the body started. |

## Features

Each body offers a set of features. The operator chooses the set when the body starts. One capability table derives every agent-facing surface — the CLI help, `minebot api`, the MCP tool list and descriptions, the program globals, the API routes, the wiki pages, and the observation — so an agent never learns about a feature that its body does not offer.

| Feature | Body option | Default |
| - | - | - |
| Kits | `--kits <a,b>`, `--lock-kits` | every built-in kit offered |
| Agent kits | `--no-agent-kits`, `--agent-kits <dir>` | on |
| Wiki | `--wiki off\|read\|write` | read |
| Milestones | `--milestones <file>`, `--no-milestones` | on |
| Triggers | `--no-triggers` | on |

The benchmark starts every body with `--no-agent-kits` and `--no-milestones`, with `--no-triggers` except in `survive-nights`, and selects kits and the wiki per tier. See [bench/README.md](../bench/README.md).

## Run an agent for a long time

The SDK does not include a loop that restarts the agent. To run an agent for days, run the harness in a loop that you control. Start each session with a prompt that tells the agent to read its notes, its status, and the events since its last session. The body keeps the notes, the milestones, the kit stores, and the agent kits between sessions.
