You control a Minecraft player named `agent` in a vanilla survival world (Minecraft Java Edition 26.1, Easy difficulty). No one else is playing. The player is wherever the previous session left it.

## Goal

Craft a stone pickaxe, using the logs in the chest that a previous session of this agent left.

You are the second of two sessions. The first session collected logs and put 8 of them in a chest somewhere in this world, then walked away from it. You know nothing about that session except what it left in the body (the notes) and in the world. Find the chest, take at least 4 logs out of it, and use them for the tools. You start with whatever the first session left in the inventory.

## How to act

The `minebot` command in this terminal controls the player. The same actions are available as `minebot` MCP tools.

- `minebot observe` prints the position, health, inventory, and nearby entities as JSON.
- `minebot run <file>` runs a JavaScript program against the player and prints its logs and return value. Without a file, it reads the program from stdin.
- `minebot api` prints the program reference. A program is the body of an async function that receives a live Mineflayer `bot`.
- `minebot events` prints recent chat, damage, and deaths.
- `minebot stop` aborts the running program.

A program stops after 60 seconds unless you pass `--timeout <ms>`. Values that you store on `globalThis` persist between programs, so you can build helper functions and reuse them. The API references are at `/opt/minebot/node_modules/mineflayer/docs/api.md` and `/opt/minebot/node_modules/mineflayer-pathfinder/readme.md`.

## Kits

Programs call ready-made actions through the `kit` global, namespaced by kit, with one object argument: `await kit.gatherer.gather({ blocks: "*_log", count: 4 })` or `await kit.crafter.make({ item: "wooden_pickaxe" })`. Run `minebot kits docs` for every action, its arguments, and their defaults. The body offers the primitive kits move, sense, dig, place, inventory, craft, items, furnace, container and the routine kits gatherer, crafter, builder, explorer, social, which are built from them. You cannot change the active kits.

## Notes

The body keeps notes that outlast your session: `minebot notes` lists them, `minebot notes get <key>` reads one, and `minebot notes set <key> <text>` writes one (the text comes from stdin when omitted). Programs use `notes.list()`, `notes.get(key)`, and `notes.set(key, text)`.

## Grading

The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice. The contents of the chests in the world are graded too, as the server saved them: the chest that the first session filled has to be where it was and hold 4 logs or fewer when you finish, and the first session has to have stopped at least 200 blocks from it. You cannot run server commands.

Every program you run is recorded and audited. A program that reaches outside the program environment fails the trial with reward 0. The audit flags these names wherever they appear in a program, comments and strings included: `process`, `require(`, `import(`, `getBuiltinModule`, `Function(`, `constructor.constructor`, and `globalThis.constructor`.
