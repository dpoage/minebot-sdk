// The builder routines: build structures from blueprints, calling the place, dig and inventory primitives,
// and make blueprints (line, arc, fill, box, combine). The blueprint format lives here because it is these routines' argument and result.
import { defineRoutine, Point, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";
import * as dig from "minebot-sdk/routines/dig";
import * as move from "minebot-sdk/routines/move";
import * as place from "minebot-sdk/routines/place";
import * as inventory from "minebot-sdk/routines/inventory";

export const description =
  "Place blocks and build structures from blueprints, and make blueprints. Blueprints: { palette: { '#': 'oak_planks' }, layers: [layer, ...] }; layers go bottom to top, rows run along +z, characters along +x, '.' or space skips; the palette value 'air' digs the cell out. line, arc, fill, box and combine return a blueprint with its origin in world coordinates, which build and check take as they are.";
export const uses = ["move", "sense", "dig", "place", "inventory"] as const;

/**
 * A structure to build. `layers` go bottom to top. In each layer, rows run along +z and
 * characters along +x. `.` and space leave a position untouched.
 */
const Blueprint = z.object({
  palette: z.record(z.string().length(1), z.string().min(1)),
  layers: z.array(z.union([z.string(), z.array(z.string())])).min(1),
});
type Blueprint = z.infer<typeof Blueprint>;

interface BlueprintBlock {
  dx: number;
  dy: number;
  dz: number;
  block: string;
}

const SKIP = new Set([".", " "]);

/** Removes blank edge lines and common indentation, so layers can be written as template literals. */
function layerRows(layer: string | string[]): string[] {
  const lines = Array.isArray(layer) ? layer : layer.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  const rows = lines.slice(start, end);
  const indent = Math.min(...rows.filter((r) => r.trim() !== "").map((r) => r.length - r.trimStart().length));
  return rows.map((r) => r.slice(indent));
}

/** Every block a blueprint places, as offsets from its origin. */
export function blueprintBlocks(blueprint: Blueprint): BlueprintBlock[] {
  const blocks: BlueprintBlock[] = [];
  blueprint.layers.forEach((layer, dy) => {
    layerRows(layer).forEach((row, dz) => {
      [...row].forEach((ch, dx) => {
        if (SKIP.has(ch)) return;
        const block = blueprint.palette[ch];
        if (!block) throw new Error(`blueprint layer ${dy}, row ${dz}: character "${ch}" is not in the palette`);
        blocks.push({ dx, dy, dz, block: block.replace(/^minecraft:/, "") });
      });
    });
  });
  return blocks;
}

/** The palette value that means "dig this cell out"; it needs no material. */
const AIR = "air";

/** Block counts a blueprint needs, e.g. { oak_planks: 24 }; 'air' cells need nothing. */
export function blueprintMaterials(blueprint: Blueprint): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const { block } of blueprintBlocks(blueprint)) if (block !== AIR) totals[block] = (totals[block] ?? 0) + 1;
  return totals;
}

/** True for the blocks an 'air' cell accepts. */
const isClear = (name: string): boolean => name === AIR || name === "cave_air";
/**
 * True when the world already holds `block` at a target: for 'air', air or cave_air; otherwise the block in any form placing
 * its item gives (wall_torch for torch, oak_wall_sign for oak_sign, bamboo_sapling for bamboo), by place.place's own rule
 * `placedNames` — the one copy — so build and check accept exactly what place does.
 */
function holds(ctx: RoutineContext, actual: string | undefined, block: string): boolean {
  if (actual === undefined) return false;
  if (block === AIR) return isClear(actual);
  const names = place.placedNames(ctx, block);
  return names !== null && names.has(actual);
}

/** Survival players dig blocks up to 4.5 blocks from the eyes (the gatherer's dig reach, and the testing harness's). */
const DIG_REACH = 4.5;
const EYE_HEIGHT = 1.62;

/**
 * Digs out whatever is at `pos`. Returns false when it already was air. Walks within dig reach first (move.to, as the
 * gatherer walks to dig) and requires it: the pathfinder can end a walk where it began, without an error, and digging
 * past reach then marks the cell air on the client while the server never digs it, so no later re-read catches it.
 * Fluids and undiggable blocks fail naming the block. Whether the cell stays clear (sand or gravel above may fall in)
 * is for the caller to read once falling blocks have landed.
 */
