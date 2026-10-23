// The explorer routines: explore new ground, summarize surroundings, remember named places, and
// climb out of holes to open sky — calling the move and dig primitives.
import { biomeAt, type Block, defineRoutine, Point, Position, type RoutineContext, skyAbove, toVec3, Vec3, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as dig from "minebot-sdk/routines/dig";

export const description = "Explore new ground, summarize surroundings, remember named places, and climb out of holes to open sky.";
export const uses = ["move", "sense", "dig"] as const;

/** The explorer's namespace: its store is <state>/stores/explorer.json. */
const STORE = "explorer";
const CELL = 16;
const VISITED_KEY = "visited";
const PLACES_KEY = "places";
/** Where stores written before places existed keep their waypoints; read once, then moved to `places`. */
const WAYPOINTS_KEY = "waypoints";

/** Blocks too common to be worth reporting in a scan. */
const COMMON = /^(air|cave_air|void_air|stone|dirt|grass_block|short_grass|tall_grass|deepslate|tuff|granite|diorite|andesite|sand|sandstone|gravel|bedrock|netherrack|.*_leaves|leaf_litter|snow|clay)$/;

interface Waypoint {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

const WaypointSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), dimension: z.string() });

const PLACE_KINDS = ["chest", "bed", "farm", "ore", "base", "portal", "other"] as const;

