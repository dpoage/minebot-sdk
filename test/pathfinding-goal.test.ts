// Goal validation in src/host/pathfinding.ts (mb-znn.1): a value that is not a goal instance is
// refused at the call, with a message that names the call and the value. Without the wrapper the
// pathfinder only reads the goal in its physics tick, so `goto({ goal })` throws after the run that
// passed it has ended.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import { goals } from "minebot-sdk/routine";
import { checkGoal, validateGoals } from "../src/host/pathfinding.ts";

const EXAMPLE = 'e.g. await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)) with goals from "minebot-sdk/routine"';

describe("pathfinder goal validation (mb-znn.1)", () => {
  it("rejects `goto({ goal })` at once, naming the call, an example goal, and the value", async () => {
    const h = createHarness();
    validateGoals(h.bot);
    await assert.rejects(h.bot.pathfinder.goto({ goal: { x: 1, y: 64, z: 0 } } as never), {
      message: `bot.pathfinder.goto needs a goal object, ${EXAMPLE}; it got an object without heuristic and isEnd ({"goal":{"x":1,"y":64,"z":0}})`,
    });
    // The bot is unharmed: a real goal still walks.
    await h.bot.pathfinder.goto(new goals.GoalNear(3, 64, 0, 1));
    assert.deepEqual(h.position.floored().toArray(), [3, 64, 0]);
  });

  it("rejects undefined, null, arrays, and plain numbers for goto; setGoal takes null to stop", async () => {
    const h = createHarness();
    validateGoals(h.bot);
    await assert.rejects(h.bot.pathfinder.goto(undefined as never), /it got undefined$/);
    await assert.rejects(h.bot.pathfinder.goto(null as never), /it got null$/);
    await assert.rejects(h.bot.pathfinder.goto([1, 2] as never), /it got an array of 2$/);
    await assert.rejects(h.bot.pathfinder.goto(5 as never), /it got number 5$/);
    assert.throws(() => h.bot.pathfinder.setGoal({ goal: {} } as never), {
      message: `bot.pathfinder.setGoal needs a goal object, ${EXAMPLE}; it got an object without heuristic and isEnd ({"goal":{}})`,
    });
    h.bot.pathfinder.setGoal(null);
    await assert.rejects(h.bot.pathfinder.goto({ heuristic: () => 0 } as never), /it got an object without heuristic and isEnd \({}\)$/, "both functions are needed");
  });

  it("accepts the goal shape every pathfinder goal has and nothing less", () => {
    assert.doesNotThrow(() => checkGoal("goto", { heuristic: () => 0, isEnd: () => true }));
    assert.doesNotThrow(() => checkGoal("setGoal", null));
    assert.throws(() => checkGoal("goto", { isEnd: () => true }), /an object without heuristic and isEnd/);
  });
});
