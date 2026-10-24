import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Block } from "minebot-sdk/routine";
import { createHarness, type Harness } from "minebot-sdk/testing";
import type { Vec3 } from "vec3";
import * as place from "../src/routines/place.ts";

/** Records which reference block (and face) every placement is made against; `after` runs once the harness has placed. */
function spyOnPlacements(h: Harness, after?: (reference: Block, face: Vec3) => void | Promise<void>): string[] {
  const seen: string[] = [];
  const real = h.bot.placeBlock;
  h.bot.placeBlock = async (reference, face) => {
    seen.push(`${reference.position} ${face}`);
    await real(reference, face);
    await after?.(reference, face);
  };
  return seen;
}

describe("place.place: bodies in the cell", () => {
  it("steps out when the bot's box overlaps the cell from a neighbouring cell", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    // Feet are in cell x=0 but the box (0.6 wide) reaches x=1.2: it shares volume with cell x=1.
    h.teleport([0.9, 64, 0.5]);
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([1, 64, 0]).name, "cobblestone");
    assert.ok(h.position.x + 0.3 <= 1 || h.position.x - 0.3 >= 2 || h.position.z + 0.3 <= 0 || h.position.z - 0.3 >= 1, `the bot still overlaps the cell at ${h.position}`);
  });

  for (const [what, spec] of [
    ["a pig", { name: "pig", at: [1.5, 64, 0.5] }],
    ["a zombie", { name: "zombie", at: [1.5, 64, 0.5] }],
    ["another player", { name: "player", username: "Alex", at: [1.5, 64, 0.5] }],
    ["a boat", { name: "oak_boat", at: [1.5, 64, 0.5] }],
    ["a minecart", { name: "minecart", at: [1.5, 64, 0.5] }],
  ] as const) {
    it(`refuses to place into a cell where ${what} stands, naming it and the cell`, async () => {
      const h = createHarness({ inventory: { cobblestone: 1 } });
      h.spawn(spec);
      await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), /is in \(1, 64, 0\)/);
      assert.equal(h.blockAt([1, 64, 0]).name, "air");
      assert.equal(h.count("cobblestone"), 1);
    });
  }

  it("names the creature: a player by username, a mob by its registry name", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    h.spawn({ name: "player", username: "Alex", at: [1.5, 64, 0.5] });
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), /^Error: .*Alex is in \(1, 64, 0\)/);
  });

  it("places into a cell a dropped item lies in", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 }, entities: [{ name: "item", item: "stick", at: [1.5, 64, 0.5] }] });
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([1, 64, 0]).name, "cobblestone");
  });

  it("treats the cell's sides as half-open: a box that only touches the cell does not block, one that reaches in does", async () => {
    // An armor stand is 0.5 wide, so at x=2.25 its box is [2, 2.5): it touches the cell x=1 (spanning [1, 2)) without overlapping it.
    const touching = createHarness({ inventory: { cobblestone: 1 } });
    touching.spawn({ name: "armor_stand", at: [2.25, 64, 0.5] });
    assert.equal(await touching.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    const reaching = createHarness({ inventory: { cobblestone: 1 } });
    reaching.spawn({ name: "armor_stand", at: [2.24, 64, 0.5] });
    await assert.rejects(reaching.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), /is in \(1, 64, 0\)/);
  });

  it("does not count a body standing on top of the cell", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    // The zombie's box starts at y=65, the top of the cell y=64.
    h.spawn({ name: "zombie", at: [1.5, 65, 0.5] });
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
  });
});

/** A world of air with the given blocks; the bot hovers at (0.5, 64, 0.5), eyes at y 65.62. */
const sky = (blocks: { name: string; at: [number, number, number] }[], position: [number, number, number] = [0.5, 64, 0.5]) =>
  createHarness({ ground: false, inventory: { cobblestone: 2 }, blocks, position });