const Place = z.object({
  name: z.string(),
  kind: z.enum(PLACE_KINDS),
  tags: z.array(z.string()),
  note: z.string(),
  /** Items in the place and how many of each, for a chest or a farm's store. */
  contents: z.record(z.string(), z.number()).optional(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  dimension: z.string(),
  /** ISO time of the last change. */
  updatedAt: z.string(),
});
export type Place = z.infer<typeof Place>;

const VisitedCells = z.array(z.string());
const Places = z.record(z.string(), Place);
const LegacyWaypoints = z.record(z.string(), z.object({ x: z.number(), y: z.number(), z: z.number(), dimension: z.string() }));

/** 16x16 cells this body has visited, from the explorer's persistent store. */
function visited(ctx: RoutineContext): Set<string> {
  const parsed = VisitedCells.safeParse(ctx.store(STORE).get(VISITED_KEY));
  return new Set(parsed.success ? parsed.data : []);
}

function markVisited(ctx: RoutineContext, ...positions: Vec3[]): Set<string> {
  const cells = visited(ctx);
  for (const p of positions) cells.add(cellOf(p));
  ctx.store(STORE).set(VISITED_KEY, [...cells]);
  return cells;
}

/** The saved places by name. A store that still holds plain waypoints is converted here, once. */
function savedPlaces(ctx: RoutineContext): Record<string, Place> {
  const parsed = Places.safeParse(ctx.store(STORE).get(PLACES_KEY));
  if (parsed.success) return parsed.data;
  const legacy = LegacyWaypoints.safeParse(ctx.store(STORE).get(WAYPOINTS_KEY));
  if (!legacy.success) return {};
  const updatedAt = new Date().toISOString();
  const converted = Object.fromEntries(
    Object.entries(legacy.data).map(([name, { dimension, ...position }]): [string, Place] => [
      name,
      { name, kind: "other", tags: [], note: "", position, dimension, updatedAt },
    ]),
  );
  ctx.store(STORE).set(PLACES_KEY, converted);
  ctx.store(STORE).delete(WAYPOINTS_KEY);
  return converted;
}

const cellOf = (p: Vec3) => `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;

interface ScanResult {
  position: Vec3;
  biome: string;
  /** Uncommon blocks: count and the nearest position of each, most numerous first. */
  blocks: { name: string; count: number; nearest: Vec3 }[];
  entities: { name: string; count: number; nearestDistance: number }[];
}

const ScanResultSchema = z.object({
  position: Point,
  biome: z.string(),
  blocks: z.array(z.object({ name: z.string(), count: z.number(), nearest: Point })),
  entities: z.array(z.object({ name: z.string(), count: z.number(), nearestDistance: z.number() })),
});

/** Summarizes uncommon blocks and entities within `radius` (vertical range is half the radius). */
function scanArea(ctx: RoutineContext, radius = 16): ScanResult {
  const { bot } = ctx;
  const here = bot.entity.position.floored();
  const found = new Map<string, { count: number; nearest: Vec3; distance: number }>();
  const yRange = Math.ceil(radius / 2);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -yRange; dy <= yRange; dy++) {
        const pos = here.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (!block || COMMON.test(block.name)) continue;
        const distance = pos.distanceTo(here);
        const entry = found.get(block.name);
        if (!entry) found.set(block.name, { count: 1, nearest: pos, distance });
        else {
          entry.count++;
          if (distance < entry.distance) Object.assign(entry, { nearest: pos, distance });
        }
      }
    }
  }
  const entities = new Map<string, { count: number; nearestDistance: number }>();
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity) continue;
    const distance = e.position.distanceTo(bot.entity.position);
    if (distance > radius * 2) continue;
    const name = e.username ?? e.name ?? "unknown";
    const entry = entities.get(name);
    if (!entry) entities.set(name, { count: 1, nearestDistance: Math.round(distance) });
    else {
      entry.count++;
      entry.nearestDistance = Math.min(entry.nearestDistance, Math.round(distance));
    }
  }
  markVisited(ctx, here);
  return {
    position: here,
    biome: biomeAt(bot, here),
    blocks: [...found.entries()]
      .map(([name, e]) => ({ name, count: e.count, nearest: e.nearest }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    entities: [...entities.entries()].map(([name, e]) => ({ name, ...e })).sort((a, b) => a.nearestDistance - b.nearestDistance),
  };
}

interface ExploreResult {
  from: Vec3;
  to: Vec3;
  reached: boolean;
  /** 16x16 cells visited so far by this body. */
  cellsVisited: number;
}

const ExploreResultSchema = z.object({ from: Point, to: Point, reached: z.boolean(), cellsVisited: z.number() });

/** Walks about `distance` blocks toward the direction whose destination cell is least explored. */
async function exploreToward(ctx: RoutineContext, distance = 48, timeoutMs = 90_000): Promise<ExploreResult> {
  const { bot } = ctx;
  const from = bot.entity.position.floored();
  const cells = markVisited(ctx, from);
  const headings = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4 + Math.random() * 0.3);
  const scored = headings.map((angle) => {
    const target = from.offset(Math.round(distance * Math.cos(angle)), 0, Math.round(distance * Math.sin(angle)));
    // Prefer unvisited destinations; among those, ones far from every visited cell.
    const novelty = cells.has(cellOf(target)) ? 0 : 1;
    const spread = Math.min(
      ...[...cells].map((c) => {
        const [cx, cz] = c.split(",").map(Number);
        return Math.hypot(cx! * CELL - target.x, cz! * CELL - target.z);
      }),
    );
    return { target, score: novelty * 1000 + spread };
  });
  const { target } = scored.sort((a, b) => b.score - a.score)[0]!;
  let reached = true;
  try {
    await move.to(ctx, { position: target, range: 1, timeoutMs });
  } catch (err) {
    reached = false;
    ctx.log(`explore: stopped short of ${target.x},${target.z}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const to = bot.entity.position.floored();
  const total = markVisited(ctx, to).size;
  return { from, to, reached, cellsVisited: total };
}

const SIDES = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];
const LAVA = /^lava$/;

/** Air is 300 ticks, shown as 20 levels of 15 ticks (mineflayer's `oxygenLevel`): 0.75 s a level. */
const AIR_MS_PER_LEVEL = 750;
/** Air that a dig under water must leave over. */
const AIR_MARGIN_MS = 2_000;
const MAX_AIR_STOPS = 3;
const EYE_HEIGHT = 1.62;

/** A dig under water that the air left cannot cover: vanilla digs 25 times slower submerged and off the ground, and the player drowns after about 15 seconds of air. */
class LowAirError extends Error {}

