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

/**
 * Stands in for a server that puts `block` across the face it is sent, whatever stands there (as vanilla does for a block with no
 * collision box), and records the placements. The harness's own placeBlock refuses any body in the cell and checks reach to the block center.
 */
function serverPlaces(h: Harness, block: string, properties?: Record<string, unknown>): string[] {
  const seen: string[] = [];
  h.bot.placeBlock = async (reference, face) => {
    seen.push(`${reference.position} ${face}`);
    const at = reference.position.plus(face);
    h.setBlock([at.x, at.y, at.z], block, properties);
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

  it("does not step out for a block without a collision box: a torch goes where the bot stands", async () => {
    const h = createHarness({ inventory: { torch: 1 } });
    h.teleport([0.9, 64, 0.5]);
    let walked = false;
    h.bot.pathfinder.goto = async () => {
      walked = true;
    };
    const seen = serverPlaces(h, "torch");
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "torch" }), true);
    assert.equal(walked, false, "the bot walked");
    assert.equal(seen.length, 1);
  });

  it("explains a failed step-out: the cell, the cause, and what to do", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 } });
    h.teleport([1.5, 64, 0.5]);
    h.bot.pathfinder.goto = async () => {
      throw new Error("NoPath: No path to the goal!");
    };
    await assert.rejects(
      h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }),
      /^Error: the bot stands in \(1, 64, 0\) and could not step out of it to place cobblestone there \(NoPath: No path to the goal!\)\. Move at least one block away from \(1, 64, 0\) \(move\.to\)/,
    );
  });

  for (const [what, spec, named] of [
    ["a pig", { name: "pig", at: [1.5, 64, 0.5] }, "Pig"],
    ["a zombie", { name: "zombie", at: [1.5, 64, 0.5] }, "Zombie"],
    ["another player", { name: "player", username: "Alex", at: [1.5, 64, 0.5] }, "Alex"],
    ["a boat", { name: "oak_boat", at: [1.5, 64, 0.5] }, "Oak Boat"],
    ["a minecart", { name: "minecart", at: [1.5, 64, 0.5] }, "Minecart"],
  ] as const) {
    it(`sends the placement with ${what} in the cell and, when the server refuses, names it and the cell`, async () => {
      const h = createHarness({ inventory: { cobblestone: 1 } });
      h.spawn(spec);
      const seen = spyOnPlacements(h);
      await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), new RegExp(`^Error: could not place cobblestone at \\(1, 64, 0\\).* ${named} is in \\(1, 64, 0\\)`));
      assert.equal(seen.length, 1, "no placement was sent");
      assert.equal(h.count("cobblestone"), 1);
    });
  }

  for (const [what, spec] of [
    ["a pig", { name: "pig", at: [1.5, 64, 0.5] }],
    ["a villager", { name: "villager", at: [1.5, 64, 0.5] }],
    ["another player", { name: "player", username: "Alex", at: [1.5, 64, 0.5] }],
    ["a minecart", { name: "minecart", at: [1.5, 64, 0.5] }],
  ] as const) {
    it(`places a torch where ${what} stands: nothing is refused up front`, async () => {
      const h = createHarness({ inventory: { torch: 1 } });
      h.spawn(spec);
      const seen = serverPlaces(h, "torch");
      assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "torch" }), true);
      assert.equal(seen.length, 1);
    });
  }

  it("names no body after a refusal of a block without a collision box: the body was not the cause", async () => {
    const h = createHarness({ inventory: { torch: 1 } });
    h.spawn({ name: "pig", at: [1.5, 64, 0.5] });
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "torch" }), (err: Error) => /could not place torch at \(1, 64, 0\)/.test(err.message) && !/Pig/.test(err.message));
  });

  it("measures a baby by its own box: a baby cow beside the cell is not named, an adult there is", async () => {
    // A cow is 0.9 wide: at x=2.4 an adult reaches x=1.95, inside the cell x=1 ([1, 2)); a baby (0.45 wide) reaches only x=2.175.
    const refuse = (baby: boolean) => {
      const h = createHarness({ inventory: { cobblestone: 1 } });
      h.spawn({ name: "cow", at: [2.4, 64, 0.5], baby });
      h.bot.placeBlock = async () => {
        throw new Error("Server refused to place cobblestone at (1, 64, 0): the block is still air");
      };
      return h.run(place.place, { at: [1, 64, 0], item: "cobblestone" });
    };
    await assert.rejects(refuse(false), /Cow is in \(1, 64, 0\)/);
    await assert.rejects(refuse(true), (err: Error) => /could not place cobblestone/.test(err.message) && !/Cow/.test(err.message));
  });

  it("places into a cell a dropped item lies in", async () => {
    const h = createHarness({ inventory: { cobblestone: 1 }, entities: [{ name: "item", item: "stick", at: [1.5, 64, 0.5] }] });
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([1, 64, 0]).name, "cobblestone");
  });

  it("treats the cell's sides as half-open: a box that only touches the cell is not named, one that reaches in is", async () => {
    const refuse = (x: number) => {
      const h = createHarness({ inventory: { cobblestone: 1 } });
      // An armor stand is 0.5 wide, so at x=2.25 its box is [2, 2.5): it touches the cell x=1 (spanning [1, 2)) without overlapping it.
      h.spawn({ name: "armor_stand", at: [x, 64, 0.5] });
      h.bot.placeBlock = async () => {
        throw new Error("Server refused to place cobblestone at (1, 64, 0): the block is still air");
      };
      return h.run(place.place, { at: [1, 64, 0], item: "cobblestone" });
    };
    await assert.rejects(refuse(2.25), (err: Error) => !/Armor Stand/.test(err.message));
    await assert.rejects(refuse(2.24), /Armor Stand is in \(1, 64, 0\)/);
  });

  it("names a body in a door's upper cell after a refusal", async () => {
    const h = createHarness({ inventory: { oak_door: 1 } });
    // The zombie's feet are at y=65: it is in the cell above the target, not the target.
    h.spawn({ name: "zombie", at: [1.5, 65, 0.5] });
    h.bot.placeBlock = async () => {
      throw new Error("Server refused to place oak_door at (1, 64, 0): the block is still air");
    };
    await assert.rejects(h.run(place.place, { at: [1, 64, 0], item: "oak_door" }), /Zombie is in \(1, 65, 0\)/);
  });
});

