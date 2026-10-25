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
type PathOutcome = "reached" | "noPath" | "timeout" | "ended";

/**
 * Watches the pathfinder's own report of how `goal` ends, in event order. Its `goto` resolves on any empty
 * path, also one found while the search goes on ('partial'), after which the search continues and the
 * player may yet walk — so `goto` resolving is not an outcome; only one that reports no path update at all
 * (a stub) ends the walk as "ended", where the player stands. Otherwise the walk ends as "reached" when
 * the pathfinder reports the goal reached, or with the status of the update that ended the search without
 * the goal: "noPath" or "timeout", or "ended" for a 'success' with an empty path (the player is then
 * checked against `range`). While updates still flow — any 'partial', or a path to walk — it keeps
 * waiting, bounded by the progress watchdog and `timeoutMs`. A goal replaced or a path stopped rejects as
 * `goto` does, one turn later, so a stop this walk triggers itself (the watchdog, the timeout) still names
 * itself; once another goal took over, later updates are not this goal's and are ignored.
 */
function watchPathEnd(bot: RoutineContext["bot"], goal: object): { outcome: Promise<PathOutcome>; gotoSettled: (err: unknown) => void; stop: () => void } {
  const done = Promise.withResolvers<PathOutcome>();
  done.promise.catch(() => {}); // a walk that ends another way never sees the rejection
  let sawUpdate = false;
  let foreign = false;
  const fail = (message: string) => queueMicrotask(() => done.reject(new Error(message)));
  const onReached = (reached: unknown) => {
    if (reached === goal) done.resolve("reached");
  };
  const onUpdate = ({ status, path }: { status: PathStatus; path: unknown[] }) => {
    sawUpdate = true;
    if (foreign) return;
    if (status === "noPath" || status === "timeout") done.resolve(status);
    else if (status === "success" && path.length === 0) done.resolve("ended");
  };
  const onStop = () => {
    foreign = true;
    fail("Path was stopped before it could be completed! Thus, the desired goal was not reached.");
  };
  const onGoal = (next: unknown) => {
    if (next === goal) return;
    foreign = true;
    fail("The goal was changed before it could be completed!");
  };
  bot.on("goal_reached", onReached);
  bot.on("path_update", onUpdate);
  bot.on("path_stop", onStop);
  bot.on("goal_updated", onGoal);
  return {
    outcome: done.promise,
    // `goto` reports the same ends through its promise: fold its 'NoPath'/'Timeout' into the statuses, let
    // its other failures (a replaced goal, a stopped path) through, and end only a goto that said nothing.
    gotoSettled: (err: unknown) => {
      if (err === undefined) {
        if (!sawUpdate) done.resolve("ended");
      } else if (err instanceof Error && err.name === "NoPath") done.resolve("noPath");
      else if (err instanceof Error && err.name === "Timeout") done.resolve("timeout");
      else done.reject(err);
    },
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
  let ended: PathOutcome | undefined;
  try {
    // `goto` resolving is not an outcome (it resolves on any empty path, also a partial one); the watcher
    // takes its failures, ends a goto that said nothing, and settles on the pathfinder's own report.
    void bot.pathfinder.goto(goal).then(
      () => end.gotoSettled(undefined),
      (err: unknown) => end.gotoSettled(err),
    );
    ended = await within(timeoutMs, "pathfinding", Promise.race([end.outcome, watch.stalled]), () => bot.pathfinder.setGoal(null));
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
