// The place routines: placing one block from the inventory, clearing what is in the way.
import { type Block, defineRoutine, type Entity, goals, isAir, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Place one block from the inventory, digging out a different solid block first.";
export const uses = [] as const;

/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const EYE_HEIGHT = 1.62;
/** Longest wait for the server's block updates to show a placement: the second half of a door arrives after the first. */
const SETTLE_MS = 1_000;
const SETTLE_STEP_MS = 50;

/** Candidate reference blocks around the target, in order of preference: below first. */
const NEIGHBORS = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/** The direction a bed's `facing` state points its head. */
const FACING: Record<string, Vec3> = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), west: new Vec3(-1, 0, 0), east: new Vec3(1, 0, 0) };

/** Registry entity types that are creatures; vanilla refuses a placement over any of them. */
const CREATURE_TYPES: Record<string, true> = { player: true, mob: true, hostile: true, animal: true, passive: true, ambient: true, water_creature: true, living: true };
/** Boats, rafts, and minecarts of every kind refuse a placement too. Items, experience orbs, and projectiles never do. */
const VEHICLE_NAME = /(?:boat|raft|minecart)$/;

/** True when the entity's box and the unit cube of `cell` share volume. Both are half-open, so a box that only touches the cube's side does not count. */
function overlaps(entity: Entity, cell: Vec3): boolean {
  const half = entity.width / 2;
  const { x, y, z } = entity.position;
  return x - half < cell.x + 1 && x + half > cell.x && y < cell.y + 1 && y + entity.height > cell.y && z - half < cell.z + 1 && z + half > cell.z;
}

const faceName = (toward: Vec3): string => (toward.y > 0 ? "top" : toward.y < 0 ? "bottom" : toward.x > 0 ? "east" : toward.x < 0 ? "west" : toward.z > 0 ? "south" : "north");

interface Face {
  reference: Block;
  /** From the reference block toward the target: what `bot.placeBlock` takes. */
  toward: Vec3;
  /** Eyes to the face's center. */
  distance: number;
  /** Nothing solid between the eyes and the face's center. */
  visible: boolean;
}

/** The first solid block on the segment from `from` to `to`, not counting the cell of `from` or `except`; null when the line of sight is clear. */
function firstSolidBetween(ctx: RoutineContext, from: Vec3, to: Vec3, except: Vec3): Block | null {
  const { bot } = ctx;
  const delta = to.minus(from);
  const length = delta.norm();
  if (length === 0) return null;
  // End a hair short, so a face center on a cell boundary reads as the cell the eyes are on.
  const end = from.plus(delta.scaled(1 - 1e-6 / length));
  const dir = end.minus(from);
  const cell = from.floored();
  const last = end.floored();
  const step = { x: Math.sign(dir.x), y: Math.sign(dir.y), z: Math.sign(dir.z) };
  const next = (axis: "x" | "y" | "z") => (step[axis] === 0 ? Infinity : (cell[axis] + (step[axis] > 0 ? 1 : 0) - from[axis]) / dir[axis]);
  const tMax = { x: next("x"), y: next("y"), z: next("z") };
  const tDelta = { x: step.x === 0 ? Infinity : Math.abs(1 / dir.x), y: step.y === 0 ? Infinity : Math.abs(1 / dir.y), z: step.z === 0 ? Infinity : Math.abs(1 / dir.z) };
  while (!cell.equals(last)) {
    const axis = tMax.x <= tMax.y && tMax.x <= tMax.z ? "x" : tMax.y <= tMax.z ? "y" : "z";
    cell[axis] += step[axis];
    tMax[axis] += tDelta[axis];
    if (cell.equals(except)) continue;
    const block = bot.blockAt(cell);
    if (block?.boundingBox === "block") return block;
  }
  return null;
}

/** Every solid neighbor of `pos` as a face to place against, nearest-first order not implied; visibility is only worked out for faces within reach. */
function facesAround(ctx: RoutineContext, pos: Vec3): Face[] {
  const { bot } = ctx;
  const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  const faces: Face[] = [];
  for (const side of NEIGHBORS) {
    const reference = bot.blockAt(pos.plus(side));
    if (reference?.boundingBox !== "block") continue;
    const center = pos.offset(0.5, 0.5, 0.5).plus(side.scaled(0.5));
    const distance = eyes.distanceTo(center);
    faces.push({ reference, toward: side.scaled(-1), distance, visible: distance <= REACH && firstSolidBetween(ctx, eyes, center, pos) === null });
  }
  return faces;
}

