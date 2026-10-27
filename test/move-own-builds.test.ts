// move.to own-build explanation and allowDigOwnBuilds (mb-b6z): a missing path that appears
// without the own-build exclusions names a block the bot placed; allowDigOwnBuilds walks on
// movements without those exclusions; the no-diagonal fallback keeps them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import { Movements } from "minebot-sdk/routine";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface SearchUse {
  exclusions: number;
  maxDropDown: number;
}

interface PathStubMovements {
  maxDropDown: number;
  exclusionAreasBreak: unknown[];
  exclusionAreasPlace: unknown[];
}

interface SearchOptions {
  timeout: number;
  tickTimeout: number;
}

/** A harness with a placed stone wall at (2, 64, 0), the own-build exclusions on its movements, and a stub pathfinder. */
function wallHarness() {
  const h = createHarness({ blocks: [{ name: "stone", at: [2, 64, 0] }] });
  const movements = new Movements(h.bot);
  movements.exclusionAreasBreak.push(() => Infinity);
  const pathfinder = h.bot.pathfinder as unknown as {
    goto: (goal: unknown) => Promise<void>;
    setMovements: (movements: unknown) => void;
    getPathFromTo: (movements: PathStubMovements, start: unknown, goal: unknown, options: SearchOptions) => IterableIterator<{ result: unknown }>;
  };
  const searches: SearchUse[] = [];
  pathfinder.setMovements(movements);
  pathfinder.goto = async () => {
    h.bot.emit("path_update", { status: "noPath", path: [] } as never);
  };
  pathfinder.getPathFromTo = (used) => {
    searches.push({ exclusions: used.exclusionAreasBreak.length, maxDropDown: used.maxDropDown });
    const result =
      used.exclusionAreasBreak.length === 0
        ? { status: "success", path: [{ x: 2, y: 64, z: 0, toBreak: [{ x: 2, y: 64, z: 0 }] }] }
        : { status: "noPath", path: [] };
    function* slices(): Generator<{ result: unknown }> {
      yield { result };
    }
    return slices();
  };
  return { h, movements, pathfinder, searches };
}

describe("move.to own-build explanation (mb-b6z)", () => {
  it("names the block the bot placed when the way opens without the own-build exclusions", async () => {
    const { h, movements, searches } = wallHarness();
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), {
      message:
        "could not reach (10, 64, 0): every way goes through blocks you placed (e.g. stone at (2, 64, 0)); open a door, break one yourself, or call move.to again with allowDigOwnBuilds: true",
    });
    assert.deepEqual(searches, [{ exclusions: 0, maxDropDown: 4 }], "one re-search, without the exclusions");
    assert.equal(h.bot.pathfinder.movements, movements, "the walk's movements were restored");
  });

  it("walks on movements without the exclusions when allowDigOwnBuilds is true", async () => {
    const { h, movements, pathfinder } = wallHarness();
    let seenExclusions: number | undefined;
    pathfinder.goto = (goal) => {
      seenExclusions = h.bot.pathfinder.movements.exclusionAreasBreak.length;
      h.teleport([10.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
      return Promise.resolve();
    };
    assert.deepEqual(await h.run(move.to, { position: [10, 64, 0], range: 1, allowDigOwnBuilds: true }), { x: 10, y: 64, z: 0 });
    assert.equal(seenExclusions, 0, "the walk ran without the own-build exclusions");
    assert.equal(h.bot.pathfinder.movements, movements, "the default movements came back");
  });

  it("keeps the own-build exclusions on the no-diagonal fallback movements", async () => {
    const h = createHarness();
    const movements = new Movements(h.bot);
    movements.exclusionAreasBreak.push(() => Infinity);
    const pathfinder = h.bot.pathfinder as unknown as {
      goto: () => Promise<void>;
      setMovements: (movements: InstanceType<typeof Movements>) => void;
      getPathFromTo: () => IterableIterator<{ result: unknown }>;
    };
    const installed: InstanceType<typeof Movements>[] = [];
    const setMovements = pathfinder.setMovements.bind(h.bot);
    pathfinder.setMovements = (next) => {
      installed.push(next);
      setMovements(next);
    };
    pathfinder.setMovements(movements);
    pathfinder.goto = () => Promise.withResolvers<void>().promise;
    pathfinder.getPathFromTo = () =>
      (function* slices(): Generator<{ result: unknown }> {
        yield { result: { status: "noPath", path: [] } };
      })();

    const done = h.run(move.to, { position: [10, 64, 0], range: 1 });
    await settle();
    h.bot.emit("path_reset", "stuck");
    h.bot.emit("path_reset", "stuck");
    await settle();
    const straight = installed.at(-1)!;
    assert.notEqual(straight, movements, "a fresh Movements for the straight walk");
    assert.equal(straight.exclusionAreasBreak, movements.exclusionAreasBreak, "the same break exclusions");
    assert.equal(straight.exclusionAreasPlace, movements.exclusionAreasPlace, "the same place exclusions");
    assert.equal(straight.maxDropDown, movements.maxDropDown);

    h.bot.emit("path_update", { status: "noPath", path: [] } as never);
    await assert.rejects(done, /the pathfinder found no way there from here/);
  });
});