async function clearCell(ctx: RoutineContext, pos: Vec3): Promise<boolean> {
  const { bot } = ctx;
  const block = bot.blockAt(pos);
  if (!block) throw new Error(`${pos} is not loaded`);
  if (isClear(block.name)) return false;
  if (block.name === "water" || block.name === "lava") throw new Error(`${block.name} at ${pos} cannot be dug out; place a block there first`);
  if (!block.diggable) throw new Error(`${block.name} at ${pos} cannot be dug`);
  const eyes = () => bot.entity.position.offset(0, EYE_HEIGHT, 0);
  const inReach = () => eyes().distanceTo(pos.offset(0.5, 0.5, 0.5)) <= DIG_REACH;
  if (!inReach()) {
    let walkFailed: unknown = null;
    try {
      await move.to(ctx, { position: pos, range: 3, timeoutMs: 45_000 });
    } catch (err) {
      walkFailed = err;
    }
    if (!inReach()) {
      if (walkFailed !== null && ctx.signal.aborted) throw walkFailed;
      const cause = walkFailed === null ? "" : ` (${walkFailed instanceof Error ? walkFailed.message : String(walkFailed)})`;
      throw new Error(
        `${block.name} at ${pos} is ${eyes().distanceTo(pos.offset(0.5, 0.5, 0.5)).toFixed(1)} blocks from the eyes, beyond the ${DIG_REACH}-block dig reach, and the walk toward it ended at ${bot.entity.position.floored()}${cause}. Walk next to ${pos} (move.to), building a way there if there is none, and build again.`,
      );
    }
    if (walkFailed !== null) ctx.log(`build: digging ${pos} from here, in reach though the walk failed: ${walkFailed instanceof Error ? walkFailed.message : String(walkFailed)}`);
  }
  if (block.boundingBox === "block") {
    await dig.dig(ctx, { at: pos });
  } else {
    // Thin blocks without collision (short_grass, torches) are not "solid" to dig.dig but are still in the way.
    await within(20_000, `clearing ${block.name}`, bot.dig(block), () => bot.stopDigging());
  }
  return true;
}

/** Blocks that fall when the block under them goes, and so refill a cell dug out below them. */
const FALLS = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|\w+_concrete_powder|(?:chipped_|damaged_)?anvil)$/;
/** How many times build digs out again the 'air' cells that falling blocks refilled. */
const REFILL_ROUNDS = 8;
/** Lava spreads one block in 30 ticks (1.5 s) in the overworld, water in 5: a cleared cell beside a fluid is read again after this long. */
const FLOW_MS = 2_000;

/**
 * The reasons the 'air' cells that do not hold air when build ends are failed for, by cell: read once falling blocks have landed and,
 * while a clear cell touches water or lava, every `FLOW_MS` until a wait changes nothing.
 */
async function stillFilled(ctx: RoutineContext, cells: readonly Vec3[]): Promise<Map<Vec3, string>> {
  const { bot } = ctx;
  const nameAt = (pos: Vec3) => bot.blockAt(pos)?.name ?? "an unloaded block";
  await settle(ctx, cells);
  for (let wait = 0; wait < 5; wait++) {
    const before = cells.map(nameAt).join();
    if (!cells.some((c) => isClear(nameAt(c)) && FACES.some((face) => /^(?:water|lava)$/.test(nameAt(c.plus(face)))))) break;
    await ctx.sleep(FLOW_MS);
    if (cells.map(nameAt).join() === before) break;
  }
  const reasons = new Map<Vec3, string>();
  for (const pos of cells) {
    const now = nameAt(pos);
    if (isClear(now)) continue;
    if (now === "water" || now === "lava") reasons.set(pos, `${now} flowed into ${pos} after it was cleared; place a block there first or clear the ${now}`);
    else if (FALLS.test(now)) reasons.set(pos, `${now} kept falling into ${pos} from above; clear the cells above it too (add them to the blueprint as 'air')`);
    else reasons.set(pos, `${pos} holds ${now} when the build ends`);
  }
  return reasons;
}

/**
 * Waits until sand or gravel set loose above `cells` has landed: a falling block is a falling_block
 * entity until it lands. Gives up waiting after 10 seconds; the caller reads the cells either way.
 */