/** True when the player's eyes are under water, so that the air supply runs down. */
const headUnderwater = (bot: RoutineContext["bot"]) => bot.blockAt(bot.entity.position.offset(0, EYE_HEIGHT, 0))?.name === "water";

/** Refuses a dig the air supply cannot cover, before dig.dig starts it. */
function checkAir(ctx: RoutineContext, block: Block): void {
  if (!headUnderwater(ctx.bot)) return;
  const tool = ctx.bot.pathfinder.bestHarvestTool(block);
  const needMs = block.digTime(tool?.type ?? null, false, true, true) + AIR_MARGIN_MS;
  const airMs = ctx.bot.oxygenLevel * AIR_MS_PER_LEVEL;
  if (needMs > airMs) {
    throw new LowAirError(`digging ${block.name} under water takes ${Math.round(needMs / 1000)} s and the air lasts ${Math.round(airMs / 1000)} s`);
  }
}

/** Digs one cell, refusing first when under water and the air cannot cover the dig. */
async function clearCell(ctx: RoutineContext, pos: Vec3): Promise<void> {
  const block = ctx.bot.blockAt(pos);
  if (!block) throw new Error(`${pos} is not loaded`);
  if (block.boundingBox !== "block") return;
  checkAir(ctx, block);
  await dig.dig(ctx, { at: pos });
}

/**
 * Swims to the nearest air above water within 24 blocks and waits there until the air supply is nearly full.
 * The pathfinder cannot plan a swim under a ceiling, so this holds jump and walks toward the air.
 */
