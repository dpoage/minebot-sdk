// move.to path-ended-short (mb-cl2): a path that finishes and leaves the player out of range, with
// the pathfinder idle for 10 physics ticks, ends the walk at once with "the path ended N blocks
// short" — not after the 12 s stuck watchdog. Mock timers keep the watchdog's clock still, so a
// result that arrives after ten emitted ticks cannot be the watchdog's.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);

/** A harness whose pathfinder set a two-node path and then stopped reporting; `setMoving` says whether it is still walking it. */
function shortPathHarness() {
  const h = createHarness();
  const pathfinder = h.bot.pathfinder as unknown as {
    goal: unknown;
    goto: (goal: unknown) => Promise<void>;
    isMoving: () => boolean;
    setGoal: (goal: unknown) => void;
  };
  const stillWalking = Promise.withResolvers<void>();
  let moving = true;
  pathfinder.isMoving = () => moving;
  pathfinder.goto = (goal) => {
    pathfinder.goal = goal;
    h.bot.emit("path_update", { status: "success", path: [{ x: 5, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }] } as never);
    return stillWalking.promise;
  };
  return { h, pathfinder, setMoving: (value: boolean) => (moving = value) };
}

describe("move.to path ended short (mb-cl2)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("ends after 10 idle physics ticks with the distance, before any watchdog sample", async () => {
    const { h, setMoving } = shortPathHarness();
    const startedAt = Date.now();
    const done = h.run(move.to, { position: [10, 64, 0], range: 1 });
    let outcome: unknown = "pending";
    void done.then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    await settle();
    setMoving(false); // the pathfinder walked its last node and went idle
    for (let tick = 0; tick < 9; tick++) h.bot.emit("physicsTick");
    await settle();
    assert.equal(outcome, "pending", "nine quiet ticks are not an end");

    h.bot.emit("physicsTick");
    await settle();
    await settle();
    assert.equal(message(outcome), "could not reach (10, 64, 0): the path ended 10.0 blocks short");
    // The mocked clock never advanced, so neither the 500 ms progress sample nor the 12 s stuck window ran.
    assert.equal(Date.now(), startedAt);
  });

  it("keeps waiting while the pathfinder is still walking, and resolves when the goal arrives", async () => {
    const { h, pathfinder } = shortPathHarness();
    const done = h.run(move.to, { position: [10, 64, 0], range: 1 });
    await settle();
    for (let tick = 0; tick < 20; tick++) h.bot.emit("physicsTick"); // isMoving() is true the whole time
    h.teleport([10.5, 64, 0.5]);
    h.bot.emit("goal_reached", pathfinder.goal);
    assert.deepEqual(await done, { x: 10, y: 64, z: 0 });
  });
});