async function settle(ctx: RoutineContext, cells: readonly Vec3[]): Promise<void> {
  const xs = cells.map((c) => c.x);
  const zs = cells.map((c) => c.z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const minY = Math.min(...cells.map((c) => c.y));
  // A block loses its support on one game tick and starts falling on the next one or two.
  await ctx.sleep(150);
  for (let waited = 0; waited < 10_000; waited += 100) {
    const falling = Object.values(ctx.bot.entities).some(
      (e) => e.name === "falling_block" && e.position.x >= minX - 1 && e.position.x < maxX + 2 && e.position.z >= minZ - 1 && e.position.z < maxZ + 2 && e.position.y >= minY - 1,
    );
    if (!falling) return;
    await ctx.sleep(100);
  }
}

/** The six cells a block can be placed against. */
const FACES = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

interface BuildResult {
  placed: number;
  alreadyCorrect: number;
  failed: { position: Vec3; block: string; reason: string }[];
}

type Target = { position: Vec3; block: string };

async function buildBlueprint(ctx: RoutineContext, blueprint: Blueprint, origin: Vec3, partial = false): Promise<BuildResult> {
  const { bot } = ctx;
  const targets: Target[] = blueprintBlocks(blueprint).map((b) => ({ position: origin.offset(b.dx, b.dy, b.dz), block: b.block }));
  const todo = targets.filter((t) => !holds(ctx, bot.blockAt(t.position)?.name, t.block));
  const needed: Record<string, number> = {};
  for (const t of todo) if (t.block !== AIR) needed[t.block] = (needed[t.block] ?? 0) + 1;
  const short = (
    await Promise.all(Object.entries(needed).map(async ([block, n]) => [block, n - (await inventory.count(ctx, { items: block }))] as const))
  ).filter(([, missing]) => missing > 0);
  if (short.length > 0 && !partial) {
    throw new Error(`missing materials: ${short.map(([b, n]) => `${b} x${n}`).join(", ")} (pass { partial: true } to build what you can)`);
  }
  // Every target ends in one of these: placed (this build put the block there or dug the cell out), failed (with the reason),
  // or neither: already correct, at the start or when its turn came.
  const placed = new Set<Target>();
  const failed = new Map<Target, string>();
  const attempt = async (t: Target, act: () => Promise<boolean>) => {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      if (await act()) placed.add(t);
    } catch (err) {
      failed.set(t, err instanceof Error ? err.message : String(err));
    }
  };
  const topDown = (a: Target, b: Target) => b.position.y - a.position.y || a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position);

  // 'air' cells first, top down: a column dug from the top has nothing left in it to fall into the cells below.
  const clears = targets.filter((t) => t.block === AIR);
  for (const t of todo.filter((t) => t.block === AIR).sort(topDown)) await attempt(t, () => clearCell(ctx, t.position));
  // Sand or gravel above the cells falls in once what held it up is dug; dig out what landed until the cells stay clear.
  if (placed.size > 0) {
    for (let round = 0; round < REFILL_ROUNDS; round++) {
      await settle(ctx, clears.map((t) => t.position));
      const refilled = clears.filter((t) => !failed.has(t) && !holds(ctx, bot.blockAt(t.position)?.name, AIR)).sort(topDown);
      if (refilled.length === 0) break;
      for (const t of refilled) await attempt(t, () => clearCell(ctx, t.position));
    }
  }

  // Then blocks, bottom layer first; within a layer, nearest first; a block whose neighbours are all air waits until one of them is placed (an arch's
  // top needs the blocks under it), and what nothing ever supports comes last and fails with place's own message.
  const blocks = todo.filter((t) => t.block !== AIR).sort((a, b) => a.position.y - b.position.y || a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  const ready = (t: Target) => FACES.some((face) => bot.blockAt(t.position.plus(face))?.boundingBox === "block");
  let rescan = true;
  while (blocks.length > 0) {
    let next = rescan ? blocks.findIndex(ready) : 0;
    if (next < 0) {
      next = 0;
      rescan = false;
    }
    const t = blocks.splice(next, 1)[0]!;
    await attempt(t, () => place.place(ctx, { at: t.position, item: t.block }));
    if (placed.has(t)) rescan = true;
  }

  // Last, every 'air' cell is read again once what this build set loose has settled: one that sand, gravel or a fluid filled is failed, naming it.
  const open = clears.filter((t) => !failed.has(t));
  if (placed.size > 0 && open.length > 0) {
    const reasons = await stillFilled(ctx, open.map((t) => t.position));
    for (const t of open) {
      const reason = reasons.get(t.position);
      if (reason !== undefined) failed.set(t, reason);
    }
  }

  const result: BuildResult = { placed: 0, alreadyCorrect: 0, failed: [] };
  for (const [t, reason] of failed) result.failed.push({ position: t.position, block: t.block, reason });
  for (const t of placed) if (!failed.has(t)) result.placed++;
  result.alreadyCorrect = targets.length - result.placed - result.failed.length;
  ctx.log(`build: placed ${result.placed}, already correct ${result.alreadyCorrect}, failed ${result.failed.length}`);
  return result;
}

