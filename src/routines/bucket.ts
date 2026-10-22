// The bucket routines: scooping up a water or lava source, pouring a bucket out.
import { type Block, defineRoutine, goals, isAir, Point, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Fill a bucket from a water or lava source, and pour it out.";
export const uses = [] as const;

// Survival players interact with blocks up to 4.5 blocks from the eyes.
const BLOCK_REACH = 4.5;
const FLUIDS = ["water", "lava"] as const;
const SOURCE_LIMIT = 3;

// Neighbors to pour against, the floor first. A bucket empties onto the face the player looks at.
const NEIGHBORS = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

/** The index of the block face `direction` points out of, as `blockAtCursor` reports it: -y 0, +y 1, -z 2, +z 3, -x 4, +x 5. */
export function faceIndex(direction: Vec3): number {
  if (direction.y !== 0) return direction.y < 0 ? 0 : 1;
  if (direction.z !== 0) return direction.z < 0 ? 2 : 3;
  return direction.x < 0 ? 4 : 5;
}

/** True for a water or lava block at full depth: the only fluid a bucket takes. Flowing fluid has a level above 0. */
export function isSource(block: Pick<Block, "name" | "getProperties">, fluid: string): boolean {
  return block.name === fluid && Number(block.getProperties().level ?? 0) === 0;
}

function eyes(ctx: RoutineContext): Vec3 {
  return ctx.bot.entity.position.offset(0, ctx.bot.entity.height * 0.9, 0);
}

/** Walks until `pos` is within block reach, and off `pos` itself. */
async function reach(ctx: RoutineContext, pos: Vec3): Promise<void> {
  const { bot } = ctx;
  if (eyes(ctx).distanceTo(pos.offset(0.5, 0.5, 0.5)) > BLOCK_REACH) {
    await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), () => bot.pathfinder.setGoal(null));
  }
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.equals(pos.offset(0, 1, 0))) {
    await within(10_000, "pathfinding", bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1))), () =>
      bot.pathfinder.setGoal(null),
    );
  }
}

function countOf(ctx: RoutineContext, name: string): number {
  return ctx.bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + i.count, 0);
}

/** Waits up to `ms` for `done` to hold; true when it did. */
async function waitUntil(ctx: RoutineContext, ms: number, done: () => boolean): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (done()) return true;
    await ctx.sleep(100);
  }
  return done();
}

// Where on a source block to aim: just under its surface (a source is 8/9 of a block deep), the middle first.
const AIM_POINTS = [new Vec3(0.5, 0.85, 0.5), new Vec3(0.15, 0.85, 0.5), new Vec3(0.85, 0.85, 0.5), new Vec3(0.5, 0.85, 0.15), new Vec3(0.5, 0.85, 0.85), new Vec3(0.5, 0.4, 0.5)];

/** The first point of the block at `pos` that the eyes can see and reach, or null: a bucket takes a fluid only when the look ray reaches it before a solid block. */
function visiblePoint(ctx: RoutineContext, pos: Vec3): Vec3 | null {
  const from = eyes(ctx);
  for (const offset of AIM_POINTS) {
    const point = pos.plus(offset);
    const distance = from.distanceTo(point);
    if (distance > BLOCK_REACH) continue;
    if (!ctx.bot.world.raycast(from, point.minus(from).normalize(), distance)) return point;
  }
  return null;
}

/** Scoops the `fluid` source at `at`, or the nearest one within `radius`, with an empty bucket. Returns the bucket it filled and the source's position. */
async function fillBucket(ctx: RoutineContext, fluid: (typeof FLUIDS)[number], at: Vec3 | undefined, radius: number) {
  const { bot } = ctx;
  const empty = bot.inventory.items().find((i) => i.name === "bucket");
  if (!empty) throw new Error("no empty bucket in inventory");
  const filled = `${fluid}_bucket`;
  let candidates: Vec3[];
  if (at) {
    const block = bot.blockAt(at);
    if (!block) throw new Error(`${at} is not loaded`);
    if (!isSource(block, fluid)) throw new Error(`${block.name} at ${at} is not a ${fluid} source`);
    candidates = [at];
  } else {
    const id = bot.registry.blocksByName[fluid]!.id;
    const here = bot.entity.position;
    candidates = bot
      .findBlocks({ matching: id, maxDistance: radius, count: 128 })
      .filter((p) => isSource(bot.blockAt(p)!, fluid))
      .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
      .slice(0, SOURCE_LIMIT);
    if (candidates.length === 0) throw new Error(`no ${fluid} source within ${radius} blocks`);
  }
  const errors: string[] = [];
  for (const source of candidates) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      await reach(ctx, source);
      await bot.equip(bot.inventory.items().find((i) => i.name === "bucket") ?? empty, "hand");
      const before = countOf(ctx, filled);
      const aim = visiblePoint(ctx, source);
      if (!aim) {
        errors.push(`${source}: no clear line of sight to it`);
        continue;
      }
      await bot.lookAt(aim, true);
      bot.activateItem();
      const took = await waitUntil(ctx, 1500, () => countOf(ctx, filled) > before);
      bot.deactivateItem();
      if (took) return { filled, at: source };
      errors.push(`${source}: the server did not fill the bucket (something may block the way to it)`);
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`could not fill a bucket with ${fluid}: ${errors.join("; ")}`);
}

