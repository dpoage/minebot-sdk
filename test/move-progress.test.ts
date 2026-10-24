// move.to's progress watchdog and its end-of-walk distance check (mb-jfa.5). The harness pathfinder teleports,
// so these tests replace `goto` with one that never finishes (a stalled player) or one that finishes where it
// stands (an empty path), and drive the watchdog's clock with mock timers. The live behavior is probed on the dev server.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

const settle = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/** A harness whose pathfinder never finishes, and the goals it was told to drop. */
function stalledHarness() {
  const h = createHarness();
  const stops: unknown[] = [];
  const pathfinder = h.bot.pathfinder as unknown as { goto: () => Promise<void>; setGoal: (goal: unknown) => void };
  pathfinder.goto = () => new Promise<void>(() => {});
  pathfinder.setGoal = (goal) => void stops.push(goal);
  return { h, stops };
}

/** Starts `move.to` toward (10, 64, 0) and reports how it settled; `elapse` passes mock time in 500 ms samples. */
function startWalk(h: Harness, timeoutMs: number) {
  let outcome: unknown = "pending";
  void h.run(move.to, { position: [10, 64, 0], range: 1, timeoutMs }).then(
    (value) => (outcome = { resolved: value }),
    (err: unknown) => (outcome = err),
  );
  return {
    outcome: () => outcome,
    async elapse(ms: number, each?: (elapsed: number) => void) {
      for (let elapsed = 500; elapsed <= ms; elapsed += 500) {
        mock.timers.tick(500);
        each?.(elapsed);
        await settle();
      }
    },
  };
}

const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);

describe("move.to progress watchdog", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("rejects a walk that makes no progress within 12 s, stops pathfinding, and names where the player is", async () => {
    const { h, stops } = stalledHarness();
    const walk = startWalk(h, 60_000);
    await settle();
    await walk.elapse(11_500);
    assert.equal(walk.outcome(), "pending", "a quiet walk is allowed 12 s");
    await walk.elapse(500);
    assert.match(message(walk.outcome()), /^stuck at \(0, 64, 0\), 10\.0 blocks from \(10, 64, 0\)/);
    assert.deepEqual(stops, [null], "pathfinding was stopped");
  });

  it("leaves a timeout shorter than the window to the timeout", async () => {
    const { h } = stalledHarness();
    const walk = startWalk(h, 5_000);
    await settle();
    await walk.elapse(5_500);
    assert.match(message(walk.outcome()), /pathfinding took longer than 5000 ms/);
  });

  it("never rejects a player who is digging at each sample, however long the dig", async () => {
    const { h } = stalledHarness();
    h.bot.targetDigBlock = h.blockAt([0, 63, 0]);
    const walk = startWalk(h, 40_000);
    await settle();
    await walk.elapse(40_500);
    assert.match(message(walk.outcome()), /pathfinding took longer than 40000 ms/, "only the timeout ended it");
  });

  it("counts a block change within 6 blocks of the eyes as progress, and one farther away as none", async () => {
    const near = stalledHarness();
    const nearWalk = startWalk(near.h, 40_000);
    await settle();
    await nearWalk.elapse(40_500, (elapsed) => {
      if (elapsed % 10_000 === 0) near.h.bot.emit("blockUpdate", null, near.h.blockAt([3, 64, 3]));
    });
    assert.match(message(nearWalk.outcome()), /pathfinding took longer than 40000 ms/, "block changes every 10 s keep the walk alive");

    const far = stalledHarness();
    const farWalk = startWalk(far.h, 40_000);
    await settle();
    await farWalk.elapse(12_500, (elapsed) => {
      if (elapsed === 6_000) far.h.bot.emit("blockUpdate", null, far.h.blockAt([-20, 64, 0]));
    });
    assert.match(message(farWalk.outcome()), /^stuck at /, "a block changing 20 blocks away is not progress");
  });

  it("counts moving a block as progress, and moving less than a block as none", async () => {
    const moving = stalledHarness();
    const movingWalk = startWalk(moving.h, 40_000);
    await settle();
    await movingWalk.elapse(40_500, (elapsed) => {
      if (elapsed % 10_000 === 0) moving.h.teleport([0.5 + elapsed / 10_000, 64, 0.5]);
    });
    assert.match(message(movingWalk.outcome()), /pathfinding took longer than 40000 ms/, "a block every 10 s keeps the walk alive");

    const shuffling = stalledHarness();
    const shufflingWalk = startWalk(shuffling.h, 40_000);
    await settle();
    await shufflingWalk.elapse(12_500, (elapsed) => {
      if (elapsed === 5_000) shuffling.h.teleport([1.3, 64, 0.5]);
    });
    assert.match(message(shufflingWalk.outcome()), /^stuck at /, "0.8 blocks is not a block");
  });
});

describe("move.to end-of-walk distance", () => {
  it("throws when the pathfinder finishes farther than `range`, as it does for an empty path", async () => {
    const h = createHarness();
    (h.bot.pathfinder as unknown as { goto: () => Promise<void> }).goto = async () => {};
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), /could not reach \(10, 64, 0\): stopped at \(0, 64, 0\), 10\.0 blocks away/);
  });

  it("resolves with where the player stands when the walk ends within `range`", async () => {
    const h = createHarness();
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 2 }), { x: 10, y: 64, z: 0 });
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 0 }), { x: 10, y: 64, z: 0 }, "already there");
  });

  it("trusts a goal the pathfinder reported reached, though the player has drifted past `range` since", async () => {
    const h = createHarness();
    const pathfinder = h.bot.pathfinder as unknown as { goto: (goal: unknown) => Promise<void> };
    pathfinder.goto = async (goal) => {
      h.bot.emit("goal_reached", goal as never);
      h.teleport([11.5, 64, 0.5]);
    };
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 0 }), { x: 11, y: 64, z: 0 });
  });
});
