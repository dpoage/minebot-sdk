// The move routines: walking with the pathfinder. The primitive every other built-in routine builds on.
import { defineRoutine, goals, Movements, Point, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Walk the player with the pathfinder, with a time limit and a fallback for stuck paths.";
export const uses = [] as const;

const DEFAULT_GOTO_TIMEOUT_MS = 60_000;
const STUCK_RESETS_BEFORE_FALLBACK = 2;
/** A walk with no progress for this long is stuck; the watchdog samples every `SAMPLE_MS`, so it fires within 12.5 s of the last progress. */
const NO_PROGRESS_MS = 12_000;
const SAMPLE_MS = 500;
/** Progress: the player moved this far, or a block changed within `NEAR_UPDATE_BLOCKS` of the eyes, or the player was digging at a sample. */
const PROGRESS_BLOCKS = 1;
const NEAR_UPDATE_BLOCKS = 6;
const EYE_HEIGHT = 1.62;

/** Rejects (and stops pathfinding) once the player has made no progress for `NO_PROGRESS_MS`; `stop` ends the watch. */
function watchProgress(bot: RoutineContext["bot"], target: Vec3): { stalled: Promise<never>; stop: () => void } {
  const stalled = Promise.withResolvers<never>();
  let anchor = bot.entity.position.clone();
  let progressAt = Date.now();
  const progress = () => {
    anchor = bot.entity.position.clone();
    progressAt = Date.now();
  };
  const onBlockUpdate = (_old: unknown, block: { position: Vec3 } | null) => {
    const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    if (block && block.position.offset(0.5, 0.5, 0.5).distanceTo(eyes) <= NEAR_UPDATE_BLOCKS) progress();
  };
  bot.on("blockUpdate", onBlockUpdate);
  const timer = setInterval(() => {
    if (bot.targetDigBlock || bot.entity.position.distanceTo(anchor) >= PROGRESS_BLOCKS) return progress();
    if (Date.now() - progressAt < NO_PROGRESS_MS) return;
    const feet = bot.entity.position.floored();
    bot.pathfinder.setGoal(null);
    stalled.reject(new Error(`stuck at ${feet}, ${feet.distanceTo(target).toFixed(1)} blocks from ${target}: no movement, digging, or nearby block change for ${NO_PROGRESS_MS / 1000} s`));
  }, SAMPLE_MS);
  return {
    stalled: stalled.promise,
    stop: () => {
      clearInterval(timer);
      bot.off("blockUpdate", onBlockUpdate);
    },
  };
}

/**
 * Runs a pathfinder goal with a time limit and a progress watchdog. When the executor keeps resetting
 * with "stuck", retries without diagonal moves: the planner allows diagonal steps up out of a pit that
 * clip a tall block at the corner, and the executor then replans the same failing step forever.
 * `goto` also resolves, without the goal reached, when the pathfinder finds an empty path; the player's
 * position is then checked against the goal.
 */
async function pathTo(ctx: RoutineContext, goal: InstanceType<typeof goals.GoalNear>, timeoutMs: number): Promise<void> {
  const { bot } = ctx;
  const normal = bot.pathfinder.movements;
  const target = new Vec3(goal.x, goal.y, goal.z);
  let stuck = 0;
  let arrived = false;
  const onReset = (reason: string) => {
    if (reason !== "stuck" || ++stuck !== STUCK_RESETS_BEFORE_FALLBACK) return;
    const straight = new Movements(bot);
    straight.getMoveDiagonal = () => {};
    ctx.log("pathfinding: stuck on a diagonal step; retrying without diagonal moves");
    bot.pathfinder.setMovements(straight);
  };
  const onArrived = (reached: unknown) => {
    if (reached === goal) arrived = true;
  };
  bot.on("path_reset", onReset);
  bot.on("goal_reached", onArrived);
  const watch = watchProgress(bot, target);
  try {
    await within(timeoutMs, "pathfinding", Promise.race([bot.pathfinder.goto(goal), watch.stalled]), () => bot.pathfinder.setGoal(null));
  } finally {
    watch.stop();
    bot.off("goal_reached", onArrived);
    bot.off("path_reset", onReset);
    if (bot.pathfinder.movements !== normal) bot.pathfinder.setMovements(normal);
  }
  if (arrived) return;
  const feet = bot.entity.position.floored();
  // As the pathfinder's own goal check: standing on a half-height block also counts the cell above the feet.
  const near = (p: Vec3) => p.distanceSquared(target) <= goal.rangeSq;
  if (!near(feet) && !near(feet.offset(0, 1, 0))) throw new Error(`could not reach ${target}: stopped at ${feet}, ${feet.distanceTo(target).toFixed(1)} blocks away`);
}

/** Walks within `range` blocks of `target` and returns where the player then stands. */
async function walkTo(ctx: RoutineContext, target: Vec3, range: number, timeoutMs: number): Promise<Vec3> {
  await pathTo(ctx, new goals.GoalNear(target.x, target.y, target.z, range), timeoutMs);
  return ctx.bot.entity.position.floored();
}

export const to = defineRoutine(
  {
    name: "move.to",
    description: "Walk within `range` blocks of `position` ({x,y,z} or [x,y,z]) and stop. Throws, after stopping pathfinding, when `timeoutMs` passes, when 12 s go by with no progress (no movement, digging, or nearby block change: 'stuck at ...'), or when the walk ends farther than `range` ('could not reach ...'). Returns where the player then stands.",
    args: z.object({
      position: Position,
      range: z.number().min(0).default(1),
      timeoutMs: z.number().int().positive().default(DEFAULT_GOTO_TIMEOUT_MS),
    }),
    returns: Point,
  },
  (ctx, { position, range, timeoutMs }) => walkTo(ctx, toVec3(position).floored(), range, timeoutMs),
);

export const stop = defineRoutine(
  {
    name: "move.stop",
    description: "Stop pathfinding and clear the movement keys.",
    args: z.object({}),
    returns: z.void(),
  },
  (ctx) => {
    ctx.bot.pathfinder.setGoal(null);
    ctx.bot.clearControlStates();
  },
);