/** Faces within reach, those with a clear line of sight first, each group in `NEIGHBORS` order. An occluded face still works: the server does not need to see it. */
const usable = (faces: Face[]): Face[] => {
  const inReach = faces.filter((face) => face.distance <= REACH);
  return [...inReach.filter((face) => face.visible), ...inReach.filter((face) => !face.visible)];
};

/** The entities whose box shares volume with the block cell `pos`, that vanilla would refuse to place into. The bot is one of them when it stands in the cell. */
function blockers(ctx: RoutineContext, pos: Vec3): Entity[] {
  return Object.values(ctx.bot.entities).filter(
    (entity) => entity.isValid !== false && (CREATURE_TYPES[entity.type] === true || VEHICLE_NAME.test(entity.name ?? "")) && overlaps(entity, pos),
  );
}

/** Makes `pos` free of bodies: the bot steps out of it, any other creature or vehicle in it is an error. */
async function clearBodies(ctx: RoutineContext, pos: Vec3): Promise<void> {
  const { bot } = ctx;
  // Standing more than 2 blocks away leaves no overlap at all; 1 usually does, and keeps the bot closer.
  for (const range of [1, 2]) {
    const inside = blockers(ctx, pos);
    const other = inside.find((entity) => entity !== bot.entity);
    if (other) {
      const name = other.username ?? other.displayName ?? other.name ?? "an entity";
      throw new Error(`${name} is in ${pos}, so a block cannot be placed there. Wait until it moves or place somewhere else.`);
    }
    if (inside.length === 0) return;
    await within(10_000, "pathfinding", bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, range))), () => bot.pathfinder.setGoal(null));
  }
  if (blockers(ctx, pos).length > 0) throw new Error(`the bot could not step out of ${pos} to place there. Move away from it and call again.`);
}

/** Where the second half of a two-block block sits: above a lower door or tall plant half, ahead of a bed's foot. Null for a one-block block. */
function partnerOf(block: Block): Vec3 | null {
  const state = block.getProperties();
  if (state.half === "lower") return block.position.offset(0, 1, 0);
  if (state.part === "foot") return block.position.plus(FACING[String(state.facing)] ?? new Vec3(0, 0, 0));
  return null;
}

/** What is wrong with the cells `item` should hold after a placement, or null when every one holds it. `before` is what the target held beforehand. */
function shortfall(ctx: RoutineContext, pos: Vec3, wanted: string | undefined, before: Block): string | null {
  const { bot } = ctx;
  const here = bot.blockAt(pos);
  if (!here) return `${pos} is not loaded`;
  if (wanted === undefined ? here.type === before.type : here.name !== wanted) return `${pos} holds ${here.name}`;
  const partner = partnerOf(here);
  if (!partner) return null;
  const other = bot.blockAt(partner);
  if (other?.name !== here.name) return `its second cell ${partner} holds ${other?.name ?? "nothing loaded"}`;
  return null;
}

/** What a two-block item needs beyond its own cell, as a sentence naming the second cell's state; empty for a one-block item. */
function secondCellNote(ctx: RoutineContext, pos: Vec3, name: string): string {
  const { bot } = ctx;
  const states = bot.registry.blocksByName[name]?.states ?? [];
  const has = (state: string, value: string) => states.some((s) => s.name === state && s.values?.includes(value));
  let partner: Vec3;
  let part: string;
  if (has("half", "lower")) {
    partner = pos.offset(0, 1, 0);
    part = "upper half, the cell above";
  } else if (has("part", "foot")) {
    // A bed's head goes the way the bot faces when it places the foot.
    const { yaw } = bot.entity;
    partner = pos.plus(Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? new Vec3(-Math.sign(Math.sin(yaw)), 0, 0) : new Vec3(0, 0, -Math.sign(Math.cos(yaw))));
    part = "head, the cell it faces";
  } else return "";
  const other = bot.blockAt(partner);
  return ` ${name} has two cells and needs its ${part}, ${partner}, free: that cell holds ${other?.name ?? "nothing loaded"}.`;
}