interface BuildCheck {
  correct: number;
  total: number;
  mismatches: { position: Vec3; expected: string; actual: string }[];
}

function checkBuild(ctx: RoutineContext, blueprint: Blueprint, origin: Vec3): BuildCheck {
  const blocks = blueprintBlocks(blueprint);
  const mismatches: BuildCheck["mismatches"] = [];
  for (const b of blocks) {
    const position = origin.offset(b.dx, b.dy, b.dz);
    const actual = ctx.bot.blockAt(position)?.name ?? "unloaded";
    if (!holds(ctx, actual, b.block)) mismatches.push({ position, expected: b.block, actual });
  }
  return { correct: blocks.length - mismatches.length, total: blocks.length, mismatches: mismatches.slice(0, 20) };
}

export const materials = defineRoutine(
  {
    name: "builder.materials",
    description: "Block counts the `blueprint` needs, e.g. { oak_planks: 24 }. 'air' cells need none.",
    args: z.object({ blueprint: Blueprint }),
    returns: z.record(z.string(), z.number()),
  },
  (_, { blueprint }) => blueprintMaterials(blueprint),
);

export const build = defineRoutine(
  {
    name: "builder.build",
    description: "Build the `blueprint` with its first layer's first row's first character at `origin`; the result of line, arc, fill, box or combine is both at once: `await builder.build(ctx, await builder.box(ctx, {...}))`. Skips cells already correct. Digs out 'air' cells first, top down, and again when sand or gravel falls back in (they count as placed); a cell the bot cannot get within 4.5 blocks of the eyes to dig is failed, naming where the walk ended; then places blocks bottom-up, each once something solid touches it. Before returning it reads every 'air' cell again, after water or lava beside one has had time to flow: a cell that sand, gravel or a fluid filled is in failed, naming it. Fails up front on missing materials unless `partial`. Returns { placed, alreadyCorrect, failed }, each cell counted in exactly one.",
    args: z.object({
      blueprint: Blueprint,
      origin: Position,
      partial: z.boolean().default(false),
    }),
    returns: z.object({
      placed: z.number(),
      alreadyCorrect: z.number(),
      failed: z.array(z.object({ position: Point, block: z.string(), reason: z.string() })),
    }),
  },
  (ctx, { blueprint, origin, partial }) => buildBlueprint(ctx, blueprint, toVec3(origin).floored(), partial),
);

export const check = defineRoutine(
  {
    name: "builder.check",
    description: "Compare the world with the `blueprint` at `origin` (a shape's result is both): { correct, total, mismatches (first 20) }. An 'air' cell is correct when it holds air or cave_air; a block's cell also when it holds the form placing that block gives against a wall (wall_torch for torch, oak_wall_sign for oak_sign) or bamboo_sapling for bamboo.",
    args: z.object({ blueprint: Blueprint, origin: Position }),
    returns: z.object({
      correct: z.number(),
      total: z.number(),
      mismatches: z.array(z.object({ position: Point, expected: z.string(), actual: z.string() })),
    }),
  },
  (ctx, { blueprint, origin }) => checkBuild(ctx, blueprint, toVec3(origin).floored()),
);

// Shapes: routines that make a blueprint from a few numbers. Each returns { origin, blueprint } in world
// coordinates, which build, check and combine take as they are.

type Cell = readonly [number, number, number];

/** A blueprint with the world position of its first layer's first row's first character. */
const Placed = z.object({ origin: Point, blueprint: Blueprint });
type Placed = z.infer<typeof Placed>;

