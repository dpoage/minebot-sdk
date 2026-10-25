// The place routines: placing one block from the inventory, clearing what is in the way.
import { type Block, defineRoutine, type Entity, goals, isAir, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Place one block from the inventory, digging out a different solid block first.";
export const uses = [] as const;

/** Survival players interact with blocks up to 4.5 blocks from the eyes; faces this close are preferred. */
const REACH = 4.5;
/** The server accepts faces somewhat farther than `REACH` (5.3 and 5.6 were accepted, 6.2 refused); the bot walks only when no face is this close. */
const MAX_REACH = 5.0;
/** The server takes a placement against a block whose box is this close to the eyes (`REACH` plus 1 of slack), and ignores one farther. */
const SERVER_REACH = 5.5;
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

/** Registry entity types that are creatures; vanilla will not place a block with a collision box into any of them. */
const CREATURE_TYPES: Record<string, true> = { player: true, mob: true, hostile: true, animal: true, passive: true, ambient: true, water_creature: true, living: true };
/** Boats, rafts, and minecarts of every kind get in the way too. Items, experience orbs, and projectiles never do. */
const VEHICLE_NAME = /(?:boat|raft|minecart)$/;
/** Ageable mobs are half size as babies. */
const BABY_SCALE = 0.5;

/** Blocks that do something when used, opening a window or taking the held item, instead of letting a block be placed against them, unless the bot sneaks. */
const INTERACTABLE =
  /(?:^|_)(?:chest|barrel|furnace|smoker|shulker_box|crafting_table|crafter|door|trapdoor|fence_gate|button|lever|bed|anvil|enchanting_table|brewing_stand|hopper|dispenser|dropper|smithing_table|loom|cartography_table|grindstone|stonecutter|lectern|bell|note_block|repeater|comparator|daylight_detector|cake|beacon|jukebox|respawn_anchor|composter|chiseled_bookshelf|decorated_pot|campfire|command_block|structure_block|jigsaw|lodestone|beehive|bee_nest|vault|shelf|dragon_egg)$/;

/** True when the entity's box and the unit cube of `cell` share volume. Both are half-open, so a box that only touches the cube's side does not count. A baby's box is its own, not an adult's. */
function overlaps(ctx: RoutineContext, entity: Entity, cell: Vec3): boolean {
  const babyFlag = ctx.bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("baby") ?? -1;
  const metadata: readonly unknown[] = entity.metadata ?? [];
  const scale = babyFlag >= 0 && metadata[babyFlag] === true ? BABY_SCALE : 1;
  const half = (entity.width * scale) / 2;
  const { x, y, z } = entity.position;
  return x - half < cell.x + 1 && x + half > cell.x && y < cell.y + 1 && y + entity.height * scale > cell.y && z - half < cell.z + 1 && z + half > cell.z;
}

interface Face {
  reference: Block;
  /** From the reference block toward the target: what `bot.placeBlock` takes. */
  toward: Vec3;
  /** Eyes to the face's center. */
  distance: number;
  /** Nothing solid between the eyes and the face's center. */
  visible: boolean;
}

function describeFace(face: Face): string {
  const { x, y, z } = face.toward;
  const side = y > 0 ? "top" : y < 0 ? "bottom" : x > 0 ? "east" : x < 0 ? "west" : z > 0 ? "south" : "north";
  return `${face.reference.name} at ${face.reference.position}, its ${side} face, ${face.distance.toFixed(1)} blocks from the eyes`;
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

/** Every solid neighbor of `pos` as a face to place against, in `NEIGHBORS` order; visibility is only worked out for faces within `MAX_REACH`. */
function facesAround(ctx: RoutineContext, pos: Vec3): Face[] {
  const { bot } = ctx;
  const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  const faces: Face[] = [];
  for (const side of NEIGHBORS) {
    const reference = bot.blockAt(pos.plus(side));
    if (reference?.boundingBox !== "block") continue;
    const center = pos.offset(0.5, 0.5, 0.5).plus(side.scaled(0.5));
    const distance = eyes.distanceTo(center);
    faces.push({ reference, toward: side.scaled(-1), distance, visible: distance <= MAX_REACH && firstSolidBetween(ctx, eyes, center, pos) === null });
  }
  return faces;
}

/**
 * Faces within `MAX_REACH`, best first: a block that does nothing when used before one that opens a window or takes the item,
 * then those within `REACH`, then those with a clear line of sight (an occluded face still works: the server does not need to see it),
 * then `NEIGHBORS` order.
 */
function usable(faces: Face[]): Face[] {
  const rank = (face: Face) => (INTERACTABLE.test(face.reference.name) ? 4 : 0) + (face.distance > REACH ? 2 : 0) + (face.visible ? 0 : 1);
  return faces.filter((face) => face.distance <= MAX_REACH).sort((a, b) => rank(a) - rank(b));
}

/** The blocks `name` may turn into when placed: itself, its wall variants (wall_torch, oak_wall_sign, ...), a bamboo sapling. Null for an item with no block of its own name (wheat_seeds, redstone): then any change of the cell counts. */
function placedNames(ctx: RoutineContext, name: string): Set<string> | null {
  const { registry } = ctx.bot;
  if (!registry.blocksByName[name]) return null;
  const names = new Set([name]);
  for (const block of registry.blocksArray) if (block.name.includes("wall_") && block.name.replace("wall_", "") === name) names.add(block.name);
  if (name === "bamboo") names.add("bamboo_sapling");
  return names;
}

/** Where the second half of a two-cell block sits: above a lower door or tall plant half, ahead of a bed's foot. Null for a one-cell block,
 * including a growing crop with a lower half (pitcher_crop), which fills the cell above only later. */
function partnerOf(block: Block): Vec3 | null {
  const state = block.getProperties();
  if (state.half === "lower" && !("age" in state)) return block.position.offset(0, 1, 0);
  if (state.part === "foot") return block.position.plus(FACING[String(state.facing)] ?? new Vec3(0, 0, 0));
  return null;
}

/** What is wrong with the cells `item` should hold after a placement, or null when every one holds it. `before` is what the target held beforehand. */
function shortfall(ctx: RoutineContext, pos: Vec3, wanted: Set<string> | null, before: Block): string | null {
  const { bot } = ctx;
  const here = bot.blockAt(pos);
  if (!here) return `${pos} is not loaded`;
  if (wanted === null ? here.type === before.type : !wanted.has(here.name)) return `${pos} holds ${here.name}`;
  const partner = partnerOf(here);
  if (!partner) return null;
  const other = bot.blockAt(partner);
  if (other?.name !== here.name) return `its second cell ${partner} holds ${other?.name ?? "nothing loaded"}`;
  return null;
}

/** The cell a two-cell block `name` also needs when placed at `pos`, and which part goes there; null for a one-cell block. */
function secondCell(ctx: RoutineContext, pos: Vec3, name: string): { cell: Vec3; part: string } | null {
  const { bot } = ctx;
  const states = bot.registry.blocksByName[name]?.states ?? [];
  const has = (state: string, value: string) => states.some((s) => s.name === state && s.values?.includes(value));
  if (has("half", "lower") && !states.some((s) => s.name === "age")) return { cell: pos.offset(0, 1, 0), part: "upper half, the cell above" };
  if (has("part", "foot")) {
    // A bed's head goes the way the bot faces when it places the foot.
    const { yaw } = bot.entity;
    const ahead = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? new Vec3(-Math.sign(Math.sin(yaw)), 0, 0) : new Vec3(0, 0, -Math.sign(Math.cos(yaw)));
    return { cell: pos.plus(ahead), part: "head, the cell it faces" };
  }
  return null;
}

/** What a two-cell item needs beyond its own cell, as a sentence naming the second cell's state; empty for a one-cell item. */
function secondCellNote(ctx: RoutineContext, pos: Vec3, name: string): string {
  const second = secondCell(ctx, pos, name);
  if (!second) return "";
  const other = ctx.bot.blockAt(second.cell);
  return ` ${name} has two cells and needs its ${second.part}, ${second.cell}, free: that cell holds ${other?.name ?? "nothing loaded"}.`;
}

/** After a refusal of a block with a collision box: the bodies in the cells `name` needs, as a sentence; empty when there are none. */
function bodiesNote(ctx: RoutineContext, pos: Vec3, name: string): string {
  const { bot } = ctx;
  const cells = [pos, ...[secondCell(ctx, pos, name)?.cell ?? []].flat()];
  const notes: string[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (entity.isValid === false || !(entity === bot.entity || CREATURE_TYPES[entity.type] === true || VEHICLE_NAME.test(entity.name ?? ""))) continue;
    const cell = cells.find((c) => overlaps(ctx, entity, c));
    if (!cell) continue;
    const who = entity === bot.entity ? "the bot itself" : (entity.username ?? entity.displayName ?? entity.name ?? "an entity");
    notes.push(`${who} is in ${cell}`);
  }
  if (notes.length === 0) return "";
  return ` ${notes.join(", ")}: ${name} has a collision box and cannot go where a body is. Wait until it moves (or move it away) and call again, or place somewhere else.`;
}

/** Steps the bot out of `pos` when its own box overlaps the cell. Only needed for a block with a collision box. */
async function stepOut(ctx: RoutineContext, pos: Vec3, name: string): Promise<void> {
  const { bot } = ctx;
  // Standing more than 2 blocks away leaves no overlap at all; 1 usually does, and keeps the bot closer.
  for (const range of [1, 2]) {
    if (!overlaps(ctx, bot.entity, pos)) return;
    try {
      await within(10_000, "pathfinding", bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, range))), () => bot.pathfinder.setGoal(null));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`the bot stands in ${pos} and could not step out of it to place ${name} there (${cause}). Move at least one block away from ${pos} (move.to) and call again, or place it somewhere else.`);
    }
  }
  if (overlaps(ctx, bot.entity, pos)) throw new Error(`the bot stands in ${pos} and could not step out of it to place ${name} there. Move at least one block away from ${pos} (move.to) and call again.`);
}

