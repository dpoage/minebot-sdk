// The sense kit: looking at the world without changing it — finding blocks and facing positions.
import { action, defineKit, type KitContext, nameMatcher, NamePattern, Point, Position, toVec3, z } from "minebot-sdk/kit";

/** Block positions matching `pattern`, nearest first. */
export function findBlocks(ctx: KitContext, pattern: NamePattern, radius = 32, count = 16) {
  const matches = nameMatcher(pattern);
  const ids = Object.values(ctx.bot.registry.blocksByName)
    .filter((b) => matches(b.name))
    .map((b) => b.id);
  if (ids.length === 0) throw new Error(`no block type matches ${JSON.stringify(pattern)}`);
  return ctx.bot.findBlocks({ matching: ids, maxDistance: radius, count });
}

export const sense = defineKit(
  { name: "sense", description: "Find blocks by name pattern and face a position, without changing anything." },
  {
    find: action({
      doc: "Positions ({x,y,z}) of blocks matching `blocks` ('oak_log', '*_ore', or a list), nearest first. `radius` limits the search, `count` the number of results. Fails when no block type matches.",
      args: z.object({
        blocks: NamePattern,
        radius: z.number().positive().default(32),
        count: z.number().int().positive().default(16),
      }),
      returns: z.array(Point),
      run: (ctx, { blocks, radius, count }) => findBlocks(ctx, blocks, radius, count),
    }),
    look: action({
      doc: "Turn the player's head to face `at` ({x,y,z} or [x,y,z]).",
      args: z.object({ at: Position }),
      returns: z.void(),
      run: (ctx, { at }) => ctx.bot.lookAt(toVec3(at)),
    }),
  },
);