async function reachAir(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const isAir = (p: Vec3) => bot.blockAt(p)?.boundingBox === "empty" && bot.blockAt(p)?.name !== "water";
  const pockets = bot.findBlocks({
    matching: (b) => isAir(b.position) && bot.blockAt(b.position.offset(0, -1, 0))?.name === "water",
    useExtraInfo: true,
    maxDistance: 24,
    count: 8,
  });
  const offset = (x: number, z: number) => Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z);
  for (const pocket of pockets.slice(0, 4)) {
    const x = pocket.x + 0.5;
    const z = pocket.z + 0.5;
    try {
      // Swim level first, without jump: at the surface the player's head is in the layer of the ceiling, which blocks a diagonal approach.
      bot.setControlState("forward", true);
      const swimDeadline = Date.now() + 12_000;
      while (offset(x, z) > 0.3) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (Date.now() > swimDeadline) throw new Error("could not swim to the air");
        await bot.lookAt(new Vec3(x, bot.entity.position.y + EYE_HEIGHT, z), true);
        await ctx.sleep(50);
      }
      bot.setControlState("forward", false);
      // Then up the column. Releasing jump sinks the player again, so hold it until the air is full.
      bot.setControlState("jump", true);
      const climbDeadline = Date.now() + 8_000;
      while (headUnderwater(bot)) {
        if (Date.now() > climbDeadline) throw new Error("could not swim up to the air");
        await ctx.sleep(100);
      }
      const breatheDeadline = Date.now() + 10_000;
      while (bot.oxygenLevel < 19 && Date.now() < breatheDeadline) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        await ctx.sleep(250);
      }
      return;
    } catch (err) {
      ctx.log(`surface: could not reach air at ${pocket}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      bot.setControlState("forward", false);
      bot.setControlState("jump", false);
    }
  }
  throw new Error("surface: low on air under a solid ceiling and found no air to breathe within 24 blocks");
}

/** True when digging out `cells` could let lava in from any side. */
function nearLava(ctx: RoutineContext, cells: Vec3[]): boolean {
  const offsets = [...SIDES, new Vec3(0, 1, 0), new Vec3(0, -1, 0)];
  return cells.some((c) => [c, ...offsets.map((o) => c.plus(o))].some((p) => LAVA.test(ctx.bot.blockAt(p)?.name ?? "")));
}

/**
 * True when water sits directly on top of one of `cells`. Digging such a cell under a lake or the
 * sea pours a column of water onto the player, who can drown. Water at the sides only fills a block.
 */
function waterOnTop(ctx: RoutineContext, cells: Vec3[]): boolean {
  return cells.some((c) => ctx.bot.blockAt(c.offset(0, 1, 0))?.name === "water");
}

/**
 * When the player is in water, swims to the nearest dry spot under open sky within 48 blocks.
 * Holding jump only keeps the player at the surface while jump is held; the pathfinder swims to land.
 */
async function toDryLand(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (bot.blockAt(bot.entity.position)?.name !== "water" && bot.blockAt(bot.entity.position.offset(0, 1, 0))?.name !== "water") return;
  const air = (p: Vec3) => bot.blockAt(p)?.boundingBox === "empty" && bot.blockAt(p)?.name !== "water";
  // Only spots at or above the water surface: air pockets under the water are not land.
  const surfaceY = bot.entity.position.floored().y - 1;
  const spots = bot.findBlocks({
    matching: (b) =>
      b.boundingBox === "block" &&
      !b.name.endsWith("_leaves") &&
      b.position.y >= surfaceY &&
      air(b.position.offset(0, 1, 0)) &&
      air(b.position.offset(0, 2, 0)) &&
      skyAbove(bot, b.position.offset(0, 1, 0)).open,
    useExtraInfo: true,
    maxDistance: 48,
    count: 8,
  });
  for (const spot of spots.slice(0, 5)) {
    try {
      await move.to(ctx, { position: spot.offset(0, 1, 0), range: 0, timeoutMs: 45_000 });
      return;
    } catch (err) {
      ctx.log(`surface: could not reach dry land at ${spot.offset(0, 1, 0)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error("surface: reached open water but found no reachable dry land within 48 blocks");
}

/**
 * Digs the cells for one move from `here` in `dir` and walks into it. An "up" move is one stair step:
 * the block above the head and the two blocks of the next step. A "level" move is a tunnel step.
 */
async function digMove(ctx: RoutineContext, here: Vec3, dir: Vec3, kind: "up" | "level"): Promise<void> {
  const feet = kind === "up" ? here.plus(dir).offset(0, 1, 0) : here.plus(dir);
  const cells = kind === "up" ? [here.offset(0, 2, 0), feet, feet.offset(0, 1, 0)] : [feet, feet.offset(0, 1, 0)];
  if (nearLava(ctx, cells)) throw new Error("lava next to the cells to dig");
  if (waterOnTop(ctx, cells)) throw new Error("water above the cells to dig");
  if (ctx.bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== "block") throw new Error("no floor");
  for (const cell of cells) await clearCell(ctx, cell);
  await move.to(ctx, { position: feet, range: 0, timeoutMs: 10_000 });
}

/**
 * In water: swims up one block, digging the block above the head first if it is solid.
 * Jump is held from the start: without it the player sinks while the ceiling is dug, and the head leaves the air it was in.
 */
async function swimUp(ctx: RoutineContext, here: Vec3): Promise<void> {
  const { bot } = ctx;
  const above = here.offset(0, 2, 0);
  bot.setControlState("jump", true);
  try {
    if (bot.blockAt(above)?.boundingBox === "block") {
      if (nearLava(ctx, [above])) throw new Error("lava above");
      if (waterOnTop(ctx, [above])) throw new Error("water above the cells to dig");
      await clearCell(ctx, above);
    }
    const deadline = Date.now() + 5000;
    while (bot.entity.position.floored().y <= here.y) {
      if (Date.now() > deadline) throw new Error("could not swim up");
      await ctx.sleep(100);
    }
  } finally {
    bot.setControlState("jump", false);
  }
}

const inWater = (ctx: RoutineContext, p: Vec3) => ctx.bot.blockAt(p)?.name === "water";

interface SurfaceResult {
  surfaced: boolean;
  from: Vec3;
  to: Vec3;
  /** Steps climbed. */
  steps: number;
}

const SurfaceResultSchema = z.object({ surfaced: z.boolean(), from: Point, to: Point, steps: z.number() });

/**
 * Climbs to open sky by digging a staircase: each step clears the space above the head and the
 * two blocks of the next step up, then walks up. When a stair step is impossible in a direction
 * (no floor, bedrock, lava, or water directly above a cell, as under a lake), it tunnels one block
 * sideways and tries again, or turns. In a flooded shaft it swims up. If it ends in open water,
 * it swims to the nearest dry land. Needs no blocks in the inventory. Without a pickaxe, each
 * stone block takes about 7 seconds.
 */
async function climbToSurface(ctx: RoutineContext, maxSteps = 120): Promise<SurfaceResult> {
  const { bot } = ctx;
  const from = bot.entity.position.floored();
  let side = 0;
  let steps = 0;
  let failures = 0;
  let airStops = 0;
  while (!skyAbove(bot, bot.entity.position).open) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (steps >= maxSteps) return { surfaced: false, from, to: bot.entity.position.floored(), steps };
    const here = bot.entity.position.floored();
    const dir = SIDES[side % SIDES.length]!;
    try {
      try {
        // Water flowing into the staircase leaves no floor to step on; swim instead.
        if (inWater(ctx, here)) await swimUp(ctx, here);
        else await digMove(ctx, here, dir, "up");
      } catch (upErr) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (upErr instanceof LowAirError) throw upErr;
        try {
          await digMove(ctx, here, dir, "level");
        } catch (levelErr) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          if (levelErr instanceof LowAirError) throw levelErr;
          const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
          ctx.log(`surface: turning at ${here}: up: ${reason(upErr)}; level: ${reason(levelErr)}`);
          side++;
          if (++failures >= SIDES.length * 2) throw new Error(`surface: blocked in every direction at ${here}`);
          continue;
        }
      }
    } catch (err) {
      if (!(err instanceof LowAirError)) throw err;
      // The ceiling is too slow to dig on the air that is left: breathe first, then try again.
      if (++airStops > MAX_AIR_STOPS) throw new Error(`surface: ${err.message}; stopped after ${MAX_AIR_STOPS} trips to the air`);
      ctx.log(`surface: ${err.message}; swimming to air`);
      await reachAir(ctx);
      continue;
    }
    steps++;
    failures = 0;
  }
  await toDryLand(ctx);
  const to = bot.entity.position.floored();
  ctx.log(`surface: open sky at ${to} after ${steps} steps`);
  return { surfaced: true, from, to, steps };
}