/** Waits briefly for the server's block updates to show `item` in every cell it needs; returns what is still wrong, or null. */
async function settle(ctx: RoutineContext, pos: Vec3, wanted: Set<string> | null, before: Block): Promise<string | null> {
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
  const wanted = placedNames(ctx, name);
  if (wanted?.has(current.name)) return false;

  // Torches, flowers, seeds, rails, and signs have no collision box: the server places them where a body is.
  const solid = bot.registry.blocksByName[name]?.boundingBox === "block";
  const nothingSolid = `nothing solid next to ${pos} to place against. Place a block beside, below, or above it first.`;
  let faces = facesAround(ctx, pos);
  if (faces.length === 0) throw new Error(nothingSolid);
  let walkEnd: Vec3 | null = null;
  if (usable(faces).length === 0) {
    const far = faces.reduce((a, b) => (b.distance < a.distance ? b : a));
    try {
      await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), () => bot.pathfinder.setGoal(null));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `could not walk close enough to place ${name} at ${pos}: ${cause}. The nearest face to place against is ${describeFace(far)}; it has to be within ${MAX_REACH}. Walk to a spot next to ${pos} first (move.to), building a way there if there is none, and call again.`,
      );
    }
    // The pathfinder can end a walk where it began, without an error, when it finds no way closer.
    walkEnd = bot.entity.position.floored();
    faces = facesAround(ctx, pos);
  }
  // Clear anything but air and fluids, including thin blocks like leaf_litter or short_grass
  // that have no collision box; the server does not always replace them.
  if (!isAir(current) && !/water|lava/.test(current.name) && current.diggable) {
    const tool = bot.pathfinder.bestHarvestTool(current);
    if (tool) await bot.equip(tool, "hand");
    await within(20_000, `clearing ${current.name}`, bot.dig(current), () => bot.stopDigging());
  }
  if (solid) {
    await stepOut(ctx, pos, name);
    faces = facesAround(ctx, pos);
  }
  if (faces.length === 0) throw new Error(nothingSolid);
  // With no face within MAX_REACH the nearest is still tried, if its block is within SERVER_REACH.
  const [face = faces.reduce((a, b) => (b.distance < a.distance ? b : a))] = usable(faces);
  if (face.distance > MAX_REACH) {
    const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    const box = face.reference.position;
    const closest = new Vec3(Math.min(Math.max(eyes.x, box.x), box.x + 1), Math.min(Math.max(eyes.y, box.y), box.y + 1), Math.min(Math.max(eyes.z, box.z), box.z + 1));
    if (eyes.distanceTo(closest) > SERVER_REACH) {
      throw new Error(
        `no block next to ${pos} has a face within ${MAX_REACH} blocks of the bot's eyes${walkEnd ? `, and the walk toward it ended at ${walkEnd}` : ""}: the nearest is ${describeFace(face)}. Walk next to ${pos} (move.to), building a way there if there is none, and call again.`,
      );
    }
  }
  const tooFar = face.distance > MAX_REACH ? ` That face is more than ${MAX_REACH} blocks from the eyes: move next to ${pos} (move.to) and call again.` : "";

  const stack = bot.inventory.items().find((i) => i.name === name);
  if (!stack) throw new Error(`no ${name} in inventory`);
  await bot.equip(stack, "hand");
  const heldSlot = bot.heldItem?.slot ?? -1;
  const heldCount = bot.heldItem?.count;
  const before = bot.blockAt(pos);
  if (!before) throw new Error(`${pos} is not loaded`);
  const where = `${name} at ${pos} against ${describeFace(face)}`;
  // Used without sneaking, a crafting table or chest opens its window instead of taking the block.
  const sneak = INTERACTABLE.test(face.reference.name);
  try {
    if (sneak) bot.setControlState("sneak", true);
    await bot.placeBlock(face.reference, face.toward);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not place ${where}: ${cause}.${secondCellNote(ctx, pos, name)}${solid ? bodiesNote(ctx, pos, name) : ""}${tooFar} Check that the cell and any cell the block also occupies are free and that the reference block can be placed against.`,
    );
  } finally {
    if (sneak) bot.setControlState("sneak", false);
  }
  const problem = await settle(ctx, pos, wanted, before);
  if (problem !== null) {
    throw new Error(`placed ${where}, but ${problem}, not ${name}.${secondCellNote(ctx, pos, name)}${solid ? bodiesNote(ctx, pos, name) : ""}${tooFar} Free the cells the block needs and call again.`);
  }
  // The server takes the item from the hand a moment after the block shows. Until the inventory says so, a next call
  // could pick this stack again, now empty on the server, and place nothing.
  for (let waited = 0; bot.game.gameMode !== "creative" && bot.inventory.slots[heldSlot]?.count === heldCount && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await ctx.sleep(SETTLE_STEP_MS);
  }
  return true;
}

export const place = defineRoutine(
  {
    name: "place.place",
    description:
      "Place one block of `item` at `at` ({x,y,z} or [x,y,z]), digging out a different solid block first. Needs a solid neighbor to place against; it walks closer only when no neighbor's face is within 5 blocks of the eyes, and sneaks when the only neighbors are blocks like a crafting table or chest. The bot steps out of the cell first for a block with a collision box; nothing is refused up front for other bodies. Throws, naming the cause, when the block did not end up in every cell it needs: a creature, player, boat or minecart in the way, a door's cell above or a bed's cell ahead not free. Returns false if the block was already there, true once it is in place (a torch or sign that went on a wall counts).",
    args: z.object({ at: Position, item: z.string().min(1) }),
    returns: z.boolean(),
  },
  (ctx, { at, item }) => placeAt(ctx, toVec3(at).floored(), item),
);
