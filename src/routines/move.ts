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

type PathStatus = "success" | "partial" | "noPath" | "timeout";

/**
 * Listens for how the pathfinder ends `goal`. Its `goto` resolves on any empty path, also one found while
 * the search goes on ('partial'); the search then continues and the player may yet walk. `afterGoto()`,
 * called once `goto` has settled, waits for that search to end. It settles with "reached" when the
 * pathfinder reported the goal reached, or with the status that ended the search without it: "noPath" or
 * "timeout" (`goto` rejects on those when a partial path came with them), or "success" with an empty path.
 * It rejects as `goto` does when the path is stopped or the goal is replaced. A `goto` that settled with
 * no path update at all (a stub) counts as ended where the player stands.
 */
function watchPathEnd(bot: RoutineContext["bot"], goal: object): { afterGoto: () => Promise<"reached" | PathStatus | undefined>; stop: () => void } {
  const end = Promise.withResolvers<"reached" | PathStatus>();
  end.promise.catch(() => {}); // while `goto` runs, it reports the same failures
  let outcome: "reached" | PathStatus | undefined;
  let searching = false;
  const finish = (how: "reached" | PathStatus) => {
    outcome ??= how;
    end.resolve(how);
  };
  const onReached = (reached: unknown) => {
    if (reached === goal) finish("reached");
  };
  const onUpdate = ({ status, path }: { status: PathStatus; path: unknown[] }) => {
    searching = status === "partial" && path.length === 0;
    if (status === "noPath" || status === "timeout" || (status === "success" && path.length === 0)) finish(status);
  };
  const onStop = () => end.reject(new Error("Path was stopped before it could be completed! Thus, the desired goal was not reached."));
  const onGoal = (next: unknown) => {
    if (next !== goal) end.reject(new Error("The goal was changed before it could be completed!"));
  };
  bot.on("goal_reached", onReached);
  bot.on("path_update", onUpdate);
  bot.on("path_stop", onStop);
  bot.on("goal_updated", onGoal);
  return {
    afterGoto: () => (outcome === undefined && searching ? end.promise : Promise.resolve(outcome)),
    stop: () => {
      bot.off("goal_reached", onReached);
      bot.off("path_update", onUpdate);
      bot.off("path_stop", onStop);
      bot.off("goal_updated", onGoal);
    },
  };
}

/**
 * Runs a pathfinder goal with a time limit and a progress watchdog. When the executor keeps resetting
 * with "stuck", retries without diagonal moves: the planner allows diagonal steps up out of a pit that
 * clip a tall block at the corner, and the executor then replans the same failing step forever.
 * When the pathfinder ends without reporting the goal reached (no path, the search timed out, or an empty
 * path), the player's position is checked against the goal. Pathfinding is stopped on every failure.
 */
async function pathTo(ctx: RoutineContext, goal: InstanceType<typeof goals.GoalNear>, timeoutMs: number): Promise<void> {
  const { bot } = ctx;
  const normal = bot.pathfinder.movements;
  const target = new Vec3(goal.x, goal.y, goal.z);
  let stuck = 0;
  const onReset = (reason: string) => {
    if (reason !== "stuck" || ++stuck !== STUCK_RESETS_BEFORE_FALLBACK) return;
    const straight = new Movements(bot);
    straight.getMoveDiagonal = () => {};
    ctx.log("pathfinding: stuck on a diagonal step; retrying without diagonal moves");
    bot.pathfinder.setMovements(straight);
  };
  bot.on("path_reset", onReset);
  const end = watchPathEnd(bot, goal);
  const watch = watchProgress(bot, target);
  let ended: "reached" | PathStatus | undefined;
  try {
    // `goto` rejects a search that ended without the goal ("NoPath", "Timeout"); the watcher holds its status.
    const walk = bot.pathfinder.goto(goal).then(end.afterGoto, (err: unknown) =>
      err instanceof Error && (err.name === "NoPath" || err.name === "Timeout") ? end.afterGoto() : Promise.reject(err),
    );
    ended = await within(timeoutMs, "pathfinding", Promise.race([walk, watch.stalled]), () => bot.pathfinder.setGoal(null));
  } finally {
    watch.stop();
    end.stop();
    bot.off("path_reset", onReset);
    if (bot.pathfinder.movements !== normal) bot.pathfinder.setMovements(normal);
    if (ended !== "reached" && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
  }
  if (ended === "reached") return;
  const feet = bot.entity.position.floored();
  // As the pathfinder's own end-of-path check, the cell above the feet also counts (for standing on a half-height block).
  const near = (p: Vec3) => p.distanceSquared(target) <= goal.rangeSq;
  if (near(feet) || near(feet.offset(0, 1, 0))) return;
  const why = ended === "timeout" ? "the path search ran out of time" : "the pathfinder found no way there from here";
  throw new Error(`could not reach ${target}: stopped at ${feet}, ${feet.distanceTo(target).toFixed(1)} blocks away; ${why}`);
}

/** Walks within `range` blocks of `target` and returns where the player then stands. */
async function walkTo(ctx: RoutineContext, target: Vec3, range: number, timeoutMs: number): Promise<Vec3> {
  await pathTo(ctx, new goals.GoalNear(target.x, target.y, target.z, range), timeoutMs);
  return ctx.bot.entity.position.floored();
}

export const to = defineRoutine(
  {
    name: "move.to",
    description: "Walk within `range` blocks of `position` ({x,y,z} or [x,y,z]) and stop; the feet, or the block above them, within `range` counts as there. Throws, after stopping pathfinding, when `timeoutMs` passes, when 12 s go by with no progress (no movement, digging, or nearby block change: 'stuck at ...'), or when the pathfinder ends without a way within `range`, finding none or running out of search time ('could not reach ...'). Returns where the player stands once stopped.",
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
