// Grading of what statistics cannot show: the contents of containers, the server's clock, and where the player stands.
// A task lists these as `checks` next to its milestones (see milestones.ts). The snapshot (snapshot.ts) takes the world
// facts from the server's own files and RCON after the agent is done, so a check reads ground truth, not the body.
// This module is pure, so the verifier image ships it with the grading code.
import { z } from "zod";
import { nameMatcher } from "../../src/mc/names.ts";
import { grade, type MilestoneResult, type MilestoneSet, type PlayerStats } from "../../src/milestones/milestones.ts";

/** Ticks in one Minecraft day: the length of the overworld clock's cycle. */
export const DAY_TICKS = 24_000;

/** A block that holds items, as the server saved it. */
export const ContainerFact = z.object({
  /** The block, without namespace: `chest`. */
  block: z.string(),
  position: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  /** Totals by item, without namespace. */
  items: z.record(z.string(), z.number().int().nonnegative()),
});
export type ContainerFact = z.infer<typeof ContainerFact>;

const WorldSnapshot = z.object({
  /** The overworld clock in ticks (`/time query time`). Sleeping advances it, like waiting does. */
  clock: z.number().int().nonnegative(),
  /** Where the graded player is, or null when the server has no such player online. */
  player: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
  /** Every block entity with an inventory in the chunks the server has saved. */
  containers: z.array(ContainerFact),
});

/**
 * What the snapshot read from the server: `/var/log/grading/world.json`. In a task with several steps the grader keeps the grading
 * directory between steps, so each snapshot carries the one before it (`previous`) and a check can compare a step with the step before.
 */
export const WorldFacts = WorldSnapshot.extend({ previous: WorldSnapshot.nullable().default(null) });
export type WorldFacts = z.infer<typeof WorldFacts>;
export type WorldSnapshot = z.infer<typeof WorldSnapshot>;

const CONTAINER_BLOCKS = ["chest", "trapped_chest"];
const checkBase = { id: z.string(), description: z.string() };

export const Check = z.discriminatedUnion("type", [
  z.object({
    ...checkBase,
    type: z.literal("stored"),
    /** Item ids without namespace; `*` matches any run of characters. */
    items: z.array(z.string()).min(1),
    /** The container blocks that count. Default: chests. */
    containers: z.array(z.string()).min(1).default(CONTAINER_BLOCKS),
    /** The matching items in all counted containers together. At least one counted container must exist. */
    min: z.number().int().positive(),
  }),
  /**
   * Containers that held at least `held` of the items at the previous snapshot (the step before) hold at most `max` of them now.
   * Only a container that was recorded as full counts, and it has to still be there at the same position: an empty chest
   * that was never filled, or a chest that was broken, does not satisfy it. Needs a task with several steps.
   */
  z.object({
    ...checkBase,
    type: z.literal("withdrawn"),
    items: z.array(z.string()).min(1),
    containers: z.array(z.string()).min(1).default(CONTAINER_BLOCKS),
    held: z.number().int().positive(),
    max: z.number().int().nonnegative(),
  }),
  /** The overworld clock has passed the end of night `nights`: it is at least `nights` days old. */
  z.object({ ...checkBase, type: z.literal("nights"), nights: z.number().int().positive() }),
  /** The player died at most `max` times. */
  z.object({ ...checkBase, type: z.literal("deaths"), max: z.number().int().nonnegative() }),
  /** The player stands at least `min` blocks (horizontally) from every counted container. At least one must exist. */
  z.object({
    ...checkBase,
    type: z.literal("distance"),
    containers: z.array(z.string()).min(1).default(CONTAINER_BLOCKS),
    min: z.number().positive(),
  }),
]);
export type Check = z.infer<typeof Check>;
export type CheckInput = z.input<typeof Check>;

export interface CheckResult {
  id: string;
  description: string;
  met: boolean;
  obtained: number;
  /** What the count has to satisfy, e.g. `>= 16` or `<= 0`. */
  requirement: string;
  detail: Record<string, number | string>;
}

const NO_WORLD = "the snapshot has no world facts";

function containersOf(world: WorldSnapshot, blocks: readonly string[]): ContainerFact[] {
  return world.containers.filter((c) => blocks.includes(c.block));
}

/** The items that match, summed over the containers. */
function itemTotal(containers: readonly ContainerFact[], matches: (item: string) => boolean): number {
  let total = 0;
  for (const c of containers) for (const [item, n] of Object.entries(c.items)) if (matches(item)) total += n;
  return total;
}

