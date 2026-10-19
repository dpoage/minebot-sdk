// Biome names. prismarine-block leaves `block.biome.name` empty on 26.1; the registry maps the id correctly.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

/** The biome name at a block position, e.g. `forest`; `unknown` when the registry has no such id. */
export function biomeAt(bot: Bot, pos: Vec3): string {
  return bot.registry.biomes[bot.world.getBiome(pos.floored())]?.name ?? "unknown";
}
