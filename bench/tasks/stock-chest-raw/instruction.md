You control a Minecraft player named `agent` in a vanilla survival world (Minecraft Java Edition 26.1, Easy difficulty). No one else is playing. The player starts with an empty inventory.

## Goal

Craft a chest, place it in the world, and store at least 16 cobblestone in it.

## How to act

The `minebot` command in this terminal controls the player. The same actions are available as `minebot` MCP tools.

- `minebot observe` prints the position, health, inventory, and nearby entities as JSON.
- `minebot run <file>` runs a JavaScript program against the player and prints its logs and return value. Without a file, it reads the program from stdin.
- `minebot api` prints the program reference. A program is the body of an async function that receives a live Mineflayer `bot`.
- `minebot events` prints recent chat, damage, and deaths.
- `minebot stop` aborts the running program.

A program stops after 60 seconds unless you pass `--timeout <ms>`. Values that you store on `globalThis` persist between programs, so you can build helper functions and reuse them. The API references are at `/opt/minebot/node_modules/mineflayer/docs/api.md` and `/opt/minebot/node_modules/mineflayer-pathfinder/readme.md`.

## Grading

The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice. The contents of the chests in the world are graded too, as the server saved them: the cobblestone has to be in a chest when you finish. You cannot run server commands.

Every program you run is recorded and audited. A program that reaches outside the program environment fails the trial with reward 0. The audit flags these names wherever they appear in a program, comments and strings included: `process`, `require(`, `import(`, `getBuiltinModule`, `Function(`, `constructor.constructor`, and `globalThis.constructor`.