/** Pours a full bucket at `at`. Returns false when that fluid source is already there. */
async function emptyBucket(ctx: RoutineContext, at: Vec3, fluid: (typeof FLUIDS)[number] | undefined): Promise<boolean> {
  const { bot } = ctx;
  const name = fluid ? `${fluid}_bucket` : ["water_bucket", "lava_bucket"].find((n) => countOf(ctx, n) > 0);
  if (!name || countOf(ctx, name) === 0) throw new Error(`no ${fluid ? `${fluid}_bucket` : "water_bucket or lava_bucket"} in inventory`);
  const poured = name.replace(/_bucket$/, "");
  const target = bot.blockAt(at);
  if (!target) throw new Error(`${at} is not loaded`);
  if (isSource(target, poured)) return false;
  if (!isAir(target) && target.boundingBox !== "empty") throw new Error(`${target.name} at ${at} is solid: dig it first`);

  await reach(ctx, at);
  await bot.equip(bot.inventory.items().find((i) => i.name === name)!, "hand");
  // Pour onto a face of a solid neighbor: the server places the fluid in the block beyond that face.
  const faces = NEIGHBORS.map((d) => ({ d, ref: bot.blockAt(at.plus(d)) }))
    .filter((c): c is { d: Vec3; ref: Block } => c.ref?.boundingBox === "block")
    .map((c) => ({ ...c, point: at.offset(0.5, 0.5, 0.5).plus(c.d.scaled(0.5)) }))
    .sort((a, b) => a.point.distanceTo(eyes(ctx)) - b.point.distanceTo(eyes(ctx)));
  for (const { d, ref, point } of faces) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await bot.lookAt(point, true);
    const seen = bot.blockAtCursor(BLOCK_REACH) as (Block & { face?: number }) | null;
    if (!seen || !seen.position.equals(ref.position) || seen.face !== faceIndex(d.scaled(-1))) continue;
    bot.activateItem();
    // Flowing water or lava is not a pour: the block must end up as a full source.
    const placed = await waitUntil(ctx, 1500, () => {
      const now = bot.blockAt(at);
      return now !== null && isSource(now, poured);
    });
    bot.deactivateItem();
    if (placed) return true;
  }
  throw new Error(`could not pour ${name} at ${at}: no solid face next to it in view`);
}

export const fill = defineRoutine(
  {
    name: "bucket.fill",
    description: "Fill an empty bucket from a `fluid` ('water' or 'lava') source: the one at `at` ({x,y,z} or [x,y,z]), or the nearest within `radius` (default 16). Walks within reach and tries up to 3 sources. Flowing fluid is not a source and cannot be taken. Returns { filled, at } — the bucket item now held, and the source's position.",
    args: z.object({ fluid: z.enum(FLUIDS), at: Position.optional(), radius: z.number().positive().default(16) }),
    returns: z.object({ filled: z.string(), at: Point }),
  },
  (ctx, { fluid, at, radius }) => fillBucket(ctx, fluid, at ? toVec3(at).floored() : undefined, radius),
);

export const empty = defineRoutine(
  {
    name: "bucket.empty",
    description: "Pour a full bucket so its fluid source lands in the block at `at` ({x,y,z} or [x,y,z]), which must be air or a non-solid block next to a solid one. `fluid` ('water' or 'lava') picks the bucket; default whichever the inventory holds, water first. Walks within reach. Water evaporates in the Nether. Returns true when it poured, false when that source was already there.",
    args: z.object({ at: Position, fluid: z.enum(FLUIDS).optional() }),
    returns: z.boolean(),
  },
  (ctx, { at, fluid }) => emptyBucket(ctx, toVec3(at).floored(), fluid),
);
