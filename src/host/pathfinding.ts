// Pathfinder setup for every bot: loads the mineflayer-pathfinder plugin, validates every goal the
// body hands the pathfinder, records what the bot builds itself, and gives the bot its default
// movements once it has spawned. This module owns that setup; goal validation and the
// default-movement policy belong here too.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import pathfinderPkg from "mineflayer-pathfinder";

const { pathfinder, Movements } = pathfinderPkg;

/** A block the bot placed this host session. */
interface OwnBuild {
  x: number;
  y: number;
  z: number;
  /** The block the bot held as it placed this one, so an error can name it without a world read. */
  name: string;
}

/** What the bot placed itself this host session. */
interface OwnBuilds {
  /** Every block position the bot placed, oldest first; the pathfinder's own scaffolding is not here. */
  readonly builds: OwnBuild[];
  /** The same positions as `"x,y,z"` keys, for the exclusion closures. */
  readonly keys: Set<string>;
}

/** A block the bot may scaffold on top of: above a build within this many blocks the place exclusion bites. */
const BUILD_SCAFFOLD_REACH = 16;

/**
 * The blocks each bot placed, by the bot: a host process owns one bot per session, and the record
 * dies with it. The default movements close over it, so a later placement is excluded at once.
 */
const ownBuilds = new WeakMap<Bot, OwnBuilds>();

/** The goal shape every pathfinder goal has: `goals.GoalNear` and the plugin's other goals both. */
interface GoalLike {
  heuristic(node: unknown): number;
  isEnd(node: unknown): boolean;
}

const isGoal = (value: unknown): value is GoalLike =>
  typeof value === "object" && value !== null && "heuristic" in value && typeof value.heuristic === "function" && "isEnd" in value && typeof value.isEnd === "function";

/** The bot's own-builds registry, created on first use. */
function ownBuildsOf(bot: Bot): OwnBuilds {
  let record = ownBuilds.get(bot);
  if (record === undefined) {
    record = { builds: [], keys: new Set() };
    ownBuilds.set(bot, record);
    // A property this module adds; Mineflayer has no own-builds API. `src/routines/move.ts` reads it to name a block the bot placed.
    const carrier = bot as Bot & { ownBuilds?: OwnBuilds };
    carrier.ownBuilds = record;
  }
  return record;
}

/** A short description of a value a caller passed where a goal belongs, for the validation error. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value !== "object") return `${typeof value} ${JSON.stringify(value)}`;
  let text = "";
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  const shown = text.length > 60 ? `${text.slice(0, 60)}...` : text;
  return `an object without heuristic and isEnd${shown === "" ? "" : ` (${shown})`}`;
}

/**
 * Throws unless `goal` is a goal instance. The pathfinder only reads a goal inside its physics
 * tick, so a plain `{goal}` value otherwise throws after the run that passed it has ended, naming
 * neither the call nor the value; `null` is the way to clear `setGoal`.
 */
export function checkGoal(method: "goto" | "setGoal", goal: unknown): void {
  if (method === "setGoal" && goal === null) return;
  if (isGoal(goal)) return;
  throw new Error(
    `bot.pathfinder.${method} needs a goal object, e.g. await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)) with goals from "minebot-sdk/routine"; it got ${describe(goal)}`,
  );
}

/** Validate the goal of every `bot.pathfinder.goto` call and reject a bad one before the pathfinder sees it. */
export function validateGoals(bot: Bot): void {
  const { goto, setGoal } = bot.pathfinder;
  bot.pathfinder.goto = (goal) => {
    try {
      checkGoal("goto", goal);
    } catch (err) {
      return Promise.reject(err);
    }
    return goto.call(bot.pathfinder, goal);
  };
  bot.pathfinder.setGoal = (goal, dynamic) => {
    checkGoal("setGoal", goal);
    setGoal.call(bot.pathfinder, goal, dynamic);
  };
}

/** Record every block the bot places itself, so the default movements can keep it off its own builds. */
export function watchOwnBuilds(bot: Bot): void {
  const builds = ownBuildsOf(bot);
  const place = bot.placeBlock;
  bot.placeBlock = (reference, face) => {
    const target = reference.position.offset(face.x, face.y, face.z);
    return place.call(bot, reference, face).then((result) => {
      // The pathfinder's own scaffolding is not a build: it is placed to be dug back out.
      if (!bot.pathfinder.isBuilding()) {
        const key = `${target.x},${target.y},${target.z}`;
        if (!builds.keys.has(key)) {
          builds.keys.add(key);
          // The held block is the one that landed: the client's copy of the cell can lag the server's.
          builds.builds.push({ x: target.x, y: target.y, z: target.z, name: bot.heldItem?.name ?? bot.blockAt(target)?.name ?? "" });
        }
      }
      return result;
    });
  };
}

/** The bot's default movements: never break a block it placed, and never scaffold a cell under one within 16 blocks. */
export function defaultMovements(bot: Bot): InstanceType<typeof Movements> {
  const builds = ownBuildsOf(bot);
  const movements = new Movements(bot);
  // The plugin types the exclusion lists as one-element tuples, so a list needs a cast to build.
  const exclusions = movements as unknown as { exclusionAreasBreak: unknown; exclusionAreasPlace: unknown };
  exclusions.exclusionAreasBreak = [
    (block: Block): number => (builds.keys.has(`${block.position.x},${block.position.y},${block.position.z}`) ? Infinity : 0),
  ];
  exclusions.exclusionAreasPlace = [
    (block: Block): number => {
      const { x, y, z } = block.position;
      return builds.builds.some((build) => build.x === x && build.z === z && build.y > y && build.y <= y + BUILD_SCAFFOLD_REACH) ? Infinity : 0;
    },
  ];
  return movements;
}

/** Install everything this module owns once the bot has spawned: the plugin is loaded and its API is complete. */
export function installBodyPolicies(bot: Bot): void {
  validateGoals(bot);
  watchOwnBuilds(bot);
  bot.pathfinder.setMovements(defaultMovements(bot));
}

/** Load the pathfinder plugin now; on the bot's first spawn, validate goals, record own builds, and set the default movements. */
export function installPathfinder(bot: Bot): void {
  bot.loadPlugin(pathfinder);
  bot.once("spawn", () => installBodyPolicies(bot));
}
