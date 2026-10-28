// move.to a column without a y (mb-znn.27): position { x, z } walks to that column's surface and
// returns the standing position; { x, y, z } keeps the exact point and the GoalNear goal.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

interface CapturedGoal {
  constructor: { name: string };
  x?: number;
  y?: number;
  z?: number;
  rangeSq?: number;
}

/** A harness recording the goal its pathfinder is given, over the default ground (stone at y 63). */
function capturingHarness() {
  const h = createHarness();
  const found: CapturedGoal[] = [];
  const pathfinder = h.bot.pathfinder as unknown as { goto: (goal: CapturedGoal) => Promise<void> };
  const goto = pathfinder.goto.bind(pathfinder);
  pathfinder.goto = (goal) => {
    found.push(goal);
    return goto(goal);
  };
  return { h, found };
}

describe("move.to a column without a y (mb-znn.27)", () => {
  it("walks to the surface of { x, z } and returns where the player stands", async () => {
    const { h, found } = capturingHarness();
    assert.deepEqual(await h.run(move.to, { position: { x: 10, z: 5 } }), { x: 10, y: 64, z: 5 });
    assert.equal(found[0]?.constructor.name, "GoalNearXZ", "a column goal lets the pathfinder pick the height");
    assert.equal(found[0]?.x, 10);
    assert.equal(found[0]?.z, 5);
    assert.equal(found[0]?.y, undefined);
  });

  it("still takes { x, y, z } as the exact point, unchanged", async () => {
    const { h, found } = capturingHarness();
    assert.deepEqual(await h.run(move.to, { position: { x: 10, y: 64, z: 5 }, range: 0 }), { x: 10, y: 64, z: 5 });
    assert.equal(found[0]?.constructor.name, "GoalNear");
    assert.deepEqual([found[0]?.x, found[0]?.y, found[0]?.z], [10, 64, 5]);
  });

  it("counts a standing position within range in xz as there", async () => {
    const { h } = capturingHarness();
    // The harness pathfinder teleports to the nearest standable spot that satisfies the goal;
    // range 0 pins the column, range 1 also admits it, and both report the same floored feet.
    assert.deepEqual(await h.run(move.to, { position: { x: 10, z: 5 }, range: 0 }), { x: 10, y: 64, z: 5 });
    assert.deepEqual(await h.run(move.to, { position: { x: 10, z: 5 }, range: 1 }), { x: 10, y: 64, z: 5 });
  });
});
