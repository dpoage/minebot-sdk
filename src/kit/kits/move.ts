// The move kit: walking with the pathfinder. The primitive every routine kit builds on.
import { z } from "zod";
import { action, defineKit, goals, type KitContext, Movements, Position, toVec3, type Vec3 } from "../kit.ts";

const DEFAULT_GOTO_TIMEOUT_MS = 60_000;
const STUCK_RESETS_BEFORE_FALLBACK = 2;

/**
 * Runs a pathfinder goal with a time limit. When the executor keeps resetting with "stuck",
 * retries without diagonal moves: the planner allows diagonal steps up out of a pit that clip
 * a tall block at the corner, and the executor then replans the same failing step forever.
 */
async function pathTo(ctx: KitContext, goal: InstanceType<typeof goals.Goal>, timeoutMs: number): Promise<void> {
  const { bot } = ctx;
  const normal = bot.pathfinder.movements;
  let stuck = 0;
  const onReset = (reason: string) => {
    if (reason !== "stuck" || ++stuck !== STUCK_RESETS_BEFORE_FALLBACK) return;
    const straight = new Movements(bot);
    straight.getMoveDiagonal = () => {};
    ctx.log("pathfinding: stuck on a diagonal step; retrying without diagonal moves");
    bot.pathfinder.setMovements(straight);
  };
  bot.on("path_reset", onReset);
  try {
    await ctx.within(timeoutMs, "pathfinding", bot.pathfinder.goto(goal), () => bot.pathfinder.setGoal(null));
  } finally {
    bot.off("path_reset", onReset);
    if (bot.pathfinder.movements !== normal) bot.pathfinder.setMovements(normal);
  }
}

/** Walks within `range` blocks of `target` and returns where the player then stands. */
export async function walkTo(ctx: KitContext, target: Vec3, range: number, timeoutMs: number): Promise<Vec3> {
  await pathTo(ctx, new goals.GoalNear(target.x, target.y, target.z, range), timeoutMs);
  return ctx.bot.entity.position.floored();
}

export const move = defineKit({
  name: "move",
  description: "Walk the player with the pathfinder, with a time limit and a fallback for stuck paths.",
  uses: [],
  actions: {
    to: action({
      doc: "Walk within `range` blocks of `position` ({x,y,z} or [x,y,z]) and stop. Gives up (and stops pathfinding) after `timeoutMs`. Returns where the player then stands.",
      args: z.object({
        position: Position,
        range: z.number().min(0).default(1),
        timeoutMs: z.number().int().positive().default(DEFAULT_GOTO_TIMEOUT_MS),
      }),
      run: (ctx, { position, range, timeoutMs }) => walkTo(ctx, toVec3(position).floored(), range, timeoutMs),
    }),
    stop: action({
      doc: "Stop pathfinding and clear the movement keys. Returns nothing.",
      args: z.object({}),
      run: (ctx) => {
        ctx.bot.pathfinder.setGoal(null);
        ctx.bot.clearControlStates();
      },
    }),
  },
});