/** The most cells a shape's bounding box may hold: a mistyped coordinate would otherwise allocate gigabytes in the body. */
const MAX_VOLUME = 4_000_000;
/** The longest arc, in samples: keeps the integer arithmetic below exact. */
const MAX_ARC_STEPS = 50_000;

/**
 * Palette characters, most readable first. '.' and space skip a cell and '~' is air, so none of them is here.
 * Past the printable ASCII this runs through Latin letters: a blueprint made here has room for about 280 blocks.
 */
const GLYPHS = [...`#%&*+=@$?!^-_:;,/|<>()[]{}0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`];
for (let code = 0xc0; code <= 0x17f; code++) if (code !== 0xd7 && code !== 0xf7) GLYPHS.push(String.fromCharCode(code));

const cellOf = (p: Position): Cell => {
  const v = toVec3(p).floored();
  return [v.x, v.y, v.z];
};

/** Floor division, exact on integers below 2^53 (the quotient of floats can round across an integer). */
function floorDiv(n: number, d: number): number {
  const r = ((n % d) + d) % d;
  return (n - r) / d;
}

/** The blocks of a bounding box, painted cell by cell, and the blueprint they make. */
class Grid {
  readonly min: Cell;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  private readonly data: Uint16Array;
  /** Palette index (1-based; 0 is untouched) by block name. */
  private readonly ids = new Map<string, number>();

  constructor(min: Cell, max: Cell) {
    this.min = min;
    this.width = max[0] - min[0] + 1;
    this.height = max[1] - min[1] + 1;
    this.depth = max[2] - min[2] + 1;
    const volume = this.width * this.height * this.depth;
    if (volume > MAX_VOLUME) {
      throw new Error(`the shape spans ${this.width} x ${this.height} x ${this.depth} blocks (${volume.toLocaleString("en-US")} cells); the limit is ${MAX_VOLUME.toLocaleString("en-US")}. Check the coordinates; for a structure this large, build its parts separately, one builder.build each`);
    }
    this.data = new Uint16Array(volume);
  }

  paint(x: number, y: number, z: number, block: string): void {
    const name = block.replace(/^minecraft:/, "");
    let id = this.ids.get(name);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(name, id);
    }
    this.data[((y - this.min[1]) * this.depth + (z - this.min[2])) * this.width + (x - this.min[0])] = id;
  }

  /** The blueprint of what was painted: layers bottom to top, '.' where nothing was. Palette entries are the blocks that remain. */
  toPlaced(): Placed {
    const used = new Set(this.data);
    const palette: Record<string, string> = {};
    const glyphs: string[] = ["."];
    let next = 0;
    for (const [name, id] of this.ids) {
      if (!used.has(id)) {
        glyphs[id] = ".";
        continue;
      }
      const glyph = name === AIR ? "~" : GLYPHS[next++];
      if (glyph === undefined) throw new Error(`a blueprint made here holds at most ${GLYPHS.length} different blocks besides air; build the structure in parts`);
      glyphs[id] = glyph;
      palette[glyph] = name;
    }
    const layers: string[][] = [];
    let i = 0;
    for (let y = 0; y < this.height; y++) {
      const rows: string[] = [];
      for (let z = 0; z < this.depth; z++) {
        const row = new Array<string>(this.width);
        for (let x = 0; x < this.width; x++) row[x] = glyphs[this.data[i++]!]!;
        rows.push(row.join(""));
      }
      layers.push(rows);
    }
    return { origin: { x: this.min[0], y: this.min[1], z: this.min[2] }, blueprint: { palette, layers } };
  }
}

/** The lowest and highest corner of `cells` (at least one). */
function boundsOf(cells: readonly Cell[]): { min: Cell; max: Cell } {
  const min: [number, number, number] = [...cells[0]!];
  const max: [number, number, number] = [...cells[0]!];
  for (const c of cells) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, c[k]!);
      max[k] = Math.max(max[k]!, c[k]!);
    }
  }
  return { min, max };
}

/** A straight line of `block` between two cells: see `lineCells`. The line stays inside the cuboid of its ends, so the size is checked before any cell is made. */
function lineShape(a: Cell, b: Cell, block: string): Placed {
  const { min, max } = cuboid(a, b);
  const grid = new Grid(min, max);
  for (const [x, y, z] of lineCells(a, b)) grid.paint(x, y, z, block);
  return grid.toPlaced();
}

