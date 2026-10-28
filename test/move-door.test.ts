// move.to through a closed wooden door (mb-q8g): a walk that cannot reach its goal because of a
// closed wooden door near it walks to the door, opens it, and tries the goal once more; an iron
// door is never opened. The plugin's own canOpenDoors path is not used: it crashes its executor on
// the single useOne move a door plans (verified live on the dev server).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

interface StubGoal {
  x: number;
  y: number;
  z: number;
}

interface StubPathfinder {
  movements: unknown;
  goal: unknown;
  goto: (goal: StubGoal) => Promise<void>;
  setMovements: (movements: unknown) => void;
  getPathFromTo: () => IterableIterator<{ result: unknown }>;
}

/**
 * A harness with a closed door at (4, 64, 0) and a goal behind it at (5, 64, 0): the pathfinder
 * finds no way to the goal while the door is closed, walks to the door when asked, and reaches the
 * goal once the door is open. `activateBlock` opens both halves and counts the calls.
 */
function doorScene(name: "spruce_door" | "iron_door") {
  const h = createHarness();
  h.setBlock([4, 64, 0], name, { half: "lower", open: false, facing: "east", hinge: "left" });
  h.setBlock([4, 65, 0], name, { half: "upper", open: false, facing: "east", hinge: "left" });
  const pathfinder = h.bot.pathfinder as unknown as StubPathfinder;
  pathfinder.goto = async (goal) => {
    if (goal.x === 4 && goal.z === 0) {
      h.teleport([3.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
      return;
    }
    if (h.blockAt([4, 64, 0]).getProperties().open !== true) {
      h.bot.emit("path_update", { status: "noPath", path: [] } as never);
      return;
    }
    h.teleport([5.5, 64, 0.5]);
    h.bot.emit("goal_reached", goal);
  };
  pathfinder.getPathFromTo = () =>
    (function* slices(): Generator<{ result: unknown }> {
      yield { result: { status: "noPath", path: [] } };
    })();
  let activations = 0;
  h.bot.activateBlock = async (block) => {
    activations++;
    const open = { half: block.getProperties().half, open: true, facing: "east", hinge: "left" };
    h.setBlock(block.position, name, open);
    h.setBlock([4, 65, 0], name, { ...open, half: "upper" });
  };
  return { h, activations: () => activations };
}

describe("move.to through a closed wooden door (mb-q8g)", () => {
  it("opens the door and walks through without breaking a block", async () => {
    const { h, activations } = doorScene("spruce_door");
    const before = h.blockAt([4, 64, 0]).name;
    assert.deepEqual(await h.run(move.to, { position: [5, 64, 0], range: 0 }), { x: 5, y: 64, z: 0 });
    assert.equal(activations(), 1, "the door is activated once");
    assert.equal(h.blockAt([4, 64, 0]).getProperties().open, true, "the door stayed open");
    assert.equal(h.blockAt([4, 64, 0]).name, before, "the door is not broken");
    assert.equal(h.blockAt([4, 65, 0]).name, before, "neither half is broken");
  });

  it("leaves an iron door closed and keeps the could-not-reach error", async () => {
    const { h, activations } = doorScene("iron_door");
    await assert.rejects(h.run(move.to, { position: [5, 64, 0], range: 0 }), /could not reach \(5, 64, 0\)/);
    assert.equal(activations(), 0, "no hand opens an iron door");
    assert.equal(h.blockAt([4, 64, 0]).getProperties().open, false);
  });
});
