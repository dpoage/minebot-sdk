// The move routines: walking with the pathfinder. The primitive every other built-in routine builds on.
import { type Block, defineRoutine, goals, Movements, Point, Position, type RoutineContext, Vec3, within, z } from "minebot-sdk/routine";

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
/**
 * The body's low-oxygen threshold, the same value `src/host/watch.ts` exports as `LOW_OXYGEN`: the
 * server lets the breath bar fall to 10 before the player starts taking drowning damage.
 */
const LOW_OXYGEN = 10;
const AIR_SAMPLE_MS = 100;
/** Long enough to surface from any depth at 20 ticks a second, short enough to keep a doomed walk short. */
const AIR_RISE_MS = 8_000;
/** A finished path that leaves the player out of range and then does nothing for this many ticks ended short. */
const PATH_SHORT_IDLE_TICKS = 10;
/** A no-path explanation searches with a fall height taller than any world: every drop is allowed. */
const UNLIMITED_DROP_DOWN = 512;
/** Both searches that explain a missing path share this budget, so a failed walk still ends promptly. */
const NO_PATH_RESEARCH_MS = 5_000;
/** Scaffold must not go under a build within this many blocks; the same reach `src/host/pathfinding.ts` excludes. */
const OWN_BUILD_SCAFFOLD_REACH = 16;
/** The pathfinder's own search slice, so a re-search never blocks a tick for longer than a search tick. */
const SEARCH_SLICE_MS = 40;
/** Blocks whose cell holds water: swimming up needs the head in a cell that is none of them. */
const WATER_BLOCKS = new Set(["water", "kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column"]);
/** The height diagnosis searches this far above and below the goal's y for the column's ground. */
const GROUND_SEARCH_BLOCKS = 64;
/** A closed wooden door this near a goal the walk could not reach may be the way in; move.to opens it and walks again once. */
const DOOR_SEARCH_BLOCKS = 8;
/** The walk to just outside a door, so a door that cannot be reached costs no more than this. */
const DOOR_WALK_MS = 20_000;
/** A node within this many blocks of the door cell is close enough that its eyes reach the door. */
const DOOR_APPROACH_BLOCKS = 3;
/** The reach within which the server opens a block (the same 4.5 blocks place and dig use). */
const DOOR_REACH = 4.5;
/** How long the server may take to report an opened door, sampled every `DOOR_SAMPLE_MS`; a lagging server can take seconds. */
const DOOR_OPEN_MS = 5_000;
const DOOR_SAMPLE_MS = 100;

/** A walk's goal: the pathfinder goal, how a standing position counts as there, and how errors name it. */
interface WalkGoal {
  /** What the pathfinder is told to reach. */
  readonly goal: InstanceType<typeof goals.GoalNear> | InstanceType<typeof goals.GoalNearXZ>;
  /** Where progress and error messages point. */
  readonly target: Vec3;
  /** The goal's own height, or undefined for a column goal ({ x, z }). */
  readonly y: number | undefined;
  /** The tolerance in blocks: 3D for a point goal, xz for a column. */
  readonly range: number;
  /** Whether a standing position (floored feet) satisfies the goal. */
  readonly near: (feet: Vec3) => boolean;
  /** How far a standing position is from the target, in the goal's own space. */
  readonly distance: (feet: Vec3) => number;
}

/** The standing ground of the column (x,z) nearest `goalY`, within 64 blocks each way, read from loaded blocks. */
function groundAt(bot: RoutineContext["bot"], x: number, z: number, goalY: number): { loaded: boolean; y?: number } {
  // y 0 lies inside every overworld chunk: a null there means the chunk is not loaded, not a height limit.
  if (bot.blockAt(new Vec3(x, 0, z)) === null) return { loaded: false };
  const standable = (y: number) => {
    const feet = new Vec3(x, y, z);
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const at = bot.blockAt(feet);
    const head = bot.blockAt(feet.offset(0, 1, 0));
    return floor !== null && at !== null && head !== null && floor.boundingBox === "block" && at.boundingBox !== "block" && head.boundingBox !== "block";
  };
  for (let d = 0; d <= GROUND_SEARCH_BLOCKS; d++) {
    if (d === 0) {
      if (standable(goalY)) return { loaded: true, y: goalY };
      continue;
    }
    // Nearest first; a tie goes to the cell below the goal.
    if (standable(goalY - d)) return { loaded: true, y: goalY - d };
    if (standable(goalY + d)) return { loaded: true, y: goalY + d };
  }
  return { loaded: true };
}

