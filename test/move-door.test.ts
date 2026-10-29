// move.to through a closed wooden door (mb-q8g): a plain no-way walk with a closed wooden door
// near its goal walks to the door, opens it, and tries the goal once more within the caller's
// time; an iron door is never opened, and drop/own-build/height explanations are not retried. The
// plugin's own canOpenDoors path is not used: it crashes its executor on the single useOne move a
// door plans (verified live on the dev server). A stop or a replaced goal ends the walk with its
// own error before any door is opened or another walk started; overlapping retries share one
// blockAt wrapper that restores the original identity with its last walk.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import { Vec3 } from "minebot-sdk/routine";
import { installBodyPolicies } from "../src/host/pathfinding.ts";
import * as move from "../src/routines/move.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Runs the pending microtasks and immediates, so a step that chains awaits has fully started. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await settle();
};
const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : `not an error: ${JSON.stringify(outcome)}`);
const at = (x: number, y: number, z: number) => new Vec3(x, y, z);

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

const noPathSearch = () =>
  (function* slices(): Generator<{ result: unknown }> {
    yield { result: { status: "noPath", path: [] } };
  })();

/** A harness with a closed door at (4, 64, 0), a counting activateBlock that opens it, and a no-way search. */
function scene(options: { position?: [number, number, number]; door?: "spruce_door" | "iron_door"; inventory?: Record<string, number> } = {}) {
  const h = createHarness({ position: options.position ?? [0.5, 64, 0.5], inventory: options.inventory ?? {} });
  const name = options.door ?? "spruce_door";
  const hang = (half: string, open: boolean) => h.setBlock([4, half === "lower" ? 64 : 65, 0], name, { half, open, facing: "east", hinge: "left" });
  hang("lower", false);
  hang("upper", false);
  const pathfinder = h.bot.pathfinder as unknown as StubPathfinder;
  pathfinder.getPathFromTo = noPathSearch;
  let activations = 0;
  const openDoor = () => {
    hang("lower", true);
    hang("upper", true);
  };
  h.bot.activateBlock = async () => {
    activations++;
    openDoor();
  };
  return { h, pathfinder, activations: () => activations, openDoor };
}

