// move.to's progress watchdog and its path-end settlement (mb-jfa.5). The harness pathfinder teleports, so
// these tests replace `goto` with stubs that replay the plugin's event stream (path_update, goal_reached) —
// once with the plugin's own lib/goto.js — and drive the watchdog's clock with mock timers. The live
// behavior is probed on the dev server.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** The plugin's own `goto`, whose settling rules the stubs replay. */
const realGoto = require("mineflayer-pathfinder/lib/goto.js") as (bot: unknown, goal: unknown) => Promise<void>;

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

/** The plugin's re-search API, which the harness leaves out: every explanation search finds no way. */
function noResearches(h: Harness) {
  const pathfinder = h.bot.pathfinder as unknown as { getPathFromTo: () => IterableIterator<{ result: unknown }> };
  pathfinder.getPathFromTo = () =>
    (function* slices(): Generator<{ result: unknown }> {
      yield { result: { status: "noPath", path: [] } };
    })();
}

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
  it("throws when a `goto` that reports nothing at all ends the walk farther than `range`", async () => {
    // The plugin's `goto` always reports its searches; a stub that resolves silently ends where the player stands.
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

  /**
   * A harness whose pathfinder behaves as the plugin's `goto` does when A* has only a partial result yet: it sets
   * the goal, reports an empty 'partial' path, and resolves. The search goes on; `then` plays its end on a later turn.
   */
  function searchingHarness(then: (h: Harness, goal: unknown) => void) {
    const h = createHarness();
    const pathfinder = h.bot.pathfinder as unknown as { goal: unknown; goto: (goal: unknown) => Promise<void> };
    pathfinder.goto = async (goal) => {
      pathfinder.goal = goal;
      h.bot.emit("path_update", { status: "partial", path: [] } as never);
      setImmediate(() => then(h, goal));
    };
    return { h, pathfinder };
  }

  it("waits past an empty path found while the search goes on, and resolves when the walk then arrives", async () => {
    const { h } = searchingHarness((h, goal) => {
      h.teleport([10.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal as never);
    });
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 1 }), { x: 10, y: 64, z: 0 });
  });

  it("throws once the search ends with no way closer, naming why, and stops pathfinding first", async () => {
    const { h, pathfinder } = searchingHarness((h) => h.bot.emit("path_update", { status: "timeout", path: [] } as never));
    await assert.rejects(
      h.run(move.to, { position: [10, 64, 0], range: 1 }),
      /^Error: could not reach \(10, 64, 0\): stopped at \(0, 64, 0\), 10\.0 blocks away; the path search ran out of time$/,
    );
    assert.equal(pathfinder.goal, null, "the goal was cleared");
  });

  it("reports a search the plugin's `goto` rejects ('NoPath', 'Timeout') as could-not-reach with its cause, and stops pathfinding", async () => {
    const cases = [
      { status: "timeout", name: "Timeout", message: "Took to long to decide path to goal!", why: "the path search ran out of time" },
      { status: "noPath", name: "NoPath", message: "No path to the goal!", why: "the pathfinder found no way there from here" },
    ];
    for (const { status, name, message, why } of cases) {
      const h = createHarness();
      noResearches(h);
      const pathfinder = h.bot.pathfinder as unknown as { goal: unknown; goto: (goal: unknown) => Promise<void> };
      // As the plugin: the search ends with a partial path toward the goal, and `goto` rejects.
      pathfinder.goto = async (goal) => {
        pathfinder.goal = goal;
        h.bot.emit("path_update", { status, path: [{ x: 1, y: 64, z: 0 }] } as never);
        throw Object.assign(new Error(message), { name });
      };
      await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), {
        message: `could not reach (10, 64, 0): stopped at (0, 64, 0), 10.0 blocks away; ${why}`,
      });
      assert.equal(pathfinder.goal, null, `${status}: the goal was cleared`);
    }
  });

  /**
   * A harness whose `goto` plays `script` with the goal set and then resolves. Under load the plugin's
   * `goto` settles an empty 'partial' path while the same synchronous batch (physics catching up overdue
   * ticks) reports the path the search went on to find.
   */
  function batchHarness(script: (h: Harness) => void) {
    const h = createHarness();
    const pathfinder = h.bot.pathfinder as unknown as { goal: unknown; goto: (goal: object) => Promise<void> };
    pathfinder.goto = (goal) => {
      pathfinder.goal = goal;
      script(h);
      return Promise.resolve();
    };
    return { h, pathfinder };
  }

  /** Runs `move.to` toward (10, 64, 0); `settled()` says "pending" while the walk waits. */
  function runTo(h: Harness, range = 1) {
    let settled: unknown = "pending";
    const done = h.run(move.to, { position: [10, 64, 0], range });
    void done.then(
      (value) => {
        settled = { ok: value };
      },
      (err: unknown) => {
        settled = err;
      },
    );
    return { done, settled: () => settled };
  }

  it("keeps waiting through an empty partial followed by a non-empty partial in one batch, and resolves on goal_reached", async () => {
    const { h, pathfinder } = batchHarness((h) => {
      h.bot.emit("path_update", { status: "partial", path: [] } as never);
      h.bot.emit("path_update", { status: "partial", path: [{ x: 5, y: 64, z: 0 }] } as never);
    });
    const walk = runTo(h);
    await settle();
    await settle();
    assert.equal(walk.settled(), "pending", "a batch that ends on a walkable path is not an end, whatever `goto` made of its first update");
    h.teleport([10.5, 64, 0.5]);
    h.bot.emit("goal_reached", pathfinder.goal as never);
    assert.deepEqual(await walk.done, { x: 10, y: 64, z: 0 });
  });

  it("waits through a reachable goal's whole search — empty partial, non-empty partial, non-empty success — across ticks", async () => {
    const { h, pathfinder } = batchHarness((h) => {
      h.bot.emit("path_update", { status: "partial", path: [] } as never);
      setImmediate(() => {
        h.bot.emit("path_update", { status: "partial", path: [{ x: 5, y: 64, z: 0 }] } as never);
        h.bot.emit("path_update", { status: "success", path: [{ x: 5, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }] } as never);
      });
    });
    const walk = runTo(h);
    await settle();
    await settle();
    assert.equal(walk.settled(), "pending", "a path to walk is not an end");
    h.teleport([10.5, 64, 0.5]);
    h.bot.emit("goal_reached", pathfinder.goal as never);
    assert.deepEqual(await walk.done, { x: 10, y: 64, z: 0 });
  });

  it("throws could-not-reach, naming no way, when the search ends 'noPath' with an empty path", async () => {
    const { h, pathfinder } = batchHarness((h) => h.bot.emit("path_update", { status: "noPath", path: [] } as never));
    noResearches(h);
    await assert.rejects(
      h.run(move.to, { position: [10, 64, 0], range: 1 }),
      /^Error: could not reach \(10, 64, 0\): stopped at \(0, 64, 0\), 10\.0 blocks away; the pathfinder found no way there from here$/,
    );
    assert.equal(pathfinder.goal, null, "the goal was cleared");
  });

  it("throws could-not-reach when the search ends 'success' with an empty path and the player is outside range", async () => {
    const { h } = batchHarness((h) => h.bot.emit("path_update", { status: "success", path: [] } as never));
    await assert.rejects(
      h.run(move.to, { position: [10, 64, 0], range: 1 }),
      /^Error: could not reach \(10, 64, 0\): stopped at \(0, 64, 0\), 10\.0 blocks away; the pathfinder found no way there from here$/,
    );
  });

  it("resolves when the search ends 'success' with an empty path and the player is already within range", async () => {
    const { h } = batchHarness((h) => {
      h.teleport([10.5, 64, 0.5]);
      h.bot.emit("path_update", { status: "success", path: [] } as never);
    });
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 1 }), { x: 10, y: 64, z: 0 });
  });

  it("keeps waiting when the plugin's own `goto` (lib/goto.js) resolves an empty partial that the same batch supersedes", async () => {
    const h = createHarness();
    const bot = h.bot as unknown as {
      emit: (event: string, ...args: unknown[]) => void;
      pathfinder: { goto: (goal: unknown) => Promise<void>; setGoal: (goal: unknown) => void };
    };
    let goal: unknown;
    const { pathfinder } = bot;
    pathfinder.setGoal = (next) => {
      goal = next;
      bot.emit("goal_updated", next, false);
    };
    let gotoDone: Promise<void> | undefined;
    pathfinder.goto = (next) => (gotoDone = realGoto(bot, next));
    const walk = runTo(h);
    await settle();
    // The load case: `goto` settles the empty partial while the same synchronous batch walks on.
    bot.emit("path_update", { status: "partial", path: [] });
    bot.emit("path_update", { status: "partial", path: [{ x: 5, y: 64, z: 0 }] });
    // `goto` resolves on its own timer; move.to's handler for that runs before this await returns.
    await gotoDone;
    await settle();
    assert.equal(walk.settled(), "pending", "`goto` resolving is not the walk's end");
    h.teleport([10.5, 64, 0.5]);
    bot.emit("goal_reached", goal);
    assert.deepEqual(await walk.done, { x: 10, y: 64, z: 0 });
  });
});