function gradeCheck(check: Check, stats: PlayerStats | null, world: WorldFacts | null): CheckResult {
  const { id, description } = check;
  switch (check.type) {
    case "stored": {
      const requirement = `>= ${check.min}`;
      if (!world) return { id, description, met: false, obtained: 0, requirement, detail: { error: NO_WORLD } };
      const found = containersOf(world, check.containers);
      const obtained = itemTotal(found, nameMatcher(check.items));
      return { id, description, met: obtained >= check.min, obtained, requirement, detail: { containers: found.length } };
    }
    case "withdrawn": {
      const requirement = `<= ${check.max}`;
      if (!world) return { id, description, met: false, obtained: 0, requirement, detail: { error: NO_WORLD } };
      if (!world.previous) return { id, description, met: false, obtained: 0, requirement, detail: { error: "no snapshot of the step before" } };
      const matches = nameMatcher(check.items);
      const recorded = containersOf(world.previous, check.containers).filter((c) => itemTotal([c], matches) >= check.held);
      if (recorded.length === 0) return { id, description, met: false, obtained: 0, requirement, detail: { error: `no container held ${check.held} at the step before`, recorded: 0 } };
      const now = recorded.map((c) => containersOf(world, [c.block]).find((n) => n.position.every((v, i) => v === c.position[i])));
      const missing = now.filter((c) => c === undefined).length;
      const left = itemTotal(now.filter((c): c is ContainerFact => c !== undefined), matches);
      const met = missing === 0 && now.every((c) => itemTotal([c!], matches) <= check.max);
      return { id, description, met, obtained: left, requirement, detail: { recorded: recorded.length, missing } };
    }
    case "nights": {
      const requirement = `>= ${check.nights}`;
      if (!world) return { id, description, met: false, obtained: 0, requirement, detail: { error: NO_WORLD } };
      const obtained = Math.floor(world.clock / DAY_TICKS);
      return { id, description, met: obtained >= check.nights, obtained, requirement, detail: { clock: world.clock } };
    }
    case "deaths": {
      // The server writes the statistic after the first death only.
      const obtained = stats?.stats["minecraft:custom"]?.["minecraft:deaths"] ?? 0;
      return { id, description, met: obtained <= check.max, obtained, requirement: `<= ${check.max}`, detail: {} };
    }
    case "distance": {
      const requirement = `>= ${check.min}`;
      if (!world) return { id, description, met: false, obtained: 0, requirement, detail: { error: NO_WORLD } };
      const found = containersOf(world, check.containers);
      if (!world.player) return { id, description, met: false, obtained: 0, requirement, detail: { error: "the player is not online", containers: found.length } };
      if (found.length === 0) return { id, description, met: false, obtained: 0, requirement, detail: { error: "no container", containers: 0 } };
      const { x, z } = world.player;
      const obtained = Math.round(Math.min(...found.map((c) => Math.hypot(x - (c.position[0] + 0.5), z - (c.position[2] + 0.5)))));
      return { id, description, met: obtained >= check.min, obtained, requirement, detail: { containers: found.length } };
    }
  }
}

export interface TrialGrade {
  /** 1 when the last milestone and every check are met, else 0. */
  reward: number;
  /** Fraction of the milestones and checks that are met. */
  progress: number;
  milestones: MilestoneResult[];
  checks: CheckResult[];
}

/**
 * Grades a trial: the milestones from the statistics (`grade`) and the checks from the statistics and the world facts.
 * A task without milestones is graded by its checks alone. By default the reward needs the last milestone, which suits a chain whose
 * last item cannot be had without the rest. With `allRequired`, every milestone is needed: for a chain whose last item can be found
 * in the world (a looted iron ingot makes an iron pickaxe without any smelting).
 */
export function gradeTrial(
  spec: { milestones: MilestoneSet["milestones"]; checks: readonly Check[]; allRequired?: boolean },
  stats: PlayerStats | null,
  world: WorldFacts | null,
): TrialGrade {
  const milestones = spec.milestones.length > 0 ? grade({ milestones: spec.milestones }, stats) : { reward: 1, progress: 1, milestones: [] };
  const checks = spec.checks.map((check) => gradeCheck(check, stats, world));
  const total = milestones.milestones.length + checks.length;
  const met = milestones.milestones.filter((m) => m.met).length + checks.filter((c) => c.met).length;
  return {
    reward: (spec.allRequired ? milestones.milestones.every((m) => m.met) : milestones.reward === 1) && checks.every((c) => c.met) ? 1 : 0,
    progress: total === 0 ? 0 : met / total,
    milestones: milestones.milestones,
    checks,
  };
}