export const scan = defineRoutine(
  {
    name: "explorer.scan",
    description: "Summarize the area within `radius` (default 16): biome, uncommon blocks with counts and nearest positions (ores, logs, water, chests...), and nearby entities.",
    args: z.object({ radius: z.number().int().positive().max(32).default(16) }),
    returns: ScanResultSchema,
  },
  (ctx, { radius }) => scanArea(ctx, radius),
);

export const explore = defineRoutine(
  {
    name: "explorer.explore",
    description: "Walk about `distance` blocks (default 48) toward the least-explored direction. Remembers visited 16x16 cells across calls. Gives up (and stops pathfinding) after `timeoutMs` (default 90000). Returns { from, to, reached, cellsVisited }.",
    args: z.object({
      distance: z.number().positive().default(48),
      timeoutMs: z.number().int().positive().default(90_000),
    }),
    returns: ExploreResultSchema,
  },
  (ctx, { distance, timeoutMs }) => exploreToward(ctx, distance, timeoutMs),
);

export const remember = defineRoutine(
  {
    name: "explorer.remember",
    description: "Save a named place at `at` (default: where the player stands) and return it. `kind` is one of chest, bed, farm, ore, base, portal, other (default other); `tags` and `note` describe it; `contents` maps item names to counts for a chest. Remembering a name again keeps the kind, tags, note, and contents you do not pass. Places survive runs and body restarts.",
    args: z.object({
      name: z.string().min(1).max(64),
      at: Position.optional(),
      kind: z.enum(PLACE_KINDS).optional(),
      tags: z.array(z.string().min(1).max(32)).max(16).optional(),
      note: z.string().max(500).optional(),
      contents: z.record(z.string(), z.number().int().nonnegative()).optional(),
    }),
    returns: Place,
  },
  (ctx, { name, at, kind, tags, note, contents }) => {
    const known = savedPlaces(ctx);
    const before = known[name];
    const p = at ? toVec3(at).floored() : ctx.bot.entity.position.floored();
    const place: Place = {
      name,
      kind: kind ?? before?.kind ?? "other",
      tags: tags ?? before?.tags ?? [],
      note: note ?? before?.note ?? "",
      ...((contents ?? before?.contents) && { contents: contents ?? before?.contents }),
      position: { x: p.x, y: p.y, z: p.z },
      dimension: ctx.bot.game.dimension,
      updatedAt: new Date().toISOString(),
    };
    ctx.store(STORE).set(PLACES_KEY, { ...known, [name]: place });
    return place;
  },
);

