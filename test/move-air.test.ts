// move.to out of air (mb-znn.2c): when the breath bar falls under 10 during a walk, the walk stops
// pathfinding, holds jump until the head is out of water (or 8 s), and throws an error that says
// where it surfaced and that the path runs underwater.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);

describe("move.to out of air (mb-znn.2c)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("stops the walk, swims up holding jump, and says the path runs underwater", async () => {
    const h = createHarness({ blocks: [{ name: "water", from: [-1, 65, -1], to: [1, 66, 1] }] });
    const stops: unknown[] = [];
    const pathfinder = h.bot.pathfinder as unknown as { goto: () => Promise<void>; setGoal: (goal: unknown) => void };
    pathfinder.goto = () => new Promise<void>(() => {});
    pathfinder.setGoal = (goal) => void stops.push(goal);
    const controls: [string, boolean][] = [];
    const setControlState = h.bot.setControlState.bind(h.bot);
    h.bot.setControlState = (control, state) => {
      controls.push([control, state]);
      setControlState(control, state);
    };
    h.bot.oxygenLevel = 4;

    let outcome: unknown = "pending";
    void h.run(move.to, { position: [10, 64, 0], range: 1 }).then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    await settle();
    mock.timers.tick(500); // the first air sample at 100 ms
    await settle();
    await settle();
    assert.deepEqual(controls.at(-1), ["jump", true], "jump is held to swim up");
    assert.deepEqual(stops, [null], "pathfinding was stopped");

    h.teleport([0.5, 70, 0.5]); // the head leaves the water
    mock.timers.tick(500);
    await settle();
    await settle();
    assert.match(message(outcome), /^out of air at \(0, 64, 0\): swam up to \(0, 70, 0\); the path to \(10, 64, 0\) runs underwater - go around the water$/);
    assert.deepEqual(controls.at(-1), ["jump", false], "jump was released");
  });

  it("leaves a walk alone while the breath bar is at 10 or above", async () => {
    const h = createHarness({ blocks: [{ name: "water", from: [-1, 65, -1], to: [1, 66, 1] }] });
    const pathfinder = h.bot.pathfinder as unknown as { goto: (goal: unknown) => Promise<void> };
    pathfinder.goto = (goal) => {
      h.bot.emit("goal_reached", goal);
      return Promise.resolve();
    };
    h.bot.oxygenLevel = 10;
    await h.run(move.to, { position: [10, 64, 0], range: 60 });
    mock.timers.tick(1_000);
    await settle();
  });
});
