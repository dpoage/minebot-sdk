// gatherer.gather and dig reach (mb-jfa.5 fix rounds): a block already in dig reach is dug without a walk, and a
// block whose walk ended short is dug when the walk left it in reach.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as gatherer from "../src/routines/gatherer.ts";

interface Goal {
  y: number;
}
/** The harness types `bot.pathfinder` as the plugin's API, whose members a test may not reassign. */
const pathfinderOf = (h: Harness) => h.bot.pathfinder as unknown as { goto: (goal: Goal) => Promise<void> };

/** The `move.to` calls the harness saw toward `cell`. */
function walksTo(h: Harness, cell: { x: number; y: number; z: number }) {
  return h.calls.filter((c) => {
    if (c.kit !== "move" || c.action !== "to") return false;
    const args: unknown = c.args;
    return typeof args === "object" && args !== null && "position" in args && JSON.stringify(args.position) === JSON.stringify(cell);
  });
}

describe("gatherer.gather and dig reach", () => {
  it("digs the logs of a tall trunk within reach without walking, and skips the one beyond when the walk to it fails", async () => {
    const h = createHarness({ position: [0.5, 64, 0.5], blocks: [{ name: "oak_log", from: [1, 64, 0], to: [1, 70, 0] }] });
    // A pathfinder that finds no way anywhere: each walk ends where the player stands ('could not reach').
    pathfinderOf(h).goto = async () => {};
    // From the eyes at y 65.62, logs up to y 69 are within 4.5 blocks; the log at y 70 is 5.0 away.
    assert.deepEqual(await h.run(gatherer.gather, { blocks: "oak_log", count: 7 }), { dug: 6, gained: { oak_log: 6 }, skipped: 1 });
    assert.equal(h.blockAt([1, 70, 0]).name, "oak_log");
    for (let y = 64; y <= 69; y++) assert.equal(walksTo(h, { x: 1, y, z: 0 }).length, 0, `no walk toward the log at y ${y}`);
  });

  it("digs a block whose walk ended short of `range` but in dig reach", async () => {
    const h = createHarness({ position: [0.5, 64, 0.5], blocks: [{ name: "oak_log", from: [5, 68, 0], to: [5, 68, 0] }] });
    const pathfinder = pathfinderOf(h);
    const walk = pathfinder.goto.bind(pathfinder);
    // The walk to the log gets the player to (3, 64, 0) and the pathfinder finds no way on: 3.6 blocks from the log,
    // beyond range 3, while the eyes are 3.5 blocks from its centre. Other walks (to the drop) go as the harness's do.
    pathfinder.goto = async (goal) => (goal.y === 68 ? h.teleport([3.5, 64, 0.5]) : walk(goal));
    assert.deepEqual(await h.run(gatherer.gather, { blocks: "oak_log", count: 1 }), { dug: 1, gained: { oak_log: 1 }, skipped: 0 });
    assert.equal(walksTo(h, { x: 5, y: 68, z: 0 }).length, 1);
  });
});