/** An arch of `block` between two cells that passes `rise` above their midpoint: see `arcCells`. Rise 0 is the straight line. */
function arcShape(a: Cell, b: Cell, rise: number, block: string): Placed {
  if (rise === 0) return lineShape(a, b, block);
  const cells = arcCells(a, b, rise);
  const { min, max } = boundsOf(cells);
  const grid = new Grid(min, max);
  for (const [x, y, z] of cells) grid.paint(x, y, z, block);
  return grid.toPlaced();
}

/**
 * The cells of a straight line, inclusive of both ends: 3D Bresenham from the lexicographically smaller
 * end (x, then y, then z), so the line is the same whichever end is `a`. The axis that changes most steps
 * by 1 each time; every other axis steps when its error, which starts at 2 * its change - the major
 * change, is above 0, and then pays 2 * the major change; each step adds 2 * its change.
 */
function lineCells(a: Cell, b: Cell): Cell[] {
  const [from, to] = (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) <= 0 ? [a, b] : [b, a];
  const delta = [0, 1, 2].map((k) => Math.abs(to[k]! - from[k]!));
  const sign = [0, 1, 2].map((k) => Math.sign(to[k]! - from[k]!));
  const major = delta[0]! >= delta[1]! && delta[0]! >= delta[2]! ? 0 : delta[1]! >= delta[2]! ? 1 : 2;
  const at = [...from];
  const error = delta.map((d) => 2 * d - delta[major]!);
  const cells: Cell[] = [[at[0]!, at[1]!, at[2]!]];
  for (let step = 0; step < delta[major]!; step++) {
    at[major]! += sign[major]!;
    for (let k = 0; k < 3; k++) {
      if (k === major) continue;
      if (error[k]! > 0) {
        at[k]! += sign[k]!;
        error[k]! -= 2 * delta[major]!;
      }
      error[k]! += 2 * delta[k]!;
    }
    cells.push([at[0]!, at[1]!, at[2]!]);
  }
  return cells;
}

/**
 * The cells joining two cells that are at most 1 apart on each axis, so that every step changes one axis
 * and a block can be placed against the one before it. The path is the same whichever cell comes first:
 * from the lower cell (by y, then x, then z) it changes x, then z, then y, so the upper cell stands on
 * the last block of the path. Returns the cells strictly between.
 */
function stairBetween(a: Cell, b: Cell): Cell[] {
  const [low, high] = (a[1] - b[1] || a[0] - b[0] || a[2] - b[2]) <= 0 ? [a, b] : [b, a];
  const at: [number, number, number] = [...low];
  const between: Cell[] = [];
  for (const k of [0, 2, 1]) {
    if (at[k] === high[k]) continue;
    at[k] = high[k]!;
    if (at[0] !== high[0] || at[1] !== high[1] || at[2] !== high[2]) between.push([...at]);
  }
  return between;
}

/**
 * The cells of the parabola through `from` and `to` that passes `rise` blocks above their
 * midpoint: x and z move evenly from one end to the other and y is the straight line between the ends
 * plus 4 * rise * t * (1 - t), sampled finely enough that no step moves more than one block on any
 * axis, and rounded half up in exact integer arithmetic so the arc is the same from either end. Where
 * two samples touch only at an edge or corner, the cells between them are added (see `stairBetween`),
 * so a block can be placed against the one before it and the arc stands in the air once its feet are down.
 * Rise must not be 0 (that is `lineCells`).
 */
function arcCells(from: Cell, to: Cell, rise: number): Cell[] {
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const span = Math.max(Math.abs(dx), Math.abs(dz));
  if (span === 0) {
    throw new Error("arc: `from` and `to` are in the same column (same x and z), so there is nothing to curve over; use builder.line for a vertical line, or move one end sideways");
  }
  // The steepest step is |dy| + 4 * |rise| over the span; an even count puts a sample on the apex.
  let steps = Math.max(span, Math.abs(dy) + 4 * Math.abs(rise));
  steps += steps % 2;
  if (steps > MAX_ARC_STEPS) throw new Error(`arc: a rise of ${rise} over ${span} blocks is too large; the limit is ${MAX_ARC_STEPS} steps of one block, so check the coordinates and the rise`);
  const cells: Cell[] = [];
  for (let i = 0; i <= steps; i++) {
    const cell: Cell = [
      from[0] + floorDiv(2 * dx * i + steps, 2 * steps),
      from[1] + floorDiv(2 * (dy * i * steps + 4 * rise * i * (steps - i)) + steps * steps, 2 * steps * steps),
      from[2] + floorDiv(2 * dz * i + steps, 2 * steps),
    ];
    const last = cells.at(-1);
    if (last) cells.push(...stairBetween(last, cell));
    cells.push(cell);
  }
  return cells;
}