describe("move.to through a closed wooden door (mb-q8g)", () => {
  it("opens the door and walks through without breaking a block", async () => {
    const { h, pathfinder, activations } = scene();
    pathfinder.goto = async (goal) => {
      if (goal.x === 4) {
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
    const before = h.blockAt([4, 64, 0]).name;
    assert.deepEqual(await h.run(move.to, { position: [5, 64, 0], range: 0 }), { x: 5, y: 64, z: 0 });
    assert.equal(activations(), 1, "the door is activated once");
    assert.equal(h.blockAt([4, 64, 0]).getProperties().open, true, "the door stayed open");
    assert.equal(h.blockAt([4, 64, 0]).name, before, "the door is not broken");
    assert.equal(h.blockAt([4, 65, 0]).name, before, "neither half is broken");
  });

  it("leaves an iron door closed and keeps the could-not-reach error", async () => {
    const { h, pathfinder, activations } = scene({ door: "iron_door" });
    pathfinder.goto = async () => {
      h.bot.emit("path_update", { status: "noPath", path: [] } as never);
    };
    await assert.rejects(h.run(move.to, { position: [5, 64, 0], range: 0 }), /could not reach \(5, 64, 0\)/);
    assert.equal(activations(), 0, "no hand opens an iron door");
    assert.equal(h.blockAt([4, 64, 0]).getProperties().open, false);
  });
});

describe("door retry stops with the run (B1)", () => {
  it("opens no door and starts no further walk after the goal is replaced during the door walk", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    let interiorGotos = 0;
    pathfinder.goto = async (goal) => {
      if (goal.x === 5) {
        interiorGotos++;
        h.bot.emit("path_update", { status: "noPath", path: [] } as never);
        return;
      }
      h.bot.emit("goal_updated", null as never, false);
      throw new Error("The goal was changed before it could be completed!");
    };
    await assert.rejects(h.run(move.to, { position: [5, 64, 0], range: 0 }), /goal was changed/);
    assert.equal(activations(), 0, "the stopped walk opens nothing");
    assert.equal(interiorGotos, 1, "no retry walk starts");
  });

  it("opens no door and starts no further walk once the run's signal aborts", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    let interiorGotos = 0;
    pathfinder.goto = async (goal) => {
      if (goal.x === 5) {
        interiorGotos++;
        h.bot.emit("path_update", { status: "noPath", path: [] } as never);
        return;
      }
      h.teleport([3.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
    };
    h.bot.activateBlock = async () => {
      activations();
      h.abort(new Error("stop requested"));
    };
    await assert.rejects(h.run(move.to, { position: [5, 64, 0], range: 0 }), /stop requested/);
    assert.equal(interiorGotos, 1, "no retry walk starts after the abort");
  });
});

describe("overlapping door retries share one blockAt view (B2)", () => {
  it("restores the original blockAt identity and never mutates a held block", async () => {
    const { h, pathfinder } = scene({ position: [3.5, 64, 0.5] });
    const gates: PromiseWithResolvers<void>[] = [];
    let opened = false;
    let nextInteriorNoPath = false;
    let done = false;
    // No-way ends arrive as this run's own goto rejection, not a shared path_update event: two walks
    // share the bot's event bus, and only the goal identity separates their goal_reached events.
    const noWay = () => Object.assign(new Error("No path to the goal!"), { name: "NoPath" });
    pathfinder.goto = async (goal) => {
      if (done) throw new Error("test over");
      if (goal.x === 5) {
        if (nextInteriorNoPath) {
          nextInteriorNoPath = false;
          throw noWay();
        }
        if (!opened) throw noWay();
        const gate = Promise.withResolvers<void>();
        gates.push(gate);
        await gate.promise;
        h.teleport([5.5, 64, 0.5]);
        h.bot.emit("goal_reached", goal);
        return;
      }
      h.teleport([3.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
    };
    const activate = h.bot.activateBlock;
    h.bot.activateBlock = async (block) => {
      await activate.call(h.bot, block);
      opened = true;
    };

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      // The first walk opens the door and parks in its retry; the second starts while that retry is in progress.
      first = h.run(move.to, { position: [5, 64, 0], range: 0 });
      for (let i = 0; i < 100 && gates.length < 1; i++) await flush();
      assert.equal(gates.length, 1, "the first retry walk is in progress");
      nextInteriorNoPath = true;
      second = h.run(move.to, { position: [5, 64, 0], range: 0 });
      for (let i = 0; i < 100 && gates.length < 2; i++) await flush();
      assert.equal(gates.length, 2, "both retry walks are in progress");
      assert.equal(h.bot.blockAt(at(4, 64, 0))?.boundingBox, "empty", "one wrapper serves both walks");
      // The world's block is not mutated: it keeps the swung panel's shape while the wrapper reports a copy.
      const heldDuring = h.blockAt([4, 64, 0]);
      assert.equal(heldDuring.boundingBox, "block", "the cached door block was not mutated");
      assert.equal(heldDuring.shapes.length, 1, "the cached door block's shapes were not mutated");

      gates[0]?.resolve();
      await Promise.race([first, second]);
      assert.equal(h.bot.blockAt(at(4, 64, 0))?.boundingBox, "empty", "the other walk still holds the wrapper");

      gates[1]?.resolve();
      await Promise.allSettled([first, second]);
      // A wrapper left installed would still report this fresh closed door as empty.
      h.setBlock([4, 64, 0], "spruce_door", { half: "lower", open: false, facing: "east", hinge: "left" });
      h.setBlock([4, 65, 0], "spruce_door", { half: "upper", open: false, facing: "east", hinge: "left" });
      assert.equal(h.bot.blockAt(at(4, 64, 0))?.boundingBox, "block", "the last release restores the real view");
      assert.equal(h.bot.blockAt(at(4, 64, 0))?.shapes.length, 1);
    } finally {
      // A failed assertion must not leave a walk blocked on a gate with its pathfinding timers alive.
      done = true;
      for (const gate of gates) gate.resolve();
      h.abort(new Error("test over"));
      await Promise.allSettled([first, second].filter((run): run is Promise<unknown> => run !== undefined));
    }
  });
});

describe("door retry respects timeoutMs (B3)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  /** A scene whose walks answer on the mock clock; the door walk hangs unless `door` is "reach", and the retry hangs unless it says otherwise. */
  function slowScene(options: { firstNoPathMs: number; door: "hang" | "reach"; retry: "hang" | "nopath" }) {
    const { h, pathfinder } = scene({ position: [3.5, 64, 0.5] });
    let interior = 0;
    pathfinder.goto = async (goal) => {
      if (goal.x === 5) {
        interior++;
        const retryWalk = interior > 1;
        const delay = retryWalk ? 1200 : options.firstNoPathMs;
        if (!(retryWalk && options.retry === "hang")) {
          setTimeout(() => h.bot.emit("path_update", { status: "noPath", path: [] } as never), delay);
        }
        return new Promise<void>(() => {});
      }
      if (options.door === "hang") return new Promise<void>(() => {});
      h.teleport([3.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
    };
    return { h, interior: () => interior };
  }

  /** Starts move.to and reports how it settles plus the mock start time. */
  function start(h: Harness, timeoutMs: number) {
    let outcome: unknown = "pending";
    const started = Date.now();
    void h.run(move.to, { position: [5, 64, 0], range: 0, timeoutMs }).then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    return { outcome: () => outcome, started };
  }

  it("throws the caller's timeout, not could-not-reach, when the door walk uses up the budget", async () => {
    const { h, interior } = slowScene({ firstNoPathMs: 1200, door: "hang", retry: "hang" });
    const walk = start(h, 1500);
    mock.timers.tick(1200);
    await flush();
    assert.equal(walk.outcome(), "pending", "the retry is still inside the caller's time");
    mock.timers.tick(300);
    await flush();
    assert.equal(message(walk.outcome()), "pathfinding took longer than 1500 ms");
    assert.equal(interior(), 1, "the retry walk never starts");
    assert.ok(Date.now() - walk.started <= 2500, `settled by the deadline plus 1 s (was ${Date.now() - walk.started} ms)`);
  });

  it("gives the retry walk only the time the first walk left", async () => {
    const { h, interior } = slowScene({ firstNoPathMs: 1000, door: "reach", retry: "hang" });
    const walk = start(h, 1500);
    mock.timers.tick(1000);
    await flush();
    assert.equal(walk.outcome(), "pending", "the retry is still walking");
    mock.timers.tick(500);
    await flush();
    assert.equal(message(walk.outcome()), "pathfinding took longer than 1500 ms");
    assert.equal(interior(), 2, "the retry walk started and was cut by the caller's deadline");
  });
});

describe("own-build and stuck ends retry through the door (r2)", () => {
  it("opens the door when the first walk is explained by the bot's own build", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5], inventory: { oak_planks: 4 } });
    installBodyPolicies(h.bot);
    const planks = h.bot.inventory.items().find((item) => item.name === "oak_planks");
    assert.ok(planks);
    await h.bot.equip(planks, "hand");
    await h.bot.placeBlock(h.blockAt([2, 63, 0]), new Vec3(0, 1, 0));
    pathfinder.goto = async (goal) => {
      if (goal.x === 4) {
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
    pathfinder.getPathFromTo = ((movements: { exclusionAreasBreak: unknown[] }) =>
      (function* slices(): Generator<{ result: unknown }> {
        if (movements.exclusionAreasBreak.length === 0) yield { result: { status: "success", path: [{ x: 0, y: 64, z: 0, toBreak: [{ x: 2, y: 64, z: 0 }], toPlace: [] }] } };
        else yield { result: { status: "noPath", path: [] } };
      })()) as never;
    assert.deepEqual(await h.run(move.to, { position: [5, 64, 0], range: 0 }), { x: 5, y: 64, z: 0 });
    assert.equal(activations(), 1, "the own-build explanation opened the door and the walk was retried");
  });

  it("finds the door near the player when the goal is beyond the door search range", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    pathfinder.goto = async (goal) => {
      if (goal.x === 4) {
        h.teleport([3.5, 64, 0.5]);
        h.bot.emit("goal_reached", goal);
        return;
      }
      if (h.blockAt([4, 64, 0]).getProperties().open !== true) {
        h.bot.emit("path_update", { status: "noPath", path: [] } as never);
        return;
      }
      h.teleport([20.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
    };
    assert.deepEqual(await h.run(move.to, { position: [20, 64, 0], range: 0 }), { x: 20, y: 64, z: 0 });
    assert.equal(activations(), 1, "the door beside the player was found and opened");
  });
});

describe("stuck ends retry through the door (r2)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] }));
  afterEach(() => mock.timers.reset());

  it("opens the door when the walk gets stuck at the doorway", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    let interior = 0;
    pathfinder.goto = async (goal) => {
      if (goal.x === 4) {
        h.teleport([3.5, 64, 0.5]);
        h.bot.emit("goal_reached", goal);
        return;
      }
      interior++;
      if (interior === 1) return new Promise<void>(() => {});
      h.teleport([5.5, 64, 0.5]);
      h.bot.emit("goal_reached", goal);
    };
    let outcome: unknown = "pending";
    void h.run(move.to, { position: [5, 64, 0], range: 0, timeoutMs: 60_000 }).then(
      (value) => (outcome = { ok: value }),
      (err: unknown) => (outcome = err),
    );
    for (let i = 0; i < 24; i++) {
      mock.timers.tick(500);
      await flush();
    }
    await flush();
    assert.deepEqual(outcome, { ok: { x: 5, y: 64, z: 0 } });
    assert.equal(activations(), 1, "the stuck end opened the door");
    assert.equal(interior, 2, "the walk was retried once");
  });
});

describe("explanations are not door problems (N3)", () => {
  it("keeps a drop explanation and opens no door", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    pathfinder.goto = async () => {
      h.bot.emit("path_update", { status: "noPath", path: [] } as never);
    };
    pathfinder.getPathFromTo = ((movements: { maxDropDown: number }) =>
      (function* slices(): Generator<{ result: unknown }> {
        if (movements.maxDropDown > 4) yield { result: { status: "success", path: [{ x: 0, y: 64, z: 0 }, { x: 5, y: 40, z: 0 }] } };
        else yield { result: { status: "noPath", path: [] } };
      })()) as never;
    await assert.rejects(h.run(move.to, { position: [5, 64, 0], range: 0 }), /every way down is a drop of 24 blocks/);
    assert.equal(activations(), 0, "a drop explanation is not a door problem");
  });

  it("keeps a height diagnosis and opens no door", async () => {
    const { h, pathfinder, activations } = scene({ position: [3.5, 64, 0.5] });
    pathfinder.goto = async () => {
      h.bot.emit("path_update", { status: "noPath", path: [] } as never);
    };
    await assert.rejects(h.run(move.to, { position: [6, 67, 0], range: 0 }), /the ground at that column is y 64, so the goal is 3 blocks above the ground there/);
    assert.equal(activations(), 0, "a height diagnosis is not a door problem");
  });
});