export const places = defineRoutine(
  {
    name: "explorer.places",
    description: "List saved places, nearest first. `kind` keeps one kind; `near` is the point distances are measured from (default: the player); `radius` drops places farther than that from `near` or in another dimension; `limit` (default 20) caps the list. Places in other dimensions come last without a `distance`. Returns places with name, kind, tags, note, contents, position, dimension, updatedAt, and distance.",
    args: z.object({
      kind: z.enum(PLACE_KINDS).optional(),
      near: Position.optional(),
      radius: z.number().positive().optional(),
      limit: z.number().int().positive().default(20),
    }),
    returns: z.array(Place.extend({ distance: z.number().optional() })),
  },
  (ctx, { kind, near, radius, limit }) => {
    const origin = near ? toVec3(near) : ctx.bot.entity.position;
    const found = Object.values(savedPlaces(ctx))
      .filter((place) => kind === undefined || place.kind === kind)
      .map((place) => ({
        ...place,
        ...(place.dimension === ctx.bot.game.dimension && {
          distance: Math.round(origin.distanceTo(new Vec3(place.position.x, place.position.y, place.position.z))),
        }),
      }))
      .filter((place) => radius === undefined || (place.distance !== undefined && place.distance <= radius));
    // Places in another dimension have no distance and sort last.
    found.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return found.slice(0, limit);
  },
);

export const waypoints = defineRoutine(
  {
    name: "explorer.waypoints",
    description: "Every saved place by name as { x, y, z, dimension }. `places` lists them with their kind, tags, note, and contents.",
    args: z.object({}),
    returns: z.record(z.string(), WaypointSchema),
  },
  (ctx): Record<string, Waypoint> =>
    Object.fromEntries(Object.entries(savedPlaces(ctx)).map(([name, { position, dimension }]) => [name, { ...position, dimension }])),
);

export const travel = defineRoutine(
  {
    name: "explorer.travel",
    description: "Walk to a saved place, stopping within `range` (default 2) blocks. Gives up after `timeoutMs` (default 120000). Returns where the player then stands.",
    args: z.object({ name: z.string().min(1), range: z.number().min(0).default(2), timeoutMs: z.number().int().positive().default(120_000) }),
    returns: Point,
  },
  (ctx, { name, range, timeoutMs }) => {
    const known = savedPlaces(ctx);
    const place = known[name];
    if (!place) throw new Error(`no place "${name}"; known: ${Object.keys(known).join(", ") || "none"}`);
    if (place.dimension !== ctx.bot.game.dimension) throw new Error(`place "${name}" is in ${place.dimension}`);
    const { x, y, z } = place.position;
    return move.to(ctx, { position: new Vec3(x, y, z), range, timeoutMs });
  },
);

export const surface = defineRoutine(
  {
    name: "explorer.surface",
    description: "Climb to open sky by digging a staircase; use it when trapped underground or in a pit. Needs no blocks; slow without a pickaxe, so pass a long call timeout (e.g. --timeout 600000). Under water it checks the air supply: it does not dig what the air cannot cover and swims to air first. `maxSteps` (default 120) bounds the climb. Returns { surfaced, from, to, steps }.",
    args: z.object({ maxSteps: z.number().int().positive().default(120) }),
    returns: SurfaceResultSchema,
  },
  (ctx, { maxSteps }) => climbToSurface(ctx, maxSteps),
);