/** The lowest and highest corner of the cuboid between two corners, in any order. */
function cuboid(a: Cell, b: Cell): { min: Cell; max: Cell } {
  return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
}

const SIDES = ["north", "south", "east", "west"] as const;

interface BoxOptions {
  wall: string;
  floor?: string | undefined;
  roof?: string | undefined;
  door?: { side: (typeof SIDES)[number]; block?: string | undefined } | undefined;
}

/** A hollow box: see `box`. Throws what the caller must change when the box cannot hold a room or the door cannot fit. */
function boxShape(a: Cell, b: Cell, { wall, floor, roof, door }: BoxOptions): Placed {
  const { min, max } = cuboid(a, b);
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const height = y1 - y0 + 1;
  const taken = [floor === undefined ? null : "a floor", roof === undefined ? null : "a roof"].filter((s) => s !== null);
  const interiorLow = floor === undefined ? y0 : y0 + 1;
  const interiorHigh = roof === undefined ? y1 : y1 - 1;
  if (interiorHigh - interiorLow + 1 < 2) {
    throw new Error(
      `box: y ${y0} to ${y1} is ${height} block${height === 1 ? "" : "s"} high${taken.length > 0 ? `, and ${taken.join(" and ")} use${taken.length === 1 ? "s" : ""} up ${taken.length} of those layers` : ""}, and a room needs 2 free layers to stand in. Make it taller (to.y ${y0 + taken.length + 1} or more)${taken.length > 0 ? " or leave out the floor or roof" : ""}; builder.fill makes a flat slab`,
    );
  }
  let doorX = 0;
  let doorZ = 0;
  if (door) {
    const along = (door.side === "north" || door.side === "south" ? x1 - x0 : z1 - z0) + 1;
    if (along < 3) {
      const axis = door.side === "north" || door.side === "south" ? "x" : "z";
      const fits = SIDES.filter((s) => ((s === "north" || s === "south" ? x1 - x0 : z1 - z0) + 1) >= 3);
      throw new Error(
        `box: the ${door.side} side is ${along} block${along === 1 ? "" : "s"} long and a door needs 3 (wall on both sides of it). Make the box wider along ${axis}${fits.length > 0 ? `, or put the door on the ${fits.join(" or ")} side` : ""}`,
      );
    }
    // The middle of the side; of the two middle blocks of an even side, the one with the lower coordinate.
    const middleX = x0 + Math.floor((x1 - x0) / 2);
    const middleZ = z0 + Math.floor((z1 - z0) / 2);
    doorX = door.side === "north" || door.side === "south" ? middleX : door.side === "east" ? x1 : x0;
    doorZ = door.side === "east" || door.side === "west" ? middleZ : door.side === "south" ? z1 : z0;
  }
  const doorY = interiorLow;
  const grid = new Grid(min, max);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (floor !== undefined && y === y0) grid.paint(x, y, z, floor);
        else if (roof !== undefined && y === y1) grid.paint(x, y, z, roof);
        else if (x > x0 && x < x1 && z > z0 && z < z1) grid.paint(x, y, z, AIR);
        else if (door && x === doorX && z === doorZ && (y === doorY || y === doorY + 1)) {
          // An open doorway, or the door block in the lower cell: its upper half is left to the door.
          if (door.block === undefined) grid.paint(x, y, z, AIR);
          else if (y === doorY) grid.paint(x, y, z, door.block);
        } else grid.paint(x, y, z, wall);
      }
    }
  }
  return grid.toPlaced();
}

