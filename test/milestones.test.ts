import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { offlineUuid } from "../bench/verify/milestones.ts";
import { MilestoneSet, grade } from "../src/milestones/milestones.ts";

const spec = MilestoneSet.parse({
  milestones: [
    { id: "logs", description: "Get 3 logs", obtained: ["*_log"], count: 3 },
    { id: "table", description: "Craft a crafting table", obtained: ["crafting_table"], via: "crafted" },
  ],
});

/** Statistics for logs: dug, picked up, thrown, and placed. */
const logStats = (n: { mined?: number; picked_up?: number; dropped?: number; used?: number }) => ({
  stats: {
    "minecraft:mined": { "minecraft:oak_log": n.mined ?? 0 },
    "minecraft:picked_up": { "minecraft:oak_log": n.picked_up ?? 0 },
    "minecraft:dropped": { "minecraft:oak_log": n.dropped ?? 0 },
    "minecraft:used": { "minecraft:oak_log": n.used ?? 0 },
  },
});

describe("grade", () => {
  it("counts items that were dug and picked up, across wildcard matches", () => {
    const result = grade(spec, {
      stats: {
        "minecraft:mined": { "minecraft:oak_log": 1, "minecraft:birch_log": 2, "minecraft:dirt": 9 },
        "minecraft:picked_up": { "minecraft:oak_log": 1, "minecraft:birch_log": 2, "minecraft:dirt": 9 },
      },
    });
    assert.deepEqual(result.milestones[0], {
      id: "logs",
      description: "Get 3 logs",
      met: true,
      needed: 3,
      obtained: 3,
      detail: { mined: 3, placed: 0, picked_up: 3, thrown: 0 },
    });
    assert.equal(result.reward, 0);
    assert.equal(result.progress, 0.5);
  });

  it("does not count an item picked up again after it was thrown", () => {
    // Three logs dug, then one tossed and collected five times: 8 pickups, 5 throws.
    const result = grade(spec, logStats({ mined: 3, picked_up: 8, dropped: 5 }));
    assert.equal(result.milestones[0]!.obtained, 3);
    const tossed = grade(spec, logStats({ mined: 1, picked_up: 8, dropped: 7 }));
    assert.equal(tossed.milestones[0]!.obtained, 1);
    assert.equal(tossed.milestones[0]!.met, false);
  });

  it("does not count drops that the player collected again after dying", () => {
    // Death drops are not counted as thrown, so only the dug count can cap the total.
    const result = grade(spec, logStats({ mined: 2, picked_up: 4 }));
    assert.equal(result.milestones[0]!.obtained, 2);
    assert.equal(result.milestones[0]!.met, false);
  });

  it("does not count a block that was placed and dug again", () => {
    const result = grade(spec, logStats({ mined: 8, picked_up: 8, used: 7 }));
    assert.equal(result.milestones[0]!.obtained, 1);
  });

  it("does not count a block that was dug but never picked up", () => {
    const result = grade(spec, logStats({ mined: 8, picked_up: 1 }));
    assert.equal(result.milestones[0]!.obtained, 1);
  });

  it("counts crafted items only, so picked-up items do not satisfy a crafted milestone", () => {
    const sticks = MilestoneSet.parse({ milestones: [{ id: "stick", description: "Craft sticks", obtained: ["stick"], via: "crafted" }] });
    assert.equal(grade(sticks, { stats: { "minecraft:picked_up": { "minecraft:stick": 4 } } }).reward, 0);
    assert.equal(grade(sticks, { stats: { "minecraft:crafted": { "minecraft:stick": 4 } } }).reward, 1);
  });

  it("digs blocks other than the items they drop", () => {
    const stone = MilestoneSet.parse({ milestones: [{ id: "cobblestone", description: "Get 3 cobblestone", obtained: ["cobblestone"], blocks: ["stone", "cobblestone"], count: 3 }] });
    const result = grade(stone, {
      stats: { "minecraft:mined": { "minecraft:stone": 3 }, "minecraft:picked_up": { "minecraft:cobblestone": 3 } },
    });
    assert.equal(result.reward, 1);
    // Stone dug by hand drops nothing.
    assert.equal(grade(stone, { stats: { "minecraft:mined": { "minecraft:stone": 3 } } }).reward, 0);
  });

  it("rewards only the final milestone, even when earlier ones fall short", () => {
    const result = grade(spec, { stats: { "minecraft:crafted": { "minecraft:crafting_table": 1 } } });
    assert.equal(result.reward, 1);
    assert.equal(result.progress, 0.5);
  });

  it("grades a player without a stats file as zero", () => {
    const result = grade(spec, null);
    assert.equal(result.reward, 0);
    assert.equal(result.progress, 0);
  });

  it("matches ids literally apart from the wildcard", () => {
    const dotted = MilestoneSet.parse({ milestones: [{ id: "x", description: "x", obtained: ["a.b"], via: "crafted" }] });
    assert.equal(grade(dotted, { stats: { "minecraft:crafted": { "minecraft:axb": 1 } } }).reward, 0);
  });
});

describe("offlineUuid", () => {
  it("matches the UUID a vanilla offline-mode server assigns", () => {
    // Observed in a 26.1 server's usercache.json.
    assert.equal(offlineUuid("alpha"), "3206103b-cca6-32a5-9bb8-90aee69563ff");
  });
});