/**
 * Why a goal's height is off the ground of its column, for a could-not-reach error: the ground y
 * named with the goal's distance above or below it, or that the column is not loaded. Empty when
 * the goal is within `range + 1` of the ground, is a column goal, or no ground was found.
 */
function heightNote(bot: RoutineContext["bot"], spec: WalkGoal): string {
  if (spec.y === undefined) return "";
  const ground = groundAt(bot, spec.target.x, spec.target.z, spec.y);
  if (!ground.loaded) return "; the goal's column is not loaded, so its ground height is unknown";
  if (ground.y === undefined) return "";
  const delta = spec.y - ground.y;
  if (Math.abs(delta) <= spec.range + 1) return "";
  return `; the ground at that column is y ${ground.y}, so the goal is ${Math.abs(delta)} blocks ${delta > 0 ? "above" : "below"} the ground there - pass { x, z } to walk to the surface`;
}

/** The wooden door blocks the retry may open; an iron door takes redstone, so the pathfinder must find another way through it. */
function woodenDoorIds(bot: RoutineContext["bot"]): number[] {
  return bot.registry.blocksArray.filter((block) => block.name.endsWith("_door") && !block.name.startsWith("iron_")).map((block) => block.id);
}

/** The nearest wooden door within `DOOR_SEARCH_BLOCKS` of `target`, its lower half only. */
function woodenDoorNear(bot: RoutineContext["bot"], target: Vec3): Block | undefined {
  const ids = woodenDoorIds(bot);
  if (ids.length === 0) return undefined;
  for (const position of bot.findBlocks({ matching: ids, point: target, maxDistance: DOOR_SEARCH_BLOCKS, count: 16 })) {
    const block = bot.blockAt(position);
    if (block && block.getProperties().half !== "upper") return block;
  }
  return undefined;
}

/**
 * Opens the wooden door nearest to a goal the walk could not reach, if it is still closed: walks
 * to just outside it, activates it, and waits for the server's open update. Returns the door's
 * lower cell once it is open (or was already open), or undefined when there is no such door or it
 * could not be opened, so the caller keeps the walk's own error. The default movements leave
 * doors solid on purpose: the plugin's `canOpenDoors` handles fence gates only, and the single
 * `useOne` move it builds for a door crashes its executor (verified live on the dev server).
 *
 * An open wooden door is not a fence gate: its data still says `boundingBox: "block"` (the swung
 * panel has a shape), so the pathfinder would call it solid; `passOpenDoor` hides the opened cells
 * from the retry walk, where the player's physics passes the doorway.
 */
async function openDoorNearGoal(ctx: RoutineContext, spec: WalkGoal): Promise<Vec3 | undefined> {
  const { bot } = ctx;
  const door = woodenDoorNear(bot, spec.target);
  if (!door) return undefined;
  const doorAt = door.position;
  if (door.getProperties().open !== true) {
    try {
      await pathTo(ctx, pointGoal(doorAt, DOOR_APPROACH_BLOCKS), DOOR_WALK_MS, false);
    } catch {
      // The walk need not reach the door cell: the reach check below decides whether it can be opened.
    }
    const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
    if (eyes.distanceTo(doorAt.offset(0.5, 0.5, 0.5)) > DOOR_REACH) return undefined;
    await bot.activateBlock(door);
    const deadline = Date.now() + DOOR_OPEN_MS;
    while (Date.now() < deadline) {
      if (bot.blockAt(doorAt)?.getProperties().open === true) break;
      await new Promise<void>((resolve) => setTimeout(resolve, DOOR_SAMPLE_MS));
    }
  }
  return bot.blockAt(doorAt)?.getProperties().open === true ? doorAt.clone() : undefined;
}