/** The parts painted in order, later over earlier, on one grid from the lowest origin to the highest cell. */
function combineParts(parts: readonly { origin: Position; blueprint: Blueprint }[]): Placed {
  const placed = parts.map((part) => ({ origin: cellOf(part.origin), blocks: blueprintBlocks(part.blueprint) }));
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { origin, blocks } of placed) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, origin[k]!);
      max[k] = Math.max(max[k]!, origin[k]!);
    }
    for (const b of blocks) {
      max[0] = Math.max(max[0], origin[0] + b.dx);
      max[1] = Math.max(max[1], origin[1] + b.dy);
      max[2] = Math.max(max[2], origin[2] + b.dz);
    }
  }
  const grid = new Grid(min, max);
  for (const { origin, blocks } of placed) for (const b of blocks) grid.paint(origin[0] + b.dx, origin[1] + b.dy, origin[2] + b.dz, b.block);
  return grid.toPlaced();
}

const Block = z.string().min(1);

export const line = defineRoutine(
  {
    name: "builder.line",
    description: "A straight one-block line of `block` from `from` to `to` ({x,y,z} or [x,y,z]), ends included: a blueprint with its origin in world coordinates, which builder.build and builder.check take as they are. The same cells whichever end is `from`.",
    args: z.object({ from: Position, to: Position, block: Block }),
    returns: Placed,
  },
  (_, { from, to, block }) => lineShape(cellOf(from), cellOf(to), block),
);

export const arc = defineRoutine(
  {
    name: "builder.arc",
    description: "An arch of `block` from `from` to `to` ({x,y,z} or [x,y,z]), ends included: the parabola in the vertical plane through both that passes through the point `rise` blocks above their midpoint (default: half the horizontal distance, rounded; 0 is a straight line, negative sags). A blueprint with its origin in world coordinates, which builder.build and builder.check take as they are. The same cells whichever end is `from`. `from` and `to` need different x or z unless rise is 0.",
    args: z.object({ from: Position, to: Position, rise: z.number().int().optional(), block: Block }),
    returns: Placed,
  },
  (_, { from, to, rise, block }) => {
    const [a, b] = [cellOf(from), cellOf(to)];
    return arcShape(a, b, rise ?? Math.round(Math.hypot(b[0] - a[0], b[2] - a[2]) / 2), block);
  },
);

export const fill = defineRoutine(
  {
    name: "builder.fill",
    description: "Every cell of the cuboid between corners `from` and `to` ({x,y,z} or [x,y,z], any order, both included) set to `block`; 'air' clears the volume. A blueprint with its origin in world coordinates, which builder.build and builder.check take as they are.",
    args: z.object({ from: Position, to: Position, block: Block }),
    returns: Placed,
  },
  (_, { from, to, block }) => {
    const { min, max } = cuboid(cellOf(from), cellOf(to));
    const grid = new Grid(min, max);
    for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) for (let x = min[0]; x <= max[0]; x++) grid.paint(x, y, z, block);
    return grid.toPlaced();
  },
);

export const box = defineRoutine(
  {
    name: "builder.box",
    description: "A hollow room between corners `from` and `to` ({x,y,z} or [x,y,z], any order, both included): `wall` on the four sides, the inside cleared ('air'), `floor` on the bottom layer and `roof` on the top layer when given (otherwise those layers are open and part of the inside). Needs 2 free layers inside, so with a floor and a roof it must be 4 blocks high. `door`: { side: 'north' (-z) | 'south' (+z) | 'east' (+x) | 'west' (-x), block? } cuts a doorway in the middle of that side, 2 high from the floor, which needs the side to be 3 blocks long: open air, or `block` (e.g. 'spruce_door') in its lower cell. A blueprint with its origin in world coordinates, which builder.build and builder.check take as they are.",
    args: z.object({
      from: Position,
      to: Position,
      wall: Block,
      floor: Block.optional(),
      roof: Block.optional(),
      door: z.object({ side: z.enum(SIDES), block: Block.optional() }).optional(),
    }),
    returns: Placed,
  },
  (_, { from, to, ...options }) => boxShape(cellOf(from), cellOf(to), options),
);

export const combine = defineRoutine(
  {
    name: "builder.combine",
    description: "Merge `parts`, each a { blueprint, origin } (what line, arc, fill, box and builder-style blueprints give) into one blueprint with its origin in world coordinates; where parts overlap the later part wins, so a later 'air' cuts a doorway through an earlier wall.",
    args: z.object({ parts: z.array(z.object({ blueprint: Blueprint, origin: Position })).min(1) }),
    returns: Placed,
  },
  (_, { parts }) => combineParts(parts),
);
