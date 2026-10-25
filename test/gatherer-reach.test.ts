// gatherer.gather digs a block whose walk ended short when the block is in dig reach anyway (mb-jfa.5 fix round):
// the top logs of a tall trunk, with no blocks to pillar up on, are dug from below.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import * as gatherer from "../src/routines/gatherer.ts";

describe("gatherer.gather with walks that end short", () => {
  it("digs the logs within reach from where the walk ended and skips the one beyond", async () => {
    const h = createHarness({ position: [0.5, 64, 0.5], blocks: [{ name: "oak_log", from: [1, 64, 0], to: [1, 70, 0] }] });
    // A pathfinder that finds no way anywhere: each walk ends where the player stands ('could not reach').
    // The harness types `bot.pathfinder` as the plugin's API, whose members a test may not reassign.
    const pathfinder = h.bot.pathfinder as unknown as { goto: () => Promise<void> };
    pathfinder.goto = async () => {};
    // From the eyes at y 65.62, logs up to y 69 are within 4.5 blocks; the log at y 70 is 5.0 away.
    assert.deepEqual(await h.run(gatherer.gather, { blocks: "oak_log", count: 7 }), { dug: 6, gained: { oak_log: 6 }, skipped: 1 });
    assert.equal(h.blockAt([1, 70, 0]).name, "oak_log");
  });
});
