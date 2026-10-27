// Own-build protection (mb-b6z) in src/host/pathfinding.ts: every block the bot places itself is
// recorded (the pathfinder's scaffolding is not), and the default movements never break a recorded
// block or scaffold a cell under one. The path search is the plugin's own A*, run here over the
// harness world, so the exclusion is checked by the planner that obeys it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { createHarness, type BlockSpec, type Harness } from "minebot-sdk/testing";
import { goals, Movements, Vec3 } from "minebot-sdk/routine";
import { installBodyPolicies } from "../src/host/pathfinding.ts";

const require = createRequire(import.meta.url);
interface ComputedPath {
  status: string;
  path: { toBreak: { x: number; y: number; z: number }[] }[];
}
const AStar = require("mineflayer-pathfinder/lib/astar") as new (start: unknown, movements: unknown, goal: unknown, timeout: number) => { compute(): ComputedPath };
const Move = require("mineflayer-pathfinder/lib/move") as new (x: number, y: number, z: number, remainingBlocks: number, cost: number) => unknown;

/** A one-wide corridor of bedrock: walls at x = ±1 and a bedrock floor, so the only diggable block is one the bot placed. */
const CORRIDOR: readonly BlockSpec[] = [
  { name: "bedrock", from: [-2, 63, -3], to: [2, 63, 10] },
  { name: "bedrock", from: [-1, 64, -3], to: [-1, 66, 10] },
  { name: "bedrock", from: [1, 64, -3], to: [1, 66, 10] },
  { name: "bedrock", from: [-1, 66, -3], to: [1, 66, 10] },
  { name: "bedrock", from: [-1, 64, -3], to: [1, 66, -3] },
  { name: "bedrock", from: [-1, 64, 10], to: [1, 66, 10] },
];

/** Runs a whole A* search: the plugin slices one `compute` at 40 ms, so keep going until it is done. */
function searchUntilDone(start: unknown, movements: unknown, goal: unknown) {
  const astar = new AStar(start, movements, goal, 20_000);
  let result = astar.compute();
  while (result.status === "partial") result = astar.compute();
  return result;
}

/** The exclusion lists as the planner calls them, without the plugin's SafeBlock fields. */
interface Exclusions {
  exclusionBreak(block: unknown): number;
  exclusionPlace(block: unknown): number;
}

/** Places the block at `at` (on the ground below it) through the bot's real `placeBlock`, as a routine does. */
async function placeAt(h: Harness, at: [number, number, number]): Promise<void> {
  const [x, y, z] = at;
  const held = h.bot.inventory.items()[0]!;
  await h.bot.equip(held, "hand");
  await h.bot.placeBlock(h.blockAt([x, y - 1, z]), new Vec3(0, 1, 0));
}

describe("own-build protection (mb-b6z)", () => {
  it("excludes a block the bot placed from breaking, so the planned path is blocked by the bot's own wall", async () => {
    const h = createHarness({ blocks: CORRIDOR, inventory: { stone: 4 } });
    installBodyPolicies(h.bot);
    await placeAt(h, [0, 64, 2]);
    await placeAt(h, [0, 65, 2]);
    assert.equal(h.blockAt([0, 64, 2]).name, "stone");
    assert.equal(h.blockAt([0, 65, 2]).name, "stone");

    const movements = h.bot.pathfinder.movements;
    const exclusions = movements as unknown as Exclusions;
    assert.equal(exclusions.exclusionBreak(h.blockAt([0, 64, 2])), Infinity, "a placed block cannot be broken");
    assert.equal(exclusions.exclusionBreak(h.blockAt([0, 65, 2])), Infinity);
    assert.equal(exclusions.exclusionBreak(h.blockAt([0, 63, 0])), 0, "the floor was not placed by the bot");

    const goal = new goals.GoalNear(0, 64, 6, 1);
    const blocked = searchUntilDone(new Move(0, 64, 0, 0, 0), movements, goal);
    assert.equal(blocked.status, "noPath", "the corridor's only diggable block is the bot's wall");

    // The mutant: without the exclusions the planner happily digs the bot's wall.
    const free = searchUntilDone(new Move(0, 64, 0, 0, 0), new Movements(h.bot), goal);
    assert.equal(free.status, "success");
    assert.ok(
      free.path.some((node) => node.toBreak.some((block) => block.x === 0 && block.y === 64 && block.z === 2)),
      "the unexcluded path cuts through the placed wall",
    );
  });

  it("excludes scaffolding a cell under a placed block within 16 blocks, and not one further below", async () => {
    const h = createHarness({ inventory: { stone: 2 } });
    installBodyPolicies(h.bot);
    await placeAt(h, [0, 64, 2]);
    const exclusions = h.bot.pathfinder.movements as unknown as Exclusions;
    assert.equal(exclusions.exclusionPlace(h.blockAt([0, 63, 2])), Infinity, "one below the build");
    assert.equal(exclusions.exclusionPlace(h.blockAt([0, 49, 2])), Infinity, "15 below the build");
    assert.equal(exclusions.exclusionPlace(h.blockAt([0, 47, 2])), 0, "17 below the build is out of reach");
    assert.equal(exclusions.exclusionPlace(h.blockAt([0, 64, 2])), 0, "the build's own cell is not above it");
    assert.equal(exclusions.exclusionPlace(h.blockAt([1, 63, 2])), 0, "another column is not affected");
  });

  it("does not record the pathfinder's own scaffolding", async () => {
    const h = createHarness({ inventory: { stone: 4 } });
    installBodyPolicies(h.bot);
    const pathfinder = h.bot.pathfinder as unknown as { isBuilding: () => boolean };
    pathfinder.isBuilding = () => true;
    await placeAt(h, [0, 64, 2]);
    const exclusions = h.bot.pathfinder.movements as unknown as Exclusions;
    assert.equal(exclusions.exclusionBreak(h.blockAt([0, 64, 2])), 0, "scaffolding is placed to be dug back out");

    pathfinder.isBuilding = () => false;
    await placeAt(h, [0, 64, 3]);
    assert.equal(exclusions.exclusionBreak(h.blockAt([0, 64, 3])), Infinity, "the bot's own placement is recorded");
  });
});
