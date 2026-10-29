// combat's chases run on movements that never dig or place a block, and the player's own
// movements are back afterwards (mb-e9m). The plugin's own A*, run over the harness world, shows
// what those rules buy: the fence of a pen no longer gives way. A chase that cannot get in ends
// as the blocked reason instead.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { createHarness, type BlockSpec, type Harness } from "minebot-sdk/testing";
import { goals, Movements } from "minebot-sdk/routine";
import { attack, fight } from "../src/routines/combat.ts";

const require = createRequire(import.meta.url);
interface PathNode {
  x: number;
  y: number;
  z: number;
  toBreak: { x: number; y: number; z: number }[];
  toPlace: { x: number; y: number; z: number }[];
}
interface ComputedPath {
  status: string;
  path: PathNode[];
}
const AStar = require("mineflayer-pathfinder/lib/astar") as new (start: unknown, movements: unknown, goal: unknown, timeout: number) => { compute(): ComputedPath };
const Move = require("mineflayer-pathfinder/lib/move") as new (x: number, y: number, z: number, remainingBlocks: number, cost: number) => unknown;

/** The plugin slices one search at 40 ms, so keep going until it is done; a search with no way there ends at the cap. */
function search(start: unknown, movements: unknown, goal: unknown): ComputedPath {
  const astar = new AStar(start, movements, goal, 1_500);
  let result = astar.compute();
  while (result.status === "partial") result = astar.compute();
  return result;
}

/** A one-high oak_fence pen on bedrock: 5 by 5, its inside at (7, 64, 0), its west wall at x = 5. */
const PEN: BlockSpec[] = [];
const FENCE_CELLS = new Set<string>();
for (let x = 5; x <= 9; x++) {
  for (let z = -2; z <= 2; z++) {
    if (x !== 5 && x !== 9 && z !== -2 && z !== 2) continue;
    PEN.push({ name: "oak_fence", at: [x, 64, z] });
    FENCE_CELLS.add(`${x},64,${z}`);
  }
}

/** The harness's flock inside the pen, and the player's own movements installed as the body does on spawn. */
function pen(): { h: Harness; normal: InstanceType<typeof Movements>; seen: InstanceType<typeof Movements>[] } {
  const h = createHarness({ ground: { y: 63, name: "bedrock" }, blocks: [...PEN], entities: [{ name: "sheep", at: [7, 64, 0] }] });
  const set = h.bot.pathfinder.setMovements.bind(h.bot.pathfinder);
  const normal = new Movements(h.bot);
  set(normal);
  const seen: InstanceType<typeof Movements>[] = [];
  h.bot.pathfinder.setMovements = (movements) => {
    seen.push(movements);
    set(movements);
  };
  // The sheep never dies here: the chase rules are what is under test, not the hits.
  h.bot.attack = () => {};
  return { h, normal, seen };
}

/** Runs `attack` at the penned sheep and returns the movements it chased on. */
async function chasedMovements(run: (h: Harness) => Promise<unknown>): Promise<{ h: Harness; normal: InstanceType<typeof Movements>; chase: InstanceType<typeof Movements> }> {
  const { h, normal, seen } = pen();
  await run(h);
  const chase = seen.find((movements) => movements !== normal);
  assert.ok(chase, "the chase never set movements of its own");
  return { h, normal, chase };
}

describe("combat chases never dig or place, and the player's movements come back (P4.2)", () => {
  it("attack: the chase's rules switch digging and building off, and the default movements are back afterwards", async () => {
    const { h, normal, chase } = await chasedMovements((h) => h.run(attack, { target: "sheep", timeoutMs: 300 }));
    assert.equal(chase.canDig, false, "the chase could dig");
    assert.equal(chase.allow1by1towers, false, "the chase could build a tower");
    assert.deepEqual(chase.scafoldingBlocks, [], "the chase could scaffold");
    assert.equal(chase.canOpenDoors, normal.canOpenDoors, "the player's door setting carries over");
    assert.equal(chase.exclusionAreasBreak, normal.exclusionAreasBreak, "the own-build exclusions carry over");
    assert.equal(chase.maxDropDown, normal.maxDropDown, "the player's fall height carries over");
    assert.equal(h.bot.pathfinder.movements, normal, "the player's own movements were not put back");
  });

  it("fight: the same rules, and the default movements are back afterwards", async () => {
    const { h, normal, chase } = await chasedMovements((h) => h.run(fight, { targets: "sheep", timeoutMs: 300 }));
    assert.equal(chase.canDig, false, "the chase could dig");
    assert.equal(chase.allow1by1towers, false, "the chase could build a tower");
    assert.deepEqual(chase.scafoldingBlocks, [], "the chase could scaffold");
    assert.equal(h.bot.pathfinder.movements, normal, "the player's own movements were not put back");
  });

  it("a chase's rules leave a fenced pen intact where the player's default movements break it", async () => {
    const { h, normal, chase } = await chasedMovements((h) => h.run(attack, { target: "sheep", timeoutMs: 300 }));
    const start = new Move(0, 64, 0, 0, 0);
    const goal = new goals.GoalNear(7, 64, 0, 1);
    const fenced = search(start, chase, goal);
    for (const node of fenced.path) {
      for (const cell of node.toBreak) assert.equal(FENCE_CELLS.has(`${cell.x},${cell.y},${cell.z}`), false, `the chase would break the fence at ${cell.x},${cell.y},${cell.z}`);
      assert.deepEqual(node.toPlace, [], `the chase would place a block at ${node.x},${node.y},${node.z}`);
    }
    const penBreaking = search(start, normal, goal);
    assert.ok(
      penBreaking.path.some((node) => node.toBreak.some((cell) => h.blockAt([cell.x, cell.y, cell.z]).name === "oak_fence")),
      "the default movements do not break the pen, so this scenario grounds nothing",
    );
  });
});
