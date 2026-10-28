// move.to cliff explanation (mb-znn.5): when the pathfinder finds no path, the walk searches once
// more with every fall allowed, a search tick at a time. If that way exists, the error says how tall
// the drop is and that the pathfinder's own limit is the reason.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import { Movements } from "minebot-sdk/routine";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);

interface SearchUse {
  maxDropDown: number;
  exclusions: number;
  timeout: number;
  tickTimeout: number;
}

interface StubMovements {
  maxDropDown: number;
  exclusionAreasBreak: unknown[];
}

/**
 * A harness standing on a 20-block pillar whose pathfinder reports no path, and a `getPathFromTo`
 * that answers the re-search `pathFor` describes, one search tick (a 'partial') before the answer.
 */
function pillarHarness(pathFor: (movements: StubMovements) => { status: string; path: { x: number; y: number; z: number }[] } | undefined, onSecondSlice?: () => void) {
  const h = createHarness({ position: [0.5, 84, 0.5] });
  const searches: SearchUse[] = [];
  const pathfinder = h.bot.pathfinder as unknown as {
    goto: () => Promise<void>;
    setMovements: (movements: unknown) => void;
    getPathFromTo: (movements: StubMovements, start: unknown, goal: unknown, options: { timeout: number; tickTimeout: number }) => IterableIterator<{ result: unknown }>;
  };
  pathfinder.setMovements(new Movements(h.bot));
  pathfinder.goto = async () => {
    h.bot.emit("path_update", { status: "noPath", path: [] } as never);
  };
  pathfinder.getPathFromTo = (movements, _start, _goal, options) => {
    searches.push({ maxDropDown: movements.maxDropDown, exclusions: movements.exclusionAreasBreak.length, timeout: options.timeout, tickTimeout: options.tickTimeout });
    const answer = pathFor(movements);
    function* slices(): Generator<{ result: unknown }> {
      yield { result: { status: "partial", path: [] } };
      onSecondSlice?.();
      yield { result: answer ?? { status: "noPath", path: [] } };
    }
    return slices();
  };
  return { h, searches };
}

describe("move.to cliff explanation (mb-znn.5)", () => {
  it("names the drop when only an unlimited fall finds the way, searching off the tick", async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    let sawTick = false;
    const { h, searches } = pillarHarness(
      (movements) => (movements.maxDropDown > 4 ? { status: "success", path: [{ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }] } : undefined),
      () => {
        sawTick = ticked;
      },
    );
    let outcome: unknown = "pending";
    void h.run(move.to, { position: [10, 64, 0], range: 1 }).then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    await settle();
    await settle();
    await settle();
    assert.equal(
      message(outcome),
      "could not reach (10, 64, 0): every way down is a drop of 20 blocks (the pathfinder drops at most 4) - dig or build stairs down, or pick a target on this level",
    );
    assert.equal(searches.length, 1, "one re-search");
    assert.equal(searches[0]!.maxDropDown, 512, "the re-search allows every fall");
    assert.equal(searches[0]!.tickTimeout, 40, "one search tick at a time");
    assert.ok(searches[0]!.timeout > 4_000 && searches[0]!.timeout <= 5_000, `bounded to 5 s, got ${searches[0]!.timeout}`);
    assert.equal(sawTick, true, "the search yielded to the event loop between slices");
  });

  it("keeps the generic error when the unlimited fall also finds no way", async () => {
    const { h, searches } = pillarHarness(() => undefined);
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), {
      message: "could not reach (10, 64, 0): stopped at (0, 84, 0), 22.4 blocks away; the pathfinder found no way there from here",
    });
    assert.equal(searches.length, 1);
  });
});