/** Waits briefly for the server's block updates to show `item` in every cell it needs; returns what is still wrong, or null. */
async function settle(ctx: RoutineContext, pos: Vec3, wanted: string | undefined, before: Block): Promise<string | null> {
  let problem = shortfall(ctx, pos, wanted, before);
  for (let waited = 0; problem !== null && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await ctx.sleep(SETTLE_STEP_MS);
    problem = shortfall(ctx, pos, wanted, before);
  }
  return problem;
}

/**
 * Places `item` at `pos`, clearing a different solid block there first. Returns false when it
 * was already there. Needs a solid neighbor to place against, within reach.
 */
async function placeAt(ctx: RoutineContext, pos: Vec3, item: string): Promise<boolean> {
  const { bot } = ctx;
  const name = item.replace(/^minecraft:/, "");
  const current = bot.blockAt(pos);
  if (!current) throw new Error(`${pos} is not loaded`);
  if (current.name === name) return false;

  const walkNear = (range: number) =>
    within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), () => bot.pathfinder.setGoal(null));
  const eyes = () => bot.entity.position.offset(0, EYE_HEIGHT, 0);
  if (eyes().distanceTo(pos.offset(0.5, 0.5, 0.5)) > REACH) await walkNear(3);
  // Clear anything but air and fluids, including thin blocks like leaf_litter or short_grass
  // that have no collision box; the server does not always replace them.
  if (!isAir(current) && !/water|lava/.test(current.name) && current.diggable) {
    const tool = bot.pathfinder.bestHarvestTool(current);
    if (tool) await bot.equip(tool, "hand");
    await within(20_000, `clearing ${current.name}`, bot.dig(current), () => bot.stopDigging());
  }
  await clearBodies(ctx, pos);

  let faces = facesAround(ctx, pos);
  if (faces.length === 0) throw new Error(`nothing solid next to ${pos} to place against. Place a block beside, below, or above it first.`);
  if (usable(faces).length === 0) {
    await walkNear(2);
    // The walk can end inside the target cell.
    await clearBodies(ctx, pos);
    faces = facesAround(ctx, pos);
  }
  const [face] = usable(faces);
  if (!face) {
    const nearest = faces.reduce((a, b) => (b.distance < a.distance ? b : a));
    throw new Error(
      `no block next to ${pos} has a face within ${REACH} blocks of the bot's eyes, even after walking closer: the nearest is ${nearest.reference.name} at ${nearest.reference.position}, its ${faceName(nearest.toward)} face ${nearest.distance.toFixed(1)} blocks away. Move next to ${pos} (move.to) and call again.`,
    );
  }

  const stack = bot.inventory.items().find((i) => i.name === name);
  if (!stack) throw new Error(`no ${name} in inventory`);
  await bot.equip(stack, "hand");
  const before = bot.blockAt(pos);
  if (!before) throw new Error(`${pos} is not loaded`);
  const wanted = bot.registry.blocksByName[name]?.name;
  const where = `${name} at ${pos} against ${face.reference.name} at ${face.reference.position}, its ${faceName(face.toward)} face, ${face.distance.toFixed(1)} blocks from the eyes`;
  try {
    await bot.placeBlock(face.reference, face.toward);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`could not place ${where}: ${cause}.${secondCellNote(ctx, pos, name)} Check that the cell and any cell the block also occupies are free and that the reference block can be placed against.`);
  }
  const problem = await settle(ctx, pos, wanted, before);
  if (problem !== null) {
    throw new Error(`placed ${where}, but ${problem}, not ${name}.${secondCellNote(ctx, pos, name)} Free the cells the block needs and call again.`);
  }
  return true;
}

export const place = defineRoutine(
  {
    name: "place.place",
    description:
      "Place one block of `item` at `at` ({x,y,z} or [x,y,z]), walking close and digging out a different solid block first. Needs a solid neighbor to place against within 4.5 blocks of the eyes (it walks closer once). The bot steps out if it stands in the cell; a creature, player, boat or minecart in the cell is an error, a dropped item is not. Throws, naming the cause, when the block did not end up in every cell it needs (a door needs the cell above free, a bed the cell ahead). Returns false if the block was already there, true once it is in place.",
    args: z.object({ at: Position, item: z.string().min(1) }),
    returns: z.boolean(),
  },
  (ctx, { at, item }) => placeAt(ctx, toVec3(at).floored(), item),
);
