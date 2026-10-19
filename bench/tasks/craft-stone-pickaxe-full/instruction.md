You control a Minecraft player named `agent` in a vanilla survival world (Minecraft Java Edition 26.1, Easy difficulty). No one else is playing. The player starts with an empty inventory.

## Goal

Craft a stone pickaxe.

## How to act

The `minebot` command in this terminal controls the player. The same actions are available as `minebot` MCP tools.

- `minebot observe` prints the position, health, inventory, and nearby entities as JSON.
- `minebot run <file>` runs a JavaScript program against the player and prints its logs and return value. Without a file, it reads the program from stdin.
- `minebot api` prints the program reference. A program is the body of an async function that receives a live Mineflayer `bot`.
- `minebot events` prints recent chat, damage, and deaths.
- `minebot stop` aborts the running program.

A program stops after 60 seconds unless you pass `--timeout <ms>`. Values that you store on `globalThis` persist between programs, so you can build helper functions and reuse them. The API references are at `/opt/minebot/node_modules/mineflayer/docs/api.md` and `/opt/minebot/node_modules/mineflayer-pathfinder/readme.md`.

## Kits

Programs call ready-made actions through the `kit` global, namespaced by kit, with one object argument: `await kit.gatherer.gather({ blocks: "*_log", count: 4 })` or `await kit.crafter.make({ item: "wooden_pickaxe" })`. Run `minebot kits docs` for every action, its arguments, and their defaults. The body offers the primitive kits move, sense, dig, place, inventory, craft, items, furnace and the routine kits gatherer, crafter, builder, explorer, social, which are built from them. You cannot change the active kits.

## Wiki

The wiki has notes on game mechanics, step-by-step plans, and known quirks of this Minecraft version and of Mineflayer. Search it before you guess, and search for the text of an error when something fails:

- `minebot wiki search <words>` lists matching pages.
- `minebot wiki read <page>` prints a page.

Programs can use `wiki.search(words)` and `wiki.read(page)` too.

## Grading

The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice. You cannot run server commands.

Every program you run is recorded and audited. A program that reaches outside the program environment fails the trial with reward 0. The audit flags these names wherever they appear in a program, comments and strings included: `process`, `require(`, `import(`, `getBuiltinModule`, `Function(`, `constructor.constructor`, and `globalThis.constructor`.
