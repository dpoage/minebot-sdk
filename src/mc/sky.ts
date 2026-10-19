// Looking straight up: the sky view the observation reports. Neutral Mineflayer helpers,
// used by the body's observation and by kits that care about cover.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

const AIR = new Set(["air", "cave_air", "void_air"]);

/** True for the air block types. Thin blocks without collision (leaf_litter, short_grass) are not air. */
export function isAir(block: { name: string }): boolean {
  return AIR.has(block.name);
}

export interface SkyView {
  /** Nothing solid and no water above the player's head, ignoring leaves. */
  open: boolean;
  /** The nearest solid or water block above the head. */
  cover?: string;
  /** Solid blocks in the column above the head: a rough depth underground. */
  solidAbove: number;
  /** Water blocks in the column above the head: a rough depth under water. */
  waterAbove: number;
}

/** Looks straight up from a player standing at `feet`. Leaves do not count as cover; water does. */
export function skyAbove(bot: Bot, feet: Vec3): SkyView {
  // Mineflayer sets minY and height from the dimension at login; its typings omit them.
  const { minY, height } = bot.game as typeof bot.game & { minY: number; height: number };
  const top = minY + height;
  let cover: string | undefined;
  let solidAbove = 0;
  let waterAbove = 0;
  for (let y = Math.floor(feet.y) + 2; y < top; y++) {
    const block = bot.blockAt(new Vec3(Math.floor(feet.x), y, Math.floor(feet.z)));
    if (!block) break;
    if (block.name === "water") waterAbove++;
    else if (block.boundingBox === "block" && !block.name.endsWith("_leaves")) solidAbove++;
    else continue;
    cover ??= block.name;
  }
  return cover ? { open: false, cover, solidAbove, waterAbove } : { open: true, solidAbove: 0, waterAbove: 0 };
}
