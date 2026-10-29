// move.to height diagnosis (mb-znn.26): a could-not-reach whose goal stands more than range+1
// blocks above or below its column's ground names the ground y and the distance; an unloaded
// column says so. The drop and own-build explanations keep their own text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);

interface StubPathfinder {
  goto: () => Promise<void>;
  getPathFromTo: () => IterableIterator<{ result: unknown }>;
}

/** A harness on the default ground (stone at y 63, so the standable ground y is 64) whose pathfinder finds no way anywhere. */
function noPathHarness() {
  const h = createHarness();
  const pathfinder = h.bot.pathfinder as unknown as StubPathfinder;
  pathfinder.goto = async () => {
    h.bot.emit("path_update", { status: "noPath", path: [] } as never);
  };
  pathfinder.getPathFromTo = () =>
    (function* slices(): Generator<{ result: unknown }> {
      yield { result: { status: "noPath", path: [] } };
    })();
  return h;
}

/** Starts move.to toward `position`, settles the promise machinery, and returns the rejection message. */
async function failure(position: Parameters<typeof move.to>[1]["position"]) {
  const h = noPathHarness();
  let outcome: unknown = "pending";
  void h.run(move.to, { position, range: 1 }).then(
    (value) => (outcome = { ok: value }),
    (err: unknown) => (outcome = err),
  );
  await settle();
  await settle();
  await settle();
  return message(outcome);
}

describe("move.to height diagnosis (mb-znn.26)", () => {
  it("names the ground y and 11 blocks above it for a goal in the air", async () => {
    const text = await failure([10, 75, 0]);
    assert.match(text, /^could not reach \(10, 75, 0\): stopped at \(0, 64, 0\), 14\.9 blocks away; the pathfinder found no way there from here; the ground at that column is y 64, so the goal is 11 blocks above the ground there - pass \{ x, z \} to walk to the surface$/);
  });

  it("says below when the goal is under the ground", async () => {
    const text = await failure([10, 50, 0]);
    assert.match(text, /the ground at that column is y 64, so the goal is 14 blocks below the ground there/);
  });

  it("keeps the ordinary text when the goal is within range + 1 of the ground", async () => {
    const text = await failure([10, 66, 0]);
    assert.equal(text, "could not reach (10, 66, 0): stopped at (0, 64, 0), 10.2 blocks away; the pathfinder found no way there from here");
  });

  it("says the column is not loaded when its chunk is missing", async () => {
    const h = noPathHarness();
    const blockAt = h.bot.blockAt.bind(h.bot);
    // The loaded-chunk probe reads the column at y 0; null there is mineflayer's signal for an unloaded chunk.
    h.bot.blockAt = (at: Parameters<typeof blockAt>[0]) => (Math.floor(at.x) === 10 && Math.floor(at.z) === 0 && Math.floor(at.y) === 0 ? null : blockAt(at));
    let outcome: unknown = "pending";
    void h.run(move.to, { position: [10, 75, 0], range: 1 }).then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    await settle();
    await settle();
    await settle();
    assert.match(message(outcome), /the goal's column is not loaded, so its ground height is unknown - walk closer to load it, or pass \{ x, z \} to walk to its surface$/);
  });
});
