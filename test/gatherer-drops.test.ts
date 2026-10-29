// gatherer.collectDrops tries each drop once and reports { reached, unreachable } (mb-jfa.6), walking only to drops
// that lie on something. A drop tucked under a block has no room to stand in, so the harness pathfinder fails the walk to it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import { Vec3 } from "minebot-sdk/routine";
import * as gatherer from "../src/routines/gatherer.ts";
import * as items from "../src/routines/items.ts";

const TUCKED = { name: "item", item: "oak_log", at: [5.5, 64.25, 4.5] } as const;
const ROOF = { name: "stone", from: [5, 65, 4], to: [5, 65, 4] } as const;

/** The `move.to` calls the harness saw toward the cell of the tucked drop, whose entry also names its stack. */
function walksToTucked(h: Harness) {
  return h.calls.filter((c) => {
    if (c.kit !== "move" || c.action !== "to") return false;
    const args: unknown = c.args;
    if (typeof args !== "object" || args === null || !("position" in args)) return false;
    const { position } = args;
    if (typeof position !== "object" || position === null) return false;
    return "x" in position && "y" in position && "z" in position && position.x === 5 && position.y === 64 && position.z === 4;
  });
}

describe("gatherer drops", () => {
  it("does not walk toward a drop that failed again within one gather", async () => {
    const h = createHarness({ blocks: [{ name: "oak_log", from: [8, 64, 0], to: [8, 66, 0] }, ROOF], entities: [TUCKED] });
    assert.deepEqual(await h.run(gatherer.gather, { blocks: "oak_log", count: 3 }), { dug: 3, gained: { oak_log: 3 }, skipped: 0 });
    assert.equal(walksToTucked(h).length, 1, "one walk, though three blocks were dug and three pickups ran");
  });

  it("forgets failed drops between gathers", async () => {
    const h = createHarness({ blocks: [{ name: "oak_log", from: [8, 64, 0], to: [8, 65, 0] }, ROOF], entities: [TUCKED] });
    await h.run(gatherer.gather, { blocks: "oak_log", count: 1 });
    await h.run(gatherer.gather, { blocks: "oak_log", count: 1 });
    assert.equal(walksToTucked(h).length, 2, "each gather tries the drop once");
  });

  it("collectDrops returns how many drops it reached and which it could not, one entry per cell", async () => {
    const h = createHarness({
      blocks: [ROOF],
      entities: [
        { name: "item", item: "oak_log", at: [3.5, 64.25, 0.5] },
        { name: "item", item: "oak_log", at: [3.5, 64.25, 0.5] },
        { name: "item", item: "oak_log", at: [-4.5, 64.25, 3.5] },
        TUCKED,
        { ...TUCKED, at: [5.2, 64.4, 4.9] },
      ],
    });
    const result = await h.run(gatherer.collectDrops, { radius: 12 });
    assert.deepEqual(result, { reached: 2, unreachable: [{ x: 5, y: 64, z: 4 }] }, "five entities in three cells: 2 reached + 1 unreachable, a shared cell counted once");
    assert.equal(h.count("oak_log"), 3, "the reachable stacks were picked up");
    assert.equal(walksToTucked(h).length, 1);
  });

  it("collectDrops with nothing to pick up returns zero and an empty list", async () => {
    const h = createHarness();
    assert.deepEqual(await h.run(gatherer.collectDrops, {}), { reached: 0, unreachable: [] });
  });

  it("collectDrops waits for a falling drop to land and walks to where it lies", async () => {
    const h = createHarness({ position: [0.5, 64, 0.5] });
    const drop = h.spawn({ name: "item", item: "oak_log", at: [3.5, 72, 0.5] });
    // The drop falls from y 72 to the ground (64.25) over 30 ticks (1.5 s of game time), as a dug log's drop does.
    const start = h.bot.time.age;
    Object.defineProperty(drop, "position", { get: () => new Vec3(3.5, Math.max(64.25, 72 - (h.bot.time.age - start) * 0.26), 0.5) });
    assert.deepEqual(await h.run(gatherer.collectDrops, {}), { reached: 1, unreachable: [] });
    assert.equal(h.count("oak_log"), 1, "picked up where it landed");
  });

  it("collectDrops leaves out a drop that still hangs in mid-air after 2 s: no walk, neither reached nor unreachable", async () => {
    const h = createHarness({ position: [0.5, 64, 0.5], entities: [{ name: "item", item: "oak_log", at: [3.5, 68, 0.5] }] });
    assert.deepEqual(await h.run(items.drops, {}), [{ x: 3, y: 68, z: 0, name: "oak_log", count: 1 }], "the drop is within the default radius, named and counted (P2.1)");
    assert.deepEqual(await h.run(gatherer.collectDrops, {}), { reached: 0, unreachable: [] });
    assert.equal(h.calls.filter((c) => c.kit === "move" && c.action === "to").length, 0);
  });
});
