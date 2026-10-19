// Milestones and progress: graded from vanilla player statistics.
// The benchmark verifier grades from the server's stats file; a body grades from the statistics
// the server sends to the client, so progress works on any server, including ones we do not run.
// This module is pure: no Mineflayer I/O, so the verifier image can ship it alone.
import { z } from "zod";
import { nameMatcher } from "../mc/names.ts";

/**
 * How a milestone counts items.
 * - `gathered`: items taken from the world by digging; picking one up again does not count twice (see `grade`).
 * - `crafted`: items the player crafted.
 */
export const Via = z.enum(["gathered", "crafted"]);
export type Via = z.infer<typeof Via>;

export const Milestone = z.object({
  id: z.string(),
  description: z.string(),
  /** Item ids without namespace; `*` matches any run of characters, e.g. `*_log`. */
  obtained: z.array(z.string()).min(1),
  /** Default `gathered`. */
  via: Via.default("gathered"),
  /** `gathered` only: ids of the blocks that are dug to get the items. Default: the item ids. Needed when they differ, as for cobblestone, which stone drops. */
  blocks: z.array(z.string()).min(1).optional(),
  /** Total count needed across all matching items. */
  count: z.number().int().positive().default(1),
});
export type Milestone = z.infer<typeof Milestone>;

/** Ordered milestones. The set is reached when the last one is met. */
export const MilestoneSet = z.object({ milestones: z.array(Milestone).min(1) });
export type MilestoneSet = z.infer<typeof MilestoneSet>;

/** Statistics by category and id, both namespaced, as in a vanilla stats file: `stats["minecraft:crafted"]["minecraft:stick"]`. */
export const PlayerStats = z.object({
  stats: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});
export type PlayerStats = z.infer<typeof PlayerStats>;

export interface MilestoneResult {
  id: string;
  description: string;
  met: boolean;
  needed: number;
  obtained: number;
  /** The statistics the count rests on, e.g. `{ crafted: 1 }` or `{ mined, placed, picked_up, thrown }`. */
  detail: Record<string, number>;
}

export interface MilestoneProgress {
  /** 1 when the final milestone is met, else 0. */
  reward: number;
  /** Fraction of milestones met. */
  progress: number;
  milestones: MilestoneResult[];
}

/** Sum of the statistics in `category` whose id matches. */
function total(stats: PlayerStats | null, category: string, matches: (id: string) => boolean): number {
  let sum = 0;
  for (const [id, n] of Object.entries(stats?.stats[`minecraft:${category}`] ?? {})) if (matches(id)) sum += n;
  return sum;
}

/**
 * Grades from vanilla statistics. Statistics survive crafting and placing, so an intermediate
 * milestone stays met after its items are consumed.
 *
 * A pickup counter alone is not evidence: `picked_up` rises every time the player picks an item up,
 * so tossing an item and collecting it again, or dying and collecting the drops, would count twice.
 * Each way of obtaining items therefore has its own rule:
 * - `crafted`: the `crafted` statistic.
 * - `gathered`: the smaller of two counts. Blocks dug (`mined`) minus blocks placed (`used`) cannot be
 *   raised by picking items up again, and items picked up (`picked_up`) minus items thrown (`dropped`)
 *   cannot be raised by digging a block that was never collected.
 */
export function grade(spec: MilestoneSet, stats: PlayerStats | null): MilestoneProgress {
  const milestones = spec.milestones.map((m): MilestoneResult => {
    const items = nameMatcher(m.obtained);
    let obtained: number;
    let detail: Record<string, number>;
    if (m.via === "crafted") {
      obtained = total(stats, "crafted", items);
      detail = { crafted: obtained };
    } else {
      const blocks = nameMatcher(m.blocks ?? m.obtained);
      detail = {
        mined: total(stats, "mined", blocks),
        placed: total(stats, "used", blocks),
        picked_up: total(stats, "picked_up", items),
        thrown: total(stats, "dropped", items),
      };
      obtained = Math.min(Math.max(0, detail.mined! - detail.placed!), Math.max(0, detail.picked_up! - detail.thrown!));
    }
    return { id: m.id, description: m.description, met: obtained >= m.count, needed: m.count, obtained, detail };
  });
  const met = milestones.filter((m) => m.met).length;
  return { reward: milestones.at(-1)?.met ? 1 : 0, progress: met / milestones.length, milestones };
}