/** A world of air with the given blocks; the bot hovers at (0.5, 64, 0.5), eyes at y 65.62. */
const sky = (blocks: { name: string; at: [number, number, number] }[], position: [number, number, number] = [0.5, 64, 0.5]) =>
  createHarness({ ground: false, inventory: { cobblestone: 2 }, blocks, position });

describe("place.place: the face it places against", () => {
  it("prefers a neighbor within 4.5 over an earlier one farther away", async () => {
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

  it("places from where it stands when the nearest face is 4.6 blocks away: it walks only past 5", async () => {
    const h = sky([{ name: "stone", at: [0, 60, 0] }]);
    let walked = false;
    h.bot.pathfinder.goto = async () => {
      walked = true;
    };
    const seen = serverPlaces(h, "cobblestone");
    assert.equal(await h.run(place.place, { at: [0, 61, 0], item: "cobblestone" }), true);
    assert.equal(walked, false, "the bot walked");
    assert.deepEqual(seen, ["(0, 60, 0) (0, 1, 0)"]);
  });

  it("walks closer once when no face is within 5 blocks, then places", async () => {
    // Only a block below the target, its face 5.6 blocks from the eyes; the platform gives the bot somewhere to walk to.
    const h = createHarness({
      ground: false,
      inventory: { cobblestone: 1 },
      position: [0.5, 64, 0.5],
      blocks: [
        { name: "stone", from: [-5, 58, -5], to: [5, 58, 5] },
        { name: "stone", at: [0, 59, 0] },
      ],
    });
    assert.equal(await h.run(place.place, { at: [0, 60, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([0, 60, 0]).name, "cobblestone");
    assert.equal(h.position.y, 59, "the bot walked down onto the platform");
  });

  it("explains a failed walk: the target, the cause, the nearest face, and what to do", async () => {
    const h = sky([{ name: "stone", at: [0, 59, 0] }]);
    h.bot.pathfinder.goto = async () => {
      throw new Error("NoPath: No path to the goal!");
    };
    await assert.rejects(
      h.run(place.place, { at: [0, 60, 0], item: "cobblestone" }),
      /^Error: could not walk close enough to place cobblestone at \(0, 60, 0\): NoPath: No path to the goal!\. The nearest face to place against is stone at \(0, 59, 0\), its top face, 5\.6 blocks from the eyes; it has to be within 5\. Walk to a spot next to \(0, 60, 0\) first \(move\.to\)/,
    );
    assert.equal(h.count("cobblestone"), 2);
  });

  it("still tries the nearest face when walking does not bring one within 5 blocks: the server takes some farther ones", async () => {
    const h = sky([{ name: "stone", at: [0, 59, 0] }]);
    // A walk that ends where it began: the pathfinder stopped early.
    h.bot.pathfinder.goto = async () => {};
    const seen = serverPlaces(h, "cobblestone");
    assert.equal(await h.run(place.place, { at: [0, 60, 0], item: "cobblestone" }), true);
    assert.deepEqual(seen, ["(0, 59, 0) (0, 1, 0)"]);
  });

  it("says the face was more than 5 blocks away, and to move next to the target, when the server refuses it", async () => {
    const h = sky([{ name: "stone", at: [0, 59, 0] }]);
    h.bot.pathfinder.goto = async () => {};
    await assert.rejects(
      h.run(place.place, { at: [0, 60, 0], item: "cobblestone" }),
      /^Error: could not place cobblestone at \(0, 60, 0\) against stone at \(0, 59, 0\), its top face, 5\.6 blocks from the eyes: .* That face is more than 5 blocks from the eyes: move next to \(0, 60, 0\) \(move\.to\) and call again\./,
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

  it("places against plain stone rather than a crafting table, which would open its window", async () => {
    // The crafting table is below the target, first in the order; the stone beside it comes later.
    const h = sky([
      { name: "crafting_table", at: [0, 61, 0] },
      { name: "stone", at: [1, 62, 0] },
    ]);
    const seen = spyOnPlacements(h);
    assert.equal(await h.run(place.place, { at: [0, 62, 0], item: "cobblestone" }), true);
    assert.deepEqual(seen, ["(1, 62, 0) (-1, 0, 0)"]);
  });

  it("sneaks while placing against a crafting table when there is nothing else, and stops after", async () => {
    const h = sky([{ name: "crafting_table", at: [0, 61, 0] }]);
    const sneaking: boolean[] = [];
    spyOnPlacements(h, () => {
      sneaking.push(h.bot.controlState.sneak === true);
    });
    assert.equal(await h.run(place.place, { at: [0, 62, 0], item: "cobblestone" }), true);
    assert.deepEqual(sneaking, [true]);
    assert.equal(h.bot.controlState.sneak, false);
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

  for (const [item, block, properties] of [
    ["torch", "wall_torch", { facing: "east" }],
    ["oak_sign", "oak_wall_sign", { facing: "east" }],
    ["bamboo", "bamboo_sapling", {}],
  ] as const) {
    it(`returns true when ${item} became ${block}`, async () => {
      const h = createHarness({ inventory: { [item]: 1 } });
      serverPlaces(h, block, properties);
      assert.equal(await h.run(place.place, { at: [1, 64, 0], item }), true);
    });
  }

  it("returns false when a torch is already on the wall there", async () => {
    const h = createHarness({ inventory: { torch: 1 }, blocks: [{ name: "wall_torch", at: [1, 64, 0], properties: { facing: "east" } }] });
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "torch" }), false);
    assert.equal(h.count("torch"), 1);
  });

  it("returns only once the server has taken the item from the hand, so a next call does not pick a stack that is empty on the server", async () => {
    const h = createHarness({ inventory: { cobblestone: 2 } });
    // The block shows at once; the inventory shows the item taken only once a game tick has passed, as on a real server.
    h.bot.placeBlock = async (reference, face) => {
      const at = reference.position.plus(face);
      h.setBlock([at.x, at.y, at.z], "cobblestone");
      const held = h.bot.heldItem;
      if (!held) throw new Error("nothing in hand");
      const placedAt = h.bot.time.age;
      const count = held.count;
      Object.defineProperty(held, "count", { configurable: true, get: () => (h.bot.time.age > placedAt ? count - 1 : count) });
    };
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.count("cobblestone"), 1, "returned before the inventory showed the item used");
  });

  it("returns true for a pitcher pod: a young pitcher crop fills one cell though it has a lower half", async () => {
    const h = createHarness({ inventory: { pitcher_pod: 1 } });
    serverPlaces(h, "pitcher_crop", { age: 0, half: "lower" });
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "pitcher_pod" }), true);
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