describe("place.place: the face it places against", () => {
  it("skips a neighbor out of reach for one within it", async () => {
    // Target (0,61,0) is 4.1 blocks from the eyes. The block below has its face 4.6 away (and the harness refuses it); the one above is 3.6 away.
    const h = sky([
      { name: "stone", at: [0, 60, 0] },
      { name: "stone", at: [0, 62, 0] },
    ]);
    const seen = spyOnPlacements(h);
    assert.equal(await h.run(place.place, { at: [0, 61, 0], item: "cobblestone" }), true);
    assert.deepEqual(seen, ["(0, 62, 0) (0, -1, 0)"]);
    assert.equal(h.blockAt([0, 61, 0]).name, "cobblestone");
  });

  it("walks closer once when no face is within reach, then places", async () => {
    // Only a block below the target, 4.6 blocks from the eyes; the platform gives the bot somewhere to walk to.
    const h = createHarness({
      ground: false,
      inventory: { cobblestone: 1 },
      position: [0.5, 64, 0.5],
      blocks: [
        { name: "stone", from: [-5, 59, -5], to: [5, 59, 5] },
        { name: "stone", at: [0, 60, 0] },
      ],
    });
    assert.equal(await h.run(place.place, { at: [0, 61, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([0, 61, 0]).name, "cobblestone");
    assert.equal(h.position.y, 60, "the bot walked down onto the platform");
  });

  it("throws, naming the target and the nearest face's distance, when walking does not bring a face into reach", async () => {
    const h = sky([{ name: "stone", at: [0, 60, 0] }]);
    // A walk that ends where it began: the pathfinder stopped early.
    h.bot.pathfinder.goto = async () => {};
    await assert.rejects(
      h.run(place.place, { at: [0, 61, 0], item: "cobblestone" }),
      /no block next to \(0, 61, 0\) has a face within 4\.5 blocks of the bot's eyes.*the nearest is stone at \(0, 60, 0\), its top face 4\.6 blocks away/,
    );
    assert.equal(h.count("cobblestone"), 2);
  });

  it("says so when the cell has no solid neighbor at all", async () => {
    const h = sky([]);
    await assert.rejects(h.run(place.place, { at: [0, 62, 0], item: "cobblestone" }), /nothing solid next to \(0, 62, 0\) to place against/);
  });

  it("prefers a face with a clear line of sight over an earlier one that is hidden", async () => {
    // The bot looks from (2.5, 65.62, 0.5). The block below the target and the one to its east (the bot's side of it) hide their faces behind the east block;
    // the block to the west is in plain view, though it comes later in the order.
    const h = sky(
      [
        { name: "stone", at: [0, 61, 0] },
        { name: "stone", at: [1, 62, 0] },
        { name: "stone", at: [-1, 62, 0] },
      ],
      [2.5, 64, 0.5],
    );
    const seen = spyOnPlacements(h);
    assert.equal(await h.run(place.place, { at: [0, 62, 0], item: "cobblestone" }), true);
    assert.deepEqual(seen, ["(-1, 62, 0) (1, 0, 0)"]);
  });

  it("still places against a face the line of sight does not reach", async () => {
    // From (2.5, 64.62, 0.5) the line to the only face, the top of the block below the target, runs through the stone at (1, 63, 0).
    const h = sky(
      [
        { name: "stone", at: [0, 61, 0] },
        { name: "stone", at: [1, 63, 0] },
      ],
      [2.5, 63, 0.5],
    );
    const seen = spyOnPlacements(h);
    assert.equal(await h.run(place.place, { at: [0, 62, 0], item: "cobblestone" }), true);
    assert.deepEqual(seen, ["(0, 61, 0) (0, 1, 0)"]);
  });
});

/** The harness places one cell; this stands in for the server's second half, or its absence. */
const asDoor = (h: Harness, at: [number, number, number], upper: boolean) =>
  spyOnPlacements(h, () => {
    h.setBlock(at, "oak_door", { half: "lower", facing: "north" });
    if (upper) h.setBlock([at[0], at[1] + 1, at[2]], "oak_door", { half: "upper", facing: "north" });
  });

describe("place.place: every cell holds the block", () => {
  it("returns true for a door whose both halves arrived", async () => {
    const h = createHarness({ inventory: { oak_door: 1 } });
    asDoor(h, [1, 64, 0], true);
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "oak_door" }), true);
  });

  it("throws, naming the upper cell and what it holds, when only the lower half of a door is there", async () => {
    const h = createHarness({ inventory: { oak_door: 1 } });
    asDoor(h, [1, 64, 0], false);
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "oak_door" }), /placed oak_door at \(1, 64, 0\).*its second cell \(1, 65, 0\) holds air, not oak_door/);
  });

  it("checks a bed's head cell, the way the foot faces", async () => {
    const bed = (head: boolean) => {
      const h = createHarness({ inventory: { red_bed: 1 } });
      spyOnPlacements(h, () => {
        h.setBlock([1, 64, 0], "red_bed", { part: "foot", facing: "east" });
        if (head) h.setBlock([2, 64, 0], "red_bed", { part: "head", facing: "east" });
      });
      return h;
    };
    assert.equal(await bed(true).run(place.place, { at: [1, 64, 0], item: "red_bed" }), true);
    await assert.rejects(bed(false).run(place.place, { at: [1, 64, 0], item: "red_bed" }), /its second cell \(2, 64, 0\) holds air, not red_bed/);
  });

  it("throws instead of returning true when the server answered but the cell does not hold the block", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    h.bot.placeBlock = async () => {};
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), /placed cobblestone at \(1, 64, 0\) against stone at \(1, 63, 0\), its top face, 1\.\d blocks from the eyes, but \(1, 64, 0\) holds air, not cobblestone/);
  });

  it("wraps a refusal with the target, the item, the reference block and face, and the eye distance", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    h.bot.placeBlock = async () => {
      throw new Error("Server refused to place cobblestone at (1, 64, 0): the block is still air");
    };
    await assert.rejects(
      h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }),
      /could not place cobblestone at \(1, 64, 0\) against stone at \(1, 63, 0\), its top face, 1\.\d blocks from the eyes: Server refused to place cobblestone at \(1, 64, 0\): the block is still air/,
    );
  });

  it("names the second cell in the refusal of a door", async () => {
    const h = createHarness({ inventory: { oak_door: 1 }, blocks: [{ name: "stone", at: [1, 65, 0] }] });
    h.bot.placeBlock = async () => {
      throw new Error("Server refused to place oak_door at (1, 64, 0): the block is still air");
    };
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "oak_door" }), /needs its upper half, the cell above, \(1, 65, 0\), free: that cell holds stone/);
  });
});
