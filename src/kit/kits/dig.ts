// The dig kit: digging one block with the right tool, keeping falling blocks from refilling it.
import { action, defineKit, type KitContext, Position, toVec3, Vec3, z } from "minebot-sdk/kit";

export interface DigResult {
  /** The last block that was dug, or null when the position was already clear. */
  block: string | null;
}

/**
 * Digs the block at `pos`, keeping digging while falling blocks (gravel, sand) refill the
 * position. Equips the best harvest tool and fails with the tools the block needs when the
 * inventory has none of them.
 */
export async function digAt(ctx: KitContext, pos: Vec3): Promise<DigResult> {
  const { bot } = ctx;
  let dug: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const block = bot.blockAt(pos);
    if (!block) throw new Error(`${pos} is not loaded`);
    if (block.boundingBox !== "block") return { block: dug };
    if (!block.diggable) throw new Error(`${block.name} at ${pos} cannot be dug`);
    const tool = bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, "hand");
    if (!block.canHarvest(bot.heldItem?.type ?? null)) {
      const tools = Object.keys(block.harvestTools ?? {}).map((id) => bot.registry.items[Number(id)]?.name);
      throw new Error(`${block.name} needs one of: ${tools.join(", ")}`);
    }
    await ctx.within(30_000, `digging ${block.name}`, bot.dig(block, true), () => bot.stopDigging());
    dug = block.name;
    await ctx.sleep(250); // let a falling block land
  }
  throw new Error(`${pos} keeps refilling`);
}

export const dig = defineKit(
  { name: "dig", description: "Dig one block with the right tool; falling blocks that refill the hole are dug too." },
  {
    dig: action({
      doc: "Dig the block at `at` ({x,y,z} or [x,y,z]), equipping the best tool and failing with the tools it needs when the inventory lacks them. Digs on while gravel or sand refills the position. Returns { block } — the last block dug, or null when the position was already clear.",
      args: z.object({ at: Position }),
      returns: z.object({ block: z.string().nullable() }),
      run: (ctx, { at }) => digAt(ctx, toVec3(at).floored()),
    }),
  },
);
