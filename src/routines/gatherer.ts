// The gatherer routines: collect resources by walking, digging, and picking up the drops —
// built from the move, sense, dig, inventory, and items primitives.
import { defineRoutine, NamePattern, Point, type RoutineContext, Vec3, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as sense from "minebot-sdk/routines/sense";
import * as dig from "minebot-sdk/routines/dig";
import * as inventory from "minebot-sdk/routines/inventory";
import * as items from "minebot-sdk/routines/items";

export const description = "Collect resources: walk to matching blocks, dig them with the right tool, pick up the drops.";
export const uses = ["move", "sense", "dig", "inventory", "items"] as const;

interface GatherResult {
  dug: number;
  /** Inventory change while gathering, e.g. { oak_log: 4 }. */
  gained: Record<string, number>;
  skipped: number;
}

const MAX_FAILURES = 12;
// Survival players dig blocks up to 4.5 blocks from the eyes (to the block's centre, as bucket.ts measures it).
const DIG_REACH = 4.5;
const EYE_HEIGHT = 1.62;

/** Walks within 3 blocks of `target`. A walk that fails where `target` is in dig reach anyway, as the top log of a tall trunk, is no failure. */
async function walkToDig(ctx: RoutineContext, target: Vec3): Promise<void> {
  try {
    await move.to(ctx, { position: target, range: 3, timeoutMs: 45_000 });
  } catch (err) {
    if (ctx.signal.aborted || ctx.bot.entity.position.offset(0, EYE_HEIGHT, 0).distanceTo(target.offset(0.5, 0.5, 0.5)) > DIG_REACH) throw err;
    ctx.log(`gather: digging ${target} from here, in reach though the walk failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Walks over each floored position within `radius` where drops lie, once. `failed` holds the positions
 * (`x,y,z`) a walk already failed on; those are not tried again, and new failures are added. Returns how
 * many positions it reached and which it could not.
 */
async function pickUpDrops(ctx: RoutineContext, failed: Set<string>, radius = 8): Promise<{ reached: number; unreachable: Point[] }> {
  await ctx.sleep(400);
  const targets = new Map<string, Point>();
  for (const p of await items.drops(ctx, { radius })) targets.set(`${p.x},${p.y},${p.z}`, p);
  let reached = 0;
  const unreachable: Point[] = [];
  for (const [key, p] of targets) {
    if (failed.has(key)) continue;
    try {
      await move.to(ctx, { position: p, range: 0, timeoutMs: 10_000 });
      reached++;
    } catch (err) {
      failed.add(key);
      unreachable.push(p);
      ctx.log(`collectDrops: could not reach drop at ${new Vec3(p.x, p.y, p.z)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await ctx.sleep(300);
  return { reached, unreachable };
}

/**
 * Digs `count` blocks matching `pattern`, nearest first, preferring blocks near the bot's height,
 * and picks up the drops. Unreachable blocks are skipped; it gives up after `MAX_FAILURES` skips.
 */
async function gatherBlocks(ctx: RoutineContext, pattern: NamePattern, count: number, radius = 48): Promise<GatherResult> {
  const { bot } = ctx;
  const before = await inventory.list(ctx, {});
  const skipped = new Set<string>();
  const failedDrops = new Set<string>();
  let dug = 0;
  while (dug < count) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const here = bot.entity.position;
    const found = (await sense.find(ctx, { blocks: pattern, radius, count: 64 })).map((p) => new Vec3(p.x, p.y, p.z));
    const target = found
      .filter((p) => !skipped.has(p.toString()))
      .sort((a, b) => Math.abs(a.y - here.y) - Math.abs(b.y - here.y) || a.distanceTo(here) - b.distanceTo(here))[0];
    if (!target) {
      if (dug === 0) throw new Error(`no reachable ${JSON.stringify(pattern)} within ${radius} blocks`);
      ctx.log(`gather: no more ${JSON.stringify(pattern)} within ${radius} blocks`);
      break;
    }
    try {
      await walkToDig(ctx, target);
      await dig.dig(ctx, { at: target });
      dug++;
      await pickUpDrops(ctx, failedDrops);
    } catch (err) {
      skipped.add(target.toString());
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("needs one of")) throw err;
      ctx.log(`gather: skipping ${target}: ${message}`);
      if (skipped.size >= MAX_FAILURES) throw new Error(`gather gave up after ${skipped.size} unreachable blocks; last: ${message}`);
    }
  }
  const after = await inventory.list(ctx, {});
  const gained: Record<string, number> = {};
  for (const [name, n] of Object.entries(after)) {
    const delta = n - (before[name] ?? 0);
    if (delta > 0) gained[name] = delta;
  }
  return { dug, gained, skipped: skipped.size };
}

export const gather = defineRoutine(
  {
    name: "gatherer.gather",
    description: "Dig `count` blocks matching `blocks` ('*_log', 'stone', ['coal_ore','deepslate_coal_ore']) and pick up the drops, within `radius` (default 48). Equips the best tool and fails if a required tool is missing. `gained` is the inventory change, e.g. { oak_log: 4 }; `skipped` counts blocks it could not reach.",
    args: z.object({
      blocks: NamePattern,
      count: z.number().int().positive(),
      radius: z.number().positive().default(48),
    }),
    returns: z.object({ dug: z.number(), gained: z.record(z.string(), z.number()), skipped: z.number() }),
  },
  (ctx, { blocks, count, radius }) => gatherBlocks(ctx, blocks, count, radius),
);

export const collectDrops = defineRoutine(
  {
    name: "gatherer.collectDrops",
    description: "Walk over each position within `radius` (default 8) where dropped items lie, once, to pick them up. Returns { reached, unreachable }: how many such positions it reached (several stacks in one block count once) and the positions it could not reach.",
    args: z.object({ radius: z.number().positive().default(8) }),
    returns: z.object({ reached: z.number(), unreachable: z.array(Point) }),
  },
  (ctx, { radius }) => pickUpDrops(ctx, new Set(), radius),
);