/**
 * Reports an open door's two cells as empty while one retry walk runs, then restores the blocks.
 * Both the planner and the post-processed waypoints read `bot.blockAt`: an open door's data still
 * carries the swung panel's shape, which would make the planner treat it as solid and the
 * waypoint sit on top of it. The player's physics passes the open doorway; the cells are restored
 * before the walk's result is returned.
 */
function passOpenDoor(bot: RoutineContext["bot"], lower: Vec3): () => void {
  const cells = [lower, lower.offset(0, 1, 0)];
  const original = new Map<Block, { boundingBox: Block["boundingBox"]; shapes: Block["shapes"] }>();
  const blockAt = bot.blockAt;
  bot.blockAt = ((point: Vec3, extraInfos?: boolean) => {
    const block = blockAt.call(bot, point, extraInfos);
    if (block && cells.some((cell) => cell.x === Math.floor(point.x) && cell.y === Math.floor(point.y) && cell.z === Math.floor(point.z))) {
      if (!original.has(block)) original.set(block, { boundingBox: block.boundingBox, shapes: block.shapes });
      block.boundingBox = "empty";
      block.shapes = [];
    }
    return block;
  }) as typeof bot.blockAt;
  return () => {
    bot.blockAt = blockAt;
    for (const [block, saved] of original) {
      block.boundingBox = saved.boundingBox;
      block.shapes = saved.shapes;
    }
  };
}

/** Rejects (and stops pathfinding) once the player has made no progress for `NO_PROGRESS_MS`; `stop` ends the watch. */
function watchProgress(bot: RoutineContext["bot"], spec: WalkGoal): { stalled: Promise<never>; stop: () => void } {
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
    stalled.reject(new Error(`stuck at ${feet}, ${spec.distance(feet).toFixed(1)} blocks from ${spec.target}: no movement, digging, or nearby block change for ${NO_PROGRESS_MS / 1000} s`));
  }, SAMPLE_MS);
  return {
    stalled: stalled.promise,
    stop: () => {
      clearInterval(timer);
      bot.off("blockUpdate", onBlockUpdate);
    },
  };
}

/** Resolves "air" once the player's oxygen falls below `LOW_OXYGEN`; `at` says where that happened; `stop` ends the watch. */
function watchAir(bot: RoutineContext["bot"]): { low: Promise<"air">; at: () => Vec3; stop: () => void } {
  const low = Promise.withResolvers<"air">();
  let at = bot.entity.position.floored();
  const timer = setInterval(() => {
    // A fresh body has no air data yet: `oxygenLevel` is undefined until the server sends it, and only a number below the threshold is low air.
    if (typeof bot.oxygenLevel !== "number" || bot.oxygenLevel >= LOW_OXYGEN) return;
    at = bot.entity.position.floored();
    low.resolve("air");
  }, AIR_SAMPLE_MS);
  return { low: low.promise, at: () => at, stop: () => clearInterval(timer) };
}

/** Whether the block the player's eyes are in holds water: the breath bar only refills once the head is out. */
function headUnderwater(bot: RoutineContext["bot"]): boolean {
  const head = bot.blockAt(bot.entity.position.offset(0, EYE_HEIGHT, 0));
  if (!head) return false;
  if (WATER_BLOCKS.has(head.name)) return true;
  return head.getProperties().waterlogged === true;
}

/**
 * Stops the walk and swims up by holding jump until the head is out of water (or `AIR_RISE_MS`
 * passes), then returns the error that ends the run. The pathfinder's own control clearing has
 * already happened when its goal is dropped.
 */
async function riseOutOfAir(bot: RoutineContext["bot"], from: Vec3, target: Vec3): Promise<Error> {
  bot.pathfinder.setGoal(null);
  bot.setControlState("jump", true);
  try {
    const started = Date.now();
    while (headUnderwater(bot) && Date.now() - started < AIR_RISE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, AIR_SAMPLE_MS));
    }
  } finally {
    bot.setControlState("jump", false);
  }
  const up = bot.entity.position.floored();
  return new Error(`out of air at ${from}: swam up to ${up}; the path to ${target} runs underwater - go around the water`);
}

