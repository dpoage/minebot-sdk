// Asking the server for the player's statistics: the Mineflayer I/O half of milestone grading.
// The pure half (grading) lives in src/milestones, which the verifier ships without this file.
import type { Bot } from "mineflayer";
import type { PlayerStats } from "../milestones/milestones.ts";

/**
 * Stat categories in the order of the vanilla `stat_type` registry; the statistics packet
 * sends the index. Mined counts blocks; killed and killed_by count entity types; custom
 * counts things like distance walked, which this module does not name.
 */
const STAT_TYPES = ["mined", "crafted", "used", "broken", "picked_up", "dropped", "killed", "killed_by", "custom"] as const;

export interface StatEntry {
  categoryId: number;
  statisticId: number;
  value: number;
}

type Registry = Bot["registry"];

/** Converts statistics packet entries to the stats-file shape that `grade` reads. */
export function statsFromEntries(entries: readonly StatEntry[], registry: Registry): PlayerStats {
  const stats: Record<string, Record<string, number>> = {};
  for (const { categoryId, statisticId, value } of entries) {
    const type = STAT_TYPES[categoryId];
    if (!type) continue;
    let name: string | undefined;
    if (type === "mined") name = registry.blocks[statisticId]?.name;
    else if (type === "killed" || type === "killed_by") name = registry.entities[statisticId]?.name;
    else if (type === "custom") name = `custom_${statisticId}`;
    else name = registry.items[statisticId]?.name;
    if (!name) continue;
    (stats[`minecraft:${type}`] ??= {})[`minecraft:${name}`] = value;
  }
  return { stats };
}

/** Asks the server for the player's statistics and waits for the reply. */
export async function requestStats(bot: Bot, timeoutMs = 5000): Promise<PlayerStats> {
  const reply = Promise.withResolvers<StatEntry[]>();
  const onStats = (packet: { entries: StatEntry[] }) => reply.resolve(packet.entries);
  const timer = setTimeout(() => reply.reject(new Error(`the server sent no statistics within ${timeoutMs} ms`)), timeoutMs);
  bot._client.once("statistics", onStats);
  try {
    bot._client.write("client_command", { actionId: 1 });
    return statsFromEntries(await reply.promise, bot.registry);
  } finally {
    clearTimeout(timer);
    bot._client.off("statistics", onStats);
  }
}
