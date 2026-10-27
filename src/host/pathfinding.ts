// Pathfinder setup for every bot: loads the mineflayer-pathfinder plugin and gives the bot its default
// movements once it has spawned. This module owns that setup; goal validation and the default-movement
// policy belong here too.
import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";

const { pathfinder, Movements } = pathfinderPkg;

/** Load the pathfinder plugin now; on the bot's first spawn, set `new Movements(bot)` as its default movements. */
export function installPathfinder(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.once("spawn", () => {
    bot.pathfinder.setMovements(new Movements(bot));
  });
}