/**
 * Rejects when the pathfinder has walked its last node, then gone idle short of the goal: it set a
 * non-empty path, reported nothing since, `isMoving()` is false, and the player is outside `range`
 * for `PATH_SHORT_IDLE_TICKS` physics ticks. A path that ended and a goal that is still set is a
 * dead end the plugin never reports; without this the walk would wait for the stuck watchdog instead.
 */
function watchPathShort(bot: RoutineContext["bot"], spec: WalkGoal): { short: Promise<never>; stop: () => void } {
  const short = Promise.withResolvers<never>();
  let walking = false;
  let idle = 0;
  const reached = () => {
    walking = false;
    idle = 0;
  };
  const onUpdate = ({ status, path }: { status: string; path: unknown[] }) => {
    if (status === "success" && path.length > 0) walking = true;
    idle = 0;
  };
  const onTick = () => {
    if (!walking) return;
    const feet = bot.entity.position.floored();
    if (spec.near(feet) || spec.near(feet.offset(0, 1, 0))) return reached();
    if (bot.pathfinder.isMoving?.()) {
      idle = 0;
      return;
    }
    idle++;
    if (idle < PATH_SHORT_IDLE_TICKS) return;
    walking = false;
    short.reject(new Error(`could not reach ${spec.target}: the path ended ${spec.distance(feet).toFixed(1)} blocks short${heightNote(bot, spec)}`));
  };
  bot.on("path_update", onUpdate);
  bot.on("path_reset", reached);
  bot.on("goal_reached", reached);
  bot.on("physicsTick", onTick);
  return {
    short: short.promise,
    stop: () => {
      bot.off("path_update", onUpdate);
      bot.off("path_reset", reached);
      bot.off("goal_reached", reached);
      bot.off("physicsTick", onTick);
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

/** A node of a pathfinder path: where it stands, and what it would break or place getting to the next one. */
interface PathNode {
  x: number;
  y: number;
  z: number;
  toBreak?: readonly { x: number; y: number; z: number }[];
  /** Scaffolds the planner would place: the reference block at x,y,z, and the cell placed into at +dx,+dy,+dz. */
  toPlace?: readonly { x: number; y: number; z: number; dx: number; dy: number; dz: number }[];
}

interface SearchResult {
  status: string;
  path: PathNode[];
}

/** A copy of `from`'s movement rules, with the fall height or the own-build exclusions changed; a fresh `Movements` would silently drop both. */
function cloneMovements(bot: RoutineContext["bot"], from: InstanceType<typeof Movements> | undefined, options: { unlimitedDrop?: boolean; noExclusions?: boolean } = {}): InstanceType<typeof Movements> {
  const movements = new Movements(bot);
  // The plugin types the exclusion lists as one-element tuples, so replaced lists need a cast to write.
  const exclusions = movements as unknown as { exclusionAreasBreak: unknown; exclusionAreasPlace: unknown; exclusionAreasStep: unknown };
  if (options.noExclusions === true) {
    exclusions.exclusionAreasBreak = [];
    exclusions.exclusionAreasPlace = [];
    exclusions.exclusionAreasStep = [];
  } else if (from) {
    exclusions.exclusionAreasBreak = from.exclusionAreasBreak;
    exclusions.exclusionAreasPlace = from.exclusionAreasPlace;
    exclusions.exclusionAreasStep = from.exclusionAreasStep;
  }
  if (options.unlimitedDrop === true) movements.maxDropDown = UNLIMITED_DROP_DOWN;
  else if (from) movements.maxDropDown = from.maxDropDown;
  return movements;
}

/** Runs the pathfinder's own search with `movements`, a search tick at a time, and returns the path when one is found within `budgetMs`. */
async function searchPath(bot: RoutineContext["bot"], movements: InstanceType<typeof Movements>, goal: WalkGoal["goal"], budgetMs: number): Promise<SearchResult | undefined> {
  if (budgetMs <= 0) return undefined;
  const deadline = Date.now() + budgetMs;
  const generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, {
    timeout: budgetMs,
    tickTimeout: SEARCH_SLICE_MS,
  }) as unknown as IterableIterator<{ result: SearchResult }>;
  for (;;) {
    const next = generator.next();
    if (next.done === true) return undefined;
    const { result } = next.value;
    if (result.status === "success") return result.path.length > 0 ? result : undefined;
    if (result.status !== "partial") return undefined;
    if (Date.now() >= deadline) return undefined;
    // The search is sliced so a tick never waits on it; the next slice starts after the tick's work.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The largest fall on `path`, in blocks: the biggest drop of y between consecutive nodes, from where the player stands. */
function largestDrop(path: readonly PathNode[], start: Vec3): number {
  let previous = start.y;
  let drop = 0;
  for (const node of path) {
    drop = Math.max(drop, previous - node.y);
    previous = node.y;
  }
  return Math.max(1, Math.round(drop));
}

/** A block the bot placed, as `src/host/pathfinding.ts` records it on the bot. */
interface PlacedBlock {
  x: number;
  y: number;
  z: number;
  name?: string;
}

/** What the bot placed this host session, read off the bot; empty when the host's pathfinding setup is absent. */
function placedBlocks(bot: RoutineContext["bot"]): readonly PlacedBlock[] {
  // The record is added to the bot by src/host/pathfinding.ts; Mineflayer has no own-builds API.
  const carrier = bot as unknown as { ownBuilds?: unknown };
  const record = carrier.ownBuilds;
  if (typeof record !== "object" || record === null || !("builds" in record) || !Array.isArray(record.builds)) return [];
  return record.builds as readonly PlacedBlock[];
}

/** The could-not-reach error that names one block the bot placed. */
function placedBlockError(bot: RoutineContext["bot"], target: Vec3, block: PlacedBlock): Error {
  const at = new Vec3(block.x, block.y, block.z);
  const name = block.name ? block.name : (bot.blockAt(at)?.name ?? "a block");
  return new Error(
    `could not reach ${target}: every way goes through blocks you placed (e.g. ${name} at ${at}); open a door, break one yourself, or call move.to again with allowDigOwnBuilds: true`,
  );
}

/**
 * The error that names a block the bot placed on the only way: the relaxed path breaks one of the
 * recorded blocks, or would scaffold a cell beneath one. A block that merely happens to be on the
 * path is not a build; when the path meets none of the record this returns nothing, and the walk
 * keeps the ordinary could-not-reach error.
 */
function ownBuildError(bot: RoutineContext["bot"], target: Vec3, path: readonly PathNode[]): Error | undefined {
  const placed = placedBlocks(bot);
  if (placed.length === 0) return undefined;
  const recordedAt = new Map(placed.map((block) => [`${block.x},${block.y},${block.z}`, block] as const));
  for (const node of path) {
    for (const cell of node.toBreak ?? []) {
      const hit = recordedAt.get(`${cell.x},${cell.y},${cell.z}`);
      if (hit) return placedBlockError(bot, target, hit);
    }
    for (const scaffold of node.toPlace ?? []) {
      const cellX = scaffold.x + scaffold.dx;
      const cellY = scaffold.y + scaffold.dy;
      const cellZ = scaffold.z + scaffold.dz;
      const above = placed.find((block) => block.x === cellX && block.z === cellZ && block.y > cellY && block.y <= cellY + OWN_BUILD_SCAFFOLD_REACH);
      if (above) return placedBlockError(bot, target, above);
    }
  }
  return undefined;
}

/**
 * Explains a walk that found no path, by searching again with one rule relaxed at a time: without
 * the own-build exclusions (so a path that appears was behind a block the bot placed), then with
 * every fall allowed (so a path that appears was behind the drop limit). Throws the matching error;
 * returns when neither rule explains it, leaving the generic could-not-reach error to the walk.
 */
async function throwWhyNoPath(bot: RoutineContext["bot"], goal: WalkGoal["goal"], walk: InstanceType<typeof Movements> | undefined, target: Vec3): Promise<void> {
  const deadline = Date.now() + NO_PATH_RESEARCH_MS;
  if ((walk?.exclusionAreasBreak.length ?? 0) > 0 || (walk?.exclusionAreasPlace.length ?? 0) > 0) {
    const found = await searchPath(bot, cloneMovements(bot, walk, { noExclusions: true }), goal, deadline - Date.now());
    const error = found && ownBuildError(bot, target, found.path);
    if (error) throw error;
  }
  const deep = await searchPath(bot, cloneMovements(bot, walk, { unlimitedDrop: true }), goal, deadline - Date.now());
  if (deep) {
    const atMost = walk?.maxDropDown ?? 4;
    throw new Error(
      `could not reach ${target}: every way down is a drop of ${largestDrop(deep.path, bot.entity.position)} blocks (the pathfinder drops at most ${atMost}) - dig or build stairs down, or pick a target on this level`,
    );
  }
}

/**
 * Runs a pathfinder goal with a time limit, a progress watchdog, and the checks only a walk in the
 * world can show: the breath bar falling, and a path that ends short and leaves the pathfinder
 * idle. When the executor keeps resetting with "stuck", retries without diagonal moves: the planner
 * allows diagonal steps up out of a pit that clip a tall block at the corner, and the executor then
 * replans the same failing step forever. When the pathfinder ends without reporting the goal reached
 * (no path, the search timed out, or an empty path), the player's position is checked against the
 * goal; a missing path is explained by one relaxed re-search. Pathfinding is stopped on every failure.
 * `allowDigOwnBuilds` walks on movements without the own-build exclusions, for a player who chose to
 * cut through what they built.
 */
async function pathTo(ctx: RoutineContext, spec: WalkGoal, timeoutMs: number, allowDigOwnBuilds: boolean, passable?: Vec3): Promise<void> {
  const { bot } = ctx;
  const { goal, target } = spec;
  const normal = bot.pathfinder.movements;
  const walk = allowDigOwnBuilds ? cloneMovements(bot, normal, { noExclusions: true }) : normal;
  const restoreDoor = passable === undefined ? undefined : passOpenDoor(bot, passable);
  let stuck = 0;
  const onReset = (reason: string) => {
    if (reason !== "stuck" || ++stuck !== STUCK_RESETS_BEFORE_FALLBACK) return;
    const straight = cloneMovements(bot, bot.pathfinder.movements);
    straight.getMoveDiagonal = () => {};
    ctx.log("pathfinding: stuck on a diagonal step; retrying without diagonal moves");
    bot.pathfinder.setMovements(straight);
  };
  if (walk !== normal) bot.pathfinder.setMovements(walk);
  bot.on("path_reset", onReset);
  const end = watchPathEnd(bot, goal);
  const watch = watchProgress(bot, spec);
  const air = watchAir(bot);
  const pathShort = watchPathShort(bot, spec);
  let ended: PathOutcome | "air" | undefined;
  try {
    // `goto` resolving is not an outcome (it resolves on any empty path, also a partial one); the watcher
    // takes its failures, ends a goto that said nothing, and settles on the pathfinder's own report.
    void bot.pathfinder.goto(goal).then(
      () => end.gotoSettled(undefined),
      (err: unknown) => end.gotoSettled(err),
    );
    ended = await within(timeoutMs, "pathfinding", Promise.race([end.outcome, watch.stalled, air.low, pathShort.short]), () => bot.pathfinder.setGoal(null));
  } finally {
    watch.stop();
    end.stop();
    air.stop();
    pathShort.stop();
    bot.off("path_reset", onReset);
    restoreDoor?.();
    if (bot.pathfinder.movements !== normal) bot.pathfinder.setMovements(normal);
    if (ended !== "reached" && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null);
  }
  if (ended === "air") throw await riseOutOfAir(bot, air.at(), target);
  if (ended === "reached") return;
  const feet = bot.entity.position.floored();
  // As the pathfinder's own end-of-path check, the cell above the feet also counts (for standing on a half-height block).
  if (spec.near(feet) || spec.near(feet.offset(0, 1, 0))) return;
  if (ended === "noPath") await throwWhyNoPath(bot, goal, walk, target);
  const why = ended === "timeout" ? "the path search ran out of time" : "the pathfinder found no way there from here";
  throw new Error(`could not reach ${target}: stopped at ${feet}, ${spec.distance(feet).toFixed(1)} blocks away; ${why}${heightNote(bot, spec)}`);
}

/** Walks to `spec`'s goal, opening a closed wooden door near it once if the walk could not reach it, and returns where the player then stands. */
async function walkTo(ctx: RoutineContext, spec: WalkGoal, timeoutMs: number, allowDigOwnBuilds: boolean): Promise<Vec3> {
  try {
    await pathTo(ctx, spec, timeoutMs, allowDigOwnBuilds);
  } catch (err) {
    // Only a walk that ended without a way can be explained by the closed door near the goal; every other end keeps its error.
    if (!(err instanceof Error) || !err.message.startsWith("could not reach ")) throw err;
    const opened = await openDoorNearGoal(ctx, spec);
    if (opened === undefined) throw err;
    await pathTo(ctx, spec, timeoutMs, allowDigOwnBuilds, opened);
  }
  return ctx.bot.entity.position.floored();
}

/**
 * move.to's position: the shared `Position` ({ x, y, z } or [x, y, z]), or { x, z } to walk to
 * that column's surface. The local arm is C4: this routine's shape, not the shared point schema.
 */
const MovePosition = z.union([Position, z.object({ x: z.number(), z: z.number() })]);
type MovePosition = z.infer<typeof MovePosition>;

/** A WalkGoal for the exact point `target`: the goal's own height, and a 3D range. */
function pointGoal(target: Vec3, range: number): WalkGoal {
  return {
    goal: new goals.GoalNear(target.x, target.y, target.z, range),
    target,
    y: target.y,
    range,
    near: (feet) => feet.distanceSquared(target) <= range * range,
    distance: (feet) => feet.distanceTo(target),
  };
}

/** The walk goal for a move.to position: a point keeps its exact height; { x, z } lets the path pick the column's surface. */
function walkGoal(bot: RoutineContext["bot"], position: MovePosition, range: number): WalkGoal {
  if (Array.isArray(position)) return pointGoal(new Vec3(position[0], position[1], position[2]).floored(), range);
  if ("y" in position) return pointGoal(new Vec3(position.x, position.y, position.z).floored(), range);
  const x = Math.floor(position.x);
  const z = Math.floor(position.z);
  return {
    goal: new goals.GoalNearXZ(x, z, range),
    target: new Vec3(x, bot.entity.position.floored().y, z),
    y: undefined,
    range,
    near: (feet) => (feet.x - x) ** 2 + (feet.z - z) ** 2 <= range * range,
    distance: (feet) => Math.hypot(feet.x - x, feet.z - z),
  };
}

export const to = defineRoutine(
  {
    name: "move.to",
    description:
      "Walk within `range` blocks of `position` and stop; the feet, or the block above them, within `range` counts as there. `position` is {x,y,z} or [x,y,z]; {x,z} instead walks to the surface of that column, so a far goal needs no y guess. Returns where the player stands once stopped. Throws, after stopping pathfinding, when `timeoutMs` passes, when 12 s go by with no progress (no movement, digging, or nearby block change: 'stuck at ...'), when the breath bar falls under 10 ('out of air ...'), when a finished path leaves the player short ('the path ended ... blocks short'), or when the pathfinder ends without a way within `range`, finding none or running out of search time ('could not reach ...'). A missing path names what blocked the way when a relaxed search finds one: a drop taller than the pathfinder falls, or a block the bot placed itself (`allowDigOwnBuilds: true` walks through those). When the goal is more than `range + 1` blocks above or below the ground of its column, the error names the ground y; when that column is not loaded, it says so. A closed wooden door near the goal is opened once and the walk tried again, so a hut with a wooden door is reachable without breaking a block.",
    args: z.object({
      position: MovePosition,
      range: z.number().min(0).default(1),
      timeoutMs: z.number().int().positive().default(DEFAULT_GOTO_TIMEOUT_MS),
      allowDigOwnBuilds: z.boolean().default(false),
    }),
    returns: Point,
  },
  (ctx, { position, range, timeoutMs, allowDigOwnBuilds }) => walkTo(ctx, walkGoal(ctx.bot, position, range), timeoutMs, allowDigOwnBuilds),
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
