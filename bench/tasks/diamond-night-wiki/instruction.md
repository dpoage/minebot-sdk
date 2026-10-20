You control a Minecraft player named `agent` in a vanilla survival world (Minecraft Java Edition 26.1, Easy difficulty). No one else is playing. The player starts with an empty inventory.

## Goal

Craft a diamond pickaxe, and do not die before the first night is over.

Diamonds need an iron pickaxe, and they lie deep: diamond ore is most common far below sea level, under the deepslate. The world starts at dawn. A Minecraft day is 24000 ticks, which is 20 minutes of real time. The sun sets about 13000 ticks into the day (11 minutes after the world starts), and the night ends when the sun comes up on the next day (24000 ticks). Hostile creatures spawn in the dark, at night on the surface and at any time in caves.

You are graded when you stop or when the time limit passes, whichever is first. By then the server's clock must have passed the end of the first night (24000 ticks), the diamond pickaxe must be crafted, and the player must never have died: stopping early gives no reward. `minebot wait --types day,hostile_near,low_health --timeout <ms>` blocks until one of those events arrives, up to 30 minutes, and costs nothing while it waits.

## How to act

The `minebot` command in this terminal controls the player. The same actions are available as `minebot` MCP tools.

- `minebot observe` prints the position, health, inventory, and nearby entities as JSON.
- `minebot run <file>` runs a JavaScript program against the player and prints its logs and return value. Without a file, it reads the program from stdin.
- `minebot api` prints the program reference. A program is the body of an async function that receives a live Mineflayer `bot`.
- `minebot events` prints recent chat, damage, and deaths.
- `minebot stop` aborts the running program.

A program stops after 60 seconds unless you pass `--timeout <ms>`. Values that you store on `globalThis` persist between programs, so you can build helper functions and reuse them. The API references are at `/opt/minebot/node_modules/mineflayer/docs/api.md` and `/opt/minebot/node_modules/mineflayer-pathfinder/readme.md`.

## Wiki

The wiki has notes on game mechanics, step-by-step plans, and known quirks of this Minecraft version and of Mineflayer. Search it before you guess, and search for the text of an error when something fails:

- `minebot wiki search <words>` lists matching pages.
- `minebot wiki read <page>` prints a page.

Programs can use `wiki.search(words)` and `wiki.read(page)` too.

## Triggers

A trigger is a program that the body starts when an event arrives, so a reaction does not wait for your next turn. `minebot triggers add <name> --on <events> [file]` saves one (the program comes from stdin when the file is omitted; options `--cooldown <ms>`, `--timeout <ms>`, `--priority <n>`, and `--preempt`, which lets the trigger stop the running program). `minebot triggers` lists the triggers and what they did, and `minebot triggers rm <name>` deletes one. Programs can use `triggers.add({ name, on, run })` too. The events include `hurt`, `low_health`, `low_food`, `hostile_near`, `night`, and `day`. The body runs only the triggers you register.

## Grading

The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice. Every step of the chain counts, not only the diamond pickaxe: the iron has to be mined and smelted, and the diamonds have to be mined. Smelting counts as crafting: an item that you take out of a furnace is counted when you take it. The server's clock and the number of times the player died are graded too: the clock has to show at least one full day (24000 ticks), and the player must not have died. You cannot run server commands.

Every program you run is recorded and audited. A program that reaches outside the program environment fails the trial with reward 0. The audit flags these names wherever they appear in a program, comments and strings included: `process`, `require(`, `import(`, `getBuiltinModule`, `Function(`, `constructor.constructor`, and `globalThis.constructor`.
