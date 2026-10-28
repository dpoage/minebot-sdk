// move.to own-build explanation and allowDigOwnBuilds (mb-b6z): a missing path that appears
// without the own-build exclusions names a block the bot actually placed (one the relaxed path
// breaks or would scaffold under), and never a natural block; when the relaxed path meets none of
// the record, the ordinary could-not-reach error stands. allowDigOwnBuilds walks on movements
// without the exclusions; the no-diagonal fallback keeps them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import { Movements, Vec3 } from "minebot-sdk/routine";
import { installBodyPolicies } from "../src/host/pathfinding.ts";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Point {
  x: number;
  y: number;
  z: number;
}

interface Scaffold extends Point {
  dx: number;
  dy: number;
  dz: number;
}

interface StubNode extends Point {
  toBreak?: Point[];
  toPlace?: Scaffold[];
}

interface Answer {
  status: string;
  path: StubNode[];
}

interface StubMovements {
  maxDropDown: number;
  exclusionAreasBreak: unknown[];
  exclusionAreasPlace: unknown[];
}

interface SearchOptions {
  timeout: number;
  tickTimeout: number;
}

interface SearchUse {
  exclusions: number;
  maxDropDown: number;
}

interface StubPathfinder {
  goto: (goal: unknown) => Promise<void>;
  setMovements: (movements: InstanceType<typeof Movements>) => void;
  getPathFromTo: (movements: StubMovements, start: unknown, goal: unknown, options: SearchOptions) => IterableIterator<{ result: unknown }>;
}

/**
 * A harness with the own-build policies installed, one oak_planks block placed through the bot,
 * and a pathfinder that reports no path and answers every re-search `answer` describes (noPath
 * when it says nothing).
 */
async function ownBuildScene(
  answer: (movements: StubMovements) => Answer | undefined,
  options: { position?: [number, number, number]; at?: [number, number, number] } = {},
) {
  const h = createHarness({
    position: options.position ?? [0.5, 64, 0.5],
    blocks: [{ name: "stone", at: [2, 64, 0] }],
    inventory: { oak_planks: 4 },
  });
  installBodyPolicies(h.bot);
  const planks = h.bot.inventory.items().find((item) => item.name === "oak_planks")!;
  await h.bot.equip(planks, "hand");
  const at = options.at ?? [0, 64, 2];
  await h.bot.placeBlock(h.blockAt([at[0], at[1] - 1, at[2]]), new Vec3(0, 1, 0));

  const pathfinder = h.bot.pathfinder as unknown as StubPathfinder;
  const searches: SearchUse[] = [];
  pathfinder.goto = async () => {
    h.bot.emit("path_update", { status: "noPath", path: [] } as never);
  };
  pathfinder.getPathFromTo = (movements) => {
    searches.push({ exclusions: movements.exclusionAreasBreak.length, maxDropDown: movements.maxDropDown });
    const result = answer(movements) ?? { status: "noPath", path: [] };
    function* slices(): Generator<{ result: unknown }> {
      yield { result };
    }
    return slices();
  };
  return { h, pathfinder, searches, movements: h.bot.pathfinder.movements };
}

/** Every re-search answer that only relaxes one rule: a path is found only when the exclusions are gone. */
const freeOnly = (path: StubNode[]) => (movements: StubMovements) => (movements.exclusionAreasBreak.length === 0 ? { status: "success", path } : undefined);

describe("move.to own-build explanation (mb-b6z)", () => {
  it("names the placed block on the relaxed path, not the natural block it breaks first", async () => {
    const { h } = await ownBuildScene(freeOnly([{ x: 4, y: 64, z: 0, toBreak: [{ x: 2, y: 64, z: 0 }, { x: 4, y: 64, z: 0 }] }]), {
      position: [1.5, 64, 0.5],
      at: [4, 64, 0],
    });
    assert.equal(h.blockAt([4, 64, 0]).name, "oak_planks", "the bot placed it through placeBlock");
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), {
      message:
        "could not reach (10, 64, 0): every way goes through blocks you placed (e.g. oak_planks at (4, 64, 0)); open a door, break one yourself, or call move.to again with allowDigOwnBuilds: true",
    });
  });

  it("names a recorded block the relaxed path would scaffold under", async () => {
    const { h } = await ownBuildScene(freeOnly([{ x: 1, y: 63, z: 2, toPlace: [{ x: 1, y: 63, z: 2, dx: 0, dy: 0, dz: 0 }] }]), {
      at: [1, 64, 2],
    });
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), /e\.g\. oak_planks at \(1, 64, 2\)/);
  });

  it("falls back to the ordinary could-not-reach error when the relaxed path breaks only natural blocks", async () => {
    const { h, searches } = await ownBuildScene(freeOnly([{ x: 2, y: 64, z: 0, toBreak: [{ x: 2, y: 64, z: 0 }] }]));
    assert.equal(h.blockAt([0, 64, 2]).name, "oak_planks", "a placed block exists, just not on the relaxed path");
    await assert.rejects(h.run(move.to, { position: [10, 64, 0], range: 1 }), {
      message: "could not reach (10, 64, 0): stopped at (0, 64, 0), 10.0 blocks away; the pathfinder found no way there from here",
    });
    assert.equal(searches.length, 2, "the free search, then the unlimited fall");
  });

  it("walks on movements without the exclusions when allowDigOwnBuilds is true", async () => {
    const { h, pathfinder, movements } = await ownBuildScene(() => undefined);
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
