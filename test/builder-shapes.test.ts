// builder.line, arc, fill, box and combine against definitions computed here from the written rules, not by the
// implementation, and builder.build/check/materials on 'air' cells over the harness's world.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as builder from "../src/routines/builder.ts";

type Xyz = [number, number, number];
type Placed = { origin: { x: number; y: number; z: number }; blueprint: Parameters<typeof builder.blueprintBlocks>[0] };

const key = (c: readonly number[]) => c.join(",");

/** Absolute cell -> block of a placed blueprint, read through the blueprint decoder the routines share. */
function cellsOf(placed: Placed): Map<string, string> {
  const cells = new Map<string, string>();
  for (const b of builder.blueprintBlocks(placed.blueprint)) cells.set(key([placed.origin.x + b.dx, placed.origin.y + b.dy, placed.origin.z + b.dz]), b.block);
  return cells;
}

const sorted = (cells: Map<string, string>) => [...cells].sort(([a], [b]) => (a < b ? -1 : 1));
const keysOf = (placed: Placed) => [...cellsOf(placed).keys()].sort();

const h = createHarness();

/** 3D Bresenham written the classic way, one branch per dominant axis, from the lexicographically smaller end; a minor axis steps when its error is above 0. */
function referenceLine(a: Xyz, b: Xyz): Xyz[] {
  const [start, end] = a[0] - b[0] || a[1] - b[1] || a[2] - b[2] ? ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0 ? [a, b] : [b, a]) : [a, b];
  let [x, y, z] = start;
  const [x2, y2, z2] = end;
  const dx = Math.abs(x2 - x);
  const dy = Math.abs(y2 - y);
  const dz = Math.abs(z2 - z);
  const xs = x2 > x ? 1 : -1;
  const ys = y2 > y ? 1 : -1;
  const zs = z2 > z ? 1 : -1;
  const cells: Xyz[] = [[x, y, z]];
  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx;
    let p2 = 2 * dz - dx;
    while (x !== x2) {
      x += xs;
      if (p1 > 0) {
        y += ys;
        p1 -= 2 * dx;
      }
      if (p2 > 0) {
        z += zs;
        p2 -= 2 * dx;
      }
      p1 += 2 * dy;
      p2 += 2 * dz;
      cells.push([x, y, z]);
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy;
    let p2 = 2 * dz - dy;
    while (y !== y2) {
      y += ys;
      if (p1 > 0) {
        x += xs;
        p1 -= 2 * dy;
      }
      if (p2 > 0) {
        z += zs;
        p2 -= 2 * dy;
      }
      p1 += 2 * dx;
      p2 += 2 * dz;
      cells.push([x, y, z]);
    }
  } else {
    let p1 = 2 * dy - dz;
    let p2 = 2 * dx - dz;
    while (z !== z2) {
      z += zs;
      if (p1 > 0) {
        y += ys;
        p1 -= 2 * dz;
      }
      if (p2 > 0) {
        x += xs;
        p2 -= 2 * dz;
      }
      p1 += 2 * dy;
      p2 += 2 * dx;
      cells.push([x, y, z]);
    }
  }
  return cells;
}

/** Mulberry32: a seeded generator, so a failure names the same case every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The cells of `layers` (rows along z, characters along x, '.' skips) at `at`, each character read through `legend`. */
function picture(at: Xyz, layers: string[][], legend: Record<string, string>): Map<string, string> {
  const cells = new Map<string, string>();
  layers.forEach((rows, dy) =>
    rows.forEach((row, dz) =>
      [...row].forEach((ch, dx) => {
        if (ch !== ".") cells.set(key([at[0] + dx, at[1] + dy, at[2] + dz]), legend[ch]!);
      }),
    ),
  );
  return cells;
}

describe("builder.line", () => {
  it("is the integer 3D Bresenham from the lexicographically smaller end, for every pair of cells in a 4x4x4 cube with negative coordinates", async () => {
    const coords = [-1, 0, 1, 2];
    const cube: Xyz[] = coords.flatMap((x) => coords.flatMap((y) => coords.map((z): Xyz => [x, y, z])));
    for (const a of cube) {
      for (const b of cube) {
        const placed = await h.run(builder.line, { from: a, to: b, block: "stone" });
        const expected = referenceLine(a, b);
        assert.equal(expected.length, Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) + 1);
        assert.deepEqual(keysOf(placed), expected.map(key).sort(), `line ${key(a)} -> ${key(b)}`);
        assert.ok([...cellsOf(placed).values()].every((block) => block === "stone"));
      }
    }
  });

  it("matches a hand-worked line, and is the same from either end", async () => {
    const forward = await h.run(builder.line, { from: [0, 64, 0], to: [5, 64, 2], block: "oak_planks" });
    assert.deepEqual(keysOf(forward), ["0,64,0", "1,64,0", "2,64,1", "3,64,1", "4,64,2", "5,64,2"]);
    const backward = await h.run(builder.line, { from: [5, 64, 2], to: [0, 64, 0], block: "oak_planks" });
    assert.deepEqual(forward, backward);
    // One cell when the ends are the same.
    assert.deepEqual(keysOf(await h.run(builder.line, { from: [3, 70, -4], to: { x: 3, y: 70, z: -4 }, block: "stone" })), ["3,70,-4"]);
  });

  it("returns a placed blueprint: origin at the lowest corner, in world coordinates, with the block's namespace dropped", async () => {
    const placed = await h.run(builder.line, { from: [10, 64, -3], to: [12, 66, -3], block: "minecraft:stone_bricks" });
    assert.deepEqual(placed.origin, { x: 10, y: 64, z: -3 });
    assert.deepEqual(placed.blueprint.palette, { "#": "stone_bricks" });
    assert.deepEqual(keysOf(placed), ["10,64,-3", "11,65,-3", "12,66,-3"]);
  });

  it("floors fractional coordinates, as build floors its origin", async () => {
    assert.deepEqual(keysOf(await h.run(builder.line, { from: [0.9, 64.5, 0.2], to: [2.1, 64.5, 0.2], block: "stone" })), ["0,64,0", "1,64,0", "2,64,0"]);
  });
});

describe("builder.fill", () => {
  it("is every cell of the inclusive cuboid, whichever corners come first", async () => {
    const placed = await h.run(builder.fill, { from: [3, 66, -1], to: [1, 64, 0], block: "dirt" });
    const expected: string[] = [];
    for (let x = 1; x <= 3; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 0; z++) expected.push(key([x, y, z]));
    assert.deepEqual(keysOf(placed), expected.sort());
    assert.equal(expected.length, 18);
    assert.deepEqual(placed.origin, { x: 1, y: 64, z: -1 });
  });

  it("accepts 'air' and a single cell", async () => {
    const placed = await h.run(builder.fill, { from: [0, 64, 0], to: [0, 64, 0], block: "air" });
    assert.deepEqual([...cellsOf(placed)], [["0,64,0", "air"]]);
  });

  it("refuses a bounding box past 4,000,000 cells, naming the size", async () => {
    await assert.rejects(h.run(builder.fill, { from: [0, 0, 0], to: [100000, 10, 10], block: "stone" }), /spans 100001 x 11 x 11 blocks .*limit is 4,000,000/);
    await assert.rejects(h.run(builder.line, { from: [0, 0, 0], to: [9_000_000, 0, 0], block: "stone" }), /limit is 4,000,000/);
  });
});

/** A reference for the arc's definition by floats: the curve at t, in the vertical plane through the ends. */
function curveAt(from: Xyz, to: Xyz, rise: number, t: number): Xyz {
  const A = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + rise, (from[2] + to[2]) / 2];
  // Quadratic Bezier through from and to with the control point that puts the apex at A.
  const C = [2 * A[0]! - (from[0] + to[0]) / 2, 2 * A[1]! - (from[1] + to[1]) / 2, 2 * A[2]! - (from[2] + to[2]) / 2];
  return [0, 1, 2].map((k) => (1 - t) ** 2 * from[k]! + 2 * t * (1 - t) * C[k]! + t ** 2 * to[k]!) as Xyz;
}

/** True when the cells form one piece that contains both ends, cells joined across faces only or also across edges and corners. */
function connected(cells: Set<string>, from: Xyz, to: Xyz, joins: "faces" | "corners"): boolean {
  const seen = new Set([key(from)]);
  const queue = [from];
  while (queue.length > 0) {
    const [x, y, z] = queue.pop()!;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (joins === "faces" && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) !== 1) continue;
          const next: Xyz = [x + dx, y + dy, z + dz];
          if (cells.has(key(next)) && !seen.has(key(next))) {
            seen.add(key(next));
            queue.push(next);
          }
        }
      }
    }
  }
  return seen.size === cells.size && seen.has(key(to));
}

describe("builder.arc", () => {
  it("passes through (3,67,0) for (0,64,0) -> (6,64,0) with rise 3, and holds exactly the hand-worked cells", async () => {
    const placed = await h.run(builder.arc, { from: [0, 64, 0], to: [6, 64, 0], rise: 3, block: "stone_bricks" });
    const cells = new Set(keysOf(placed));
    for (const cell of ["3,67,0", "0,64,0", "6,64,0"]) assert.ok(cells.has(cell), `${cell} is in the arc`);
    // The 13 samples at t = i / 12 (x, then y above the ends, each rounded half up), with the block under each step that rises by an edge.
    assert.deepEqual(
      [...cells].sort(),
      ["0,64,0", "1,64,0", "1,65,0", "1,66,0", "2,66,0", "2,67,0", "3,67,0", "4,67,0", "4,66,0", "5,66,0", "5,65,0", "6,65,0", "6,64,0"].sort(),
    );
  });

  it("has the apex, the ends, connected cells, and the curve's shape, for random ends and rises (negative and zero included)", async () => {
    const next = random(7);
    const pick = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let n = 0; n < 60; n++) {
      const from: Xyz = [pick(-8, 8), pick(60, 70), pick(-8, 8)];
      const to: Xyz = [pick(-8, 8), pick(60, 70), pick(-8, 8)];
      const rise = pick(-6, 8);
      if (from[0] === to[0] && from[2] === to[2] && rise !== 0) continue;
      const placed = await h.run(builder.arc, { from, to, rise, block: "stone" });
      const cells = new Set(keysOf(placed));
      const where = `arc ${key(from)} -> ${key(to)} rise ${rise}`;
      assert.ok(cells.has(key(from)) && cells.has(key(to)), `${where}: ends`);
      // The apex: a cell at y = round(A.y) whose x and z are within half a block of A's (a rise of 0 is the line, which is held to its own rule above).
      const apex = curveAt(from, to, rise, 0.5);
      const near = [...cells].some((c) => {
        const [x, y, z] = c.split(",").map(Number) as Xyz;
        return y === Math.round(apex[1]) && Math.abs(x - apex[0]) <= 0.5 && Math.abs(z - apex[2]) <= 0.5;
      });
      if (rise !== 0) assert.ok(near, `${where}: apex ${apex}`);
      assert.ok(connected(cells, from, to, rise === 0 ? "corners" : "faces"), `${where}: one piece, ${rise === 0 ? "across corners" : "across faces, so each block can be placed against the one before"}`);
      // Every cell lies within a block and a half of the curve (the cells added between samples can be one block off a sampled cell), and every point of the curve within a block of a cell.
      const cellList = [...cells].map((c) => c.split(",").map(Number) as Xyz);
      const steps = 2000;
      const curve = Array.from({ length: steps + 1 }, (_, i) => curveAt(from, to, rise, i / steps));
      const within = (p: Xyz, q: Xyz, d: number) => [0, 1, 2].every((k) => Math.abs(p[k]! - q[k]!) <= d + 1e-9);
      for (const c of cellList) assert.ok(curve.some((p) => within(c, p, 1.5 + 0.02)), `${where}: cell ${c} is off the curve`);
      for (const p of curve) assert.ok(cellList.some((c) => within(c, p, 1)), `${where}: the curve at ${p} has no cell`);
    }
  });

  it("is connected on a 20-block span, whichever way it climbs", async () => {
    for (const [from, to, rise] of [
      [[0, 64, 0], [20, 64, 0], 6],
      [[0, 64, 0], [20, 70, 7], 9],
      [[20, 64, 0], [0, 64, 5], 3],
      [[0, 64, 0], [2, 64, 0], 10],
    ] as [Xyz, Xyz, number][]) {
      const cells = new Set(keysOf(await h.run(builder.arc, { from, to, rise, block: "stone" })));
      assert.ok(connected(cells, from, to, "faces"), `arc ${key(from)} -> ${key(to)} rise ${rise}`);
    }
  });

  it("is the same set from either end, for any rise", async () => {
    const next = random(11);
    const pick = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let n = 0; n < 80; n++) {
      const from: Xyz = [pick(-9, 9), pick(60, 70), pick(-9, 9)];
      const to: Xyz = [pick(-9, 9), pick(60, 70), pick(-9, 9)];
      const rise = pick(-6, 8);
      if (from[0] === to[0] && from[2] === to[2] && rise !== 0) continue;
      const forward = await h.run(builder.arc, { from, to, rise, block: "stone" });
      const backward = await h.run(builder.arc, { from: to, to: from, rise, block: "stone" });
      assert.deepEqual(sorted(cellsOf(forward)), sorted(cellsOf(backward)), `arc ${key(from)} -> ${key(to)} rise ${rise}`);
    }
  });

  it("with rise 0 is the line between the ends, including slanted pairs where rounding a straight interpolation would differ", async () => {
    const next = random(3);
    const pick = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const pairs: [Xyz, Xyz][] = [[[0, 64, 0], [4, 64, 1]], [[0, 64, 0], [5, 66, 2]], [[2, 60, -3], [-5, 63, 4]]];
    for (let n = 0; n < 40; n++) pairs.push([[pick(-9, 9), pick(60, 70), pick(-9, 9)], [pick(-9, 9), pick(60, 70), pick(-9, 9)]]);
    for (const [from, to] of pairs) {
      const arc = await h.run(builder.arc, { from, to, rise: 0, block: "stone" });
      assert.deepEqual(keysOf(arc), referenceLine(from, to).map(key).sort(), `arc rise 0 ${key(from)} -> ${key(to)}`);
    }
  });

  it("defaults the rise to half the horizontal distance, rounded", async () => {
    // 3 by 4 apart horizontally is 5: rise round(2.5) = 3.
    const defaulted = await h.run(builder.arc, { from: [0, 64, 0], to: [3, 64, 4], block: "stone" });
    const explicit = await h.run(builder.arc, { from: [0, 64, 0], to: [3, 64, 4], rise: 3, block: "stone" });
    assert.deepEqual(defaulted, explicit);
    const top = Math.max(...[...cellsOf(defaulted).keys()].map((c) => Number(c.split(",")[1])));
    assert.equal(top, 67);
    // 6 apart: rise 3; a level span of 1: rise round(0.5) = 1.
    assert.deepEqual(keysOf(await h.run(builder.arc, { from: [0, 64, 0], to: [6, 64, 0], block: "stone" })), keysOf(await h.run(builder.arc, { from: [0, 64, 0], to: [6, 64, 0], rise: 3, block: "stone" })));
    assert.equal(Math.max(...[...cellsOf(await h.run(builder.arc, { from: [0, 64, 0], to: [1, 64, 0], block: "stone" })).keys()].map((c) => Number(c.split(",")[1]))), 65);
  });

  it("sags with a negative rise", async () => {
    const cells = [...cellsOf(await h.run(builder.arc, { from: [0, 64, 0], to: [6, 64, 0], rise: -3, block: "stone" })).keys()];
    assert.ok(cells.includes("3,61,0"));
    assert.equal(Math.max(...cells.map((c) => Number(c.split(",")[1]))), 64);
  });

  it("names the fix when the ends share a column, and for a rise that is out of range", async () => {
    await assert.rejects(h.run(builder.arc, { from: [0, 64, 0], to: [0, 70, 0], rise: 2, block: "stone" }), /same column.*builder\.line/);
    // Rise 0 over one column is a vertical line.
    assert.deepEqual(keysOf(await h.run(builder.arc, { from: [0, 64, 0], to: [0, 66, 0], rise: 0, block: "stone" })), ["0,64,0", "0,65,0", "0,66,0"]);
    await assert.rejects(h.run(builder.arc, { from: [0, 64, 0], to: [4, 64, 0], rise: 20_000, block: "stone" }), /rise of 20000 over 4 blocks is too large/);
    await assert.rejects(h.run(builder.arc, { from: [0, 64, 0], to: [4, 64, 0], rise: 1.5, block: "stone" }), /rise/);
  });
});

describe("builder.box", () => {
  const legend = { W: "cobblestone", F: "oak_planks", R: "spruce_planks", "~": "air", D: "oak_door" };

  it("matches a hand-drawn 5x5 box with floor, roof and a south door: the door's two cells are the lowest above the floor", async () => {
    const placed = await h.run(builder.box, { from: [4, 67, 4], to: [0, 64, 0], wall: "cobblestone", floor: "oak_planks", roof: "spruce_planks", door: { side: "south" } });
    const expected = picture(
      [0, 64, 0],
      [
        ["FFFFF", "FFFFF", "FFFFF", "FFFFF", "FFFFF"],
        ["WWWWW", "W~~~W", "W~~~W", "W~~~W", "WW~WW"],
        ["WWWWW", "W~~~W", "W~~~W", "W~~~W", "WW~WW"],
        ["RRRRR", "RRRRR", "RRRRR", "RRRRR", "RRRRR"],
      ],
      legend,
    );
    assert.deepEqual(sorted(cellsOf(placed)), sorted(expected));
    assert.deepEqual(placed.origin, { x: 0, y: 64, z: 0 });
  });

  it("puts the door block in the lower door cell and leaves the upper cell out of the blueprint", async () => {
    const placed = await h.run(builder.box, { from: [0, 64, 0], to: [4, 67, 4], wall: "cobblestone", floor: "oak_planks", roof: "spruce_planks", door: { side: "north", block: "oak_door" } });
    const cells = cellsOf(placed);
    assert.equal(cells.get("2,65,0"), "oak_door");
    assert.equal(cells.has("2,66,0"), false);
    assert.equal(cells.get("2,65,4"), "cobblestone");
    assert.equal(cells.get("2,66,4"), "cobblestone");
  });

  it("puts the door at the lower of the two middle cells on an even side, on each of the four sides", async () => {
    // 4 wide (x 0..3) and 6 deep (z 0..5): north/south middles x 1|2 -> 1; east/west middles z 2|3 -> 2.
    const expectedDoor: Record<string, string> = { north: "1,65,0", south: "1,65,5", east: "3,65,2", west: "0,65,2" };
    for (const side of ["north", "south", "east", "west"] as const) {
      const cells = cellsOf(await h.run(builder.box, { from: [0, 64, 0], to: [3, 67, 5], wall: "cobblestone", floor: "oak_planks", roof: "spruce_planks", door: { side } }));
      assert.equal(cells.get(expectedDoor[side]!), "air", `${side} door, lower cell`);
      const [x, y, z] = expectedDoor[side]!.split(",").map(Number) as Xyz;
      assert.equal(cells.get(key([x, y + 1, z])), "air", `${side} door, upper cell`);
      // No other wall cell of the box is air: the two door cells are the only gap in the ring.
      const gaps = [...cells].filter(([k, b]) => {
        const [cx, , cz] = k.split(",").map(Number) as Xyz;
        const ring = cx === 0 || cx === 3 || cz === 0 || cz === 5;
        return ring && b === "air";
      });
      assert.equal(gaps.length, 2, `${side}: only the doorway is open`);
    }
  });

  it("without a floor the door starts at from.y; the bottom layer is inside, open to the ground", async () => {
    const cells = cellsOf(await h.run(builder.box, { from: [0, 64, 0], to: [4, 66, 4], wall: "cobblestone", roof: "spruce_planks", door: { side: "east" } }));
    assert.equal(cells.get("4,64,2"), "air");
    assert.equal(cells.get("4,65,2"), "air");
    assert.equal(cells.get("4,66,2"), "spruce_planks");
    assert.equal(cells.get("2,64,2"), "air", "the bottom layer's inside is cleared");
    assert.equal(cells.get("0,64,0"), "cobblestone", "the bottom layer has walls");
    assert.equal(cells.get("2,64,0"), "cobblestone");
  });

  it("is a cuboid shell: walls on the four sides, the floor and roof the whole bottom and top face, the inside air, for every combination of floor and roof", async () => {
    for (const floor of [undefined, "oak_planks"]) {
      for (const roof of [undefined, "spruce_planks"]) {
        for (const [w, d] of [[1, 1], [2, 5], [3, 3], [6, 4]] as const) {
          const top = 64 + 4;
          const placed = await h.run(builder.box, { from: [-2, 64, 3], to: [-2 + w - 1, top, 3 + d - 1], wall: "stone", floor, roof });
          const expected = new Map<string, string>();
          for (let x = 0; x < w; x++) {
            for (let y = 64; y <= top; y++) {
              for (let z = 0; z < d; z++) {
                const at = key([-2 + x, y, 3 + z]);
                const onSide = x === 0 || x === w - 1 || z === 0 || z === d - 1;
                if (floor && y === 64) expected.set(at, floor);
                else if (roof && y === top) expected.set(at, roof);
                else expected.set(at, onSide ? "stone" : "air");
              }
            }
          }
          assert.deepEqual(sorted(cellsOf(placed)), sorted(expected), `${w}x${d} floor ${floor} roof ${roof}`);
        }
      }
    }
  });

  it("builds at the height boundaries and throws below them, naming the fix", async () => {
    const make = (y1: number, options: { floor?: string; roof?: string }) => h.run(builder.box, { from: [0, 64, 0], to: [4, y1, 4], wall: "cobblestone", ...options });
    const both = { floor: "oak_planks", roof: "spruce_planks" };
    await assert.rejects(make(66, both), /y 64 to 66 is 3 blocks high.*floor and a roof use up 2.*2 free layers.*to\.y 67 or more/);
    await make(67, both);
    await make(66, { roof: "spruce_planks" });
    await make(66, { floor: "oak_planks" });
    await make(65, {});
    await assert.rejects(make(64, {}), /1 block high.*2 free layers/);
    await assert.rejects(make(65, both), /y 64 to 65/);
    await assert.rejects(make(65, { roof: "spruce_planks" }), /roof uses up 1.*to\.y 66 or more/);
    await assert.rejects(make(64, { floor: "oak_planks" }), /builder\.fill/);
  });

  it("refuses a door on a side under 3 blocks long, naming the sides that fit", async () => {
    await assert.rejects(
      h.run(builder.box, { from: [0, 64, 0], to: [1, 67, 5], wall: "cobblestone", door: { side: "north" } }),
      /north side is 2 blocks long and a door needs 3.*wider along x, or put the door on the east or west side/,
    );
    await assert.rejects(h.run(builder.box, { from: [0, 64, 0], to: [1, 67, 1], wall: "cobblestone", door: { side: "east" } }), /east side is 2 blocks long.*wider along z$/);
    const narrow = await h.run(builder.box, { from: [0, 64, 0], to: [2, 67, 5], wall: "cobblestone", door: { side: "north" } });
    assert.equal(cellsOf(narrow).get("1,64,0"), "air");
  });
});

describe("builder.combine", () => {
  it("is the union of its parts' cells, later parts over earlier at the same cell, with the lowest origin", async () => {
    const parts = [
      await h.run(builder.fill, { from: [0, 64, 0], to: [4, 66, 4], block: "stone" }),
      await h.run(builder.fill, { from: [1, 65, 1], to: [3, 66, 3], block: "air" }),
      await h.run(builder.line, { from: [-3, 64, 2], to: [2, 64, 2], block: "oak_planks" }),
      { origin: [2, 70, 2] as Xyz, blueprint: { palette: { x: "glass" }, layers: ["xx"] } },
    ];
    const combined = await h.run(builder.combine, { parts });
    const expected = new Map<string, string>();
    for (const part of parts) {
      const origin = Array.isArray(part.origin) ? part.origin : [part.origin.x, part.origin.y, part.origin.z];
      for (const b of builder.blueprintBlocks(part.blueprint)) expected.set(key([origin[0]! + b.dx, origin[1]! + b.dy, origin[2]! + b.dz]), b.block);
    }
    assert.deepEqual(sorted(cellsOf(combined)), sorted(expected));
    assert.deepEqual(combined.origin, { x: -3, y: 64, z: 0 });
    // Overridden cells: the air cut the stone, the line cut the air at (1..2, 64, 2).
    const cells = cellsOf(combined);
    assert.equal(cells.get("2,65,2"), "air");
    assert.equal(cells.get("2,64,2"), "oak_planks");
    assert.equal(cells.get("3,70,2"), "glass");
  });

  it("lets a later 'air' fill cut a doorway through an earlier wall, and the earlier wall win when it comes later", async () => {
    const wall = await h.run(builder.fill, { from: [0, 64, 0], to: [4, 66, 0], block: "stone" });
    const hole = await h.run(builder.fill, { from: [2, 64, 0], to: [2, 65, 0], block: "air" });
    const cut = cellsOf(await h.run(builder.combine, { parts: [wall, hole] }));
    assert.equal(cut.get("2,64,0"), "air");
    assert.equal(cut.get("2,66,0"), "stone");
    const filled = cellsOf(await h.run(builder.combine, { parts: [hole, wall] }));
    assert.equal(filled.get("2,64,0"), "stone");
  });

  it("drops palette entries that a later part covered, and keeps a part that is only skips", async () => {
    const under = await h.run(builder.fill, { from: [0, 64, 0], to: [1, 64, 0], block: "dirt" });
    const over = await h.run(builder.fill, { from: [0, 64, 0], to: [1, 64, 0], block: "stone" });
    const combined = await h.run(builder.combine, { parts: [under, over] });
    assert.deepEqual(Object.values(combined.blueprint.palette), ["stone"]);
    const empty = { origin: [9, 64, 9] as Xyz, blueprint: { palette: {}, layers: ["."] } };
    const withEmpty = await h.run(builder.combine, { parts: [over, empty] });
    assert.deepEqual(keysOf(withEmpty), ["0,64,0", "1,64,0"]);
    assert.deepEqual(withEmpty.origin, { x: 0, y: 64, z: 0 });
  });

  it("refuses an empty parts list and a bounding box past the limit", async () => {
    await assert.rejects(h.run(builder.combine, { parts: [] }), /parts/);
    const a = await h.run(builder.fill, { from: [0, 64, 0], to: [0, 64, 0], block: "stone" });
    const b = await h.run(builder.fill, { from: [100000, 64, 100000], to: [100000, 64, 100000], block: "stone" });
    await assert.rejects(h.run(builder.combine, { parts: [a, b] }), (err: Error) => {
      // Combining the parts again would hit the same bounding box, so the advice is to build them separately.
      assert.match(err.message, /limit is 4,000,000\. Check the coordinates; for a structure this large, build its parts separately, one builder.build each/);
      assert.doesNotMatch(err.message, /combine/);
      return true;
    });
  });

  it("holds more than 90 different blocks in one blueprint", async () => {
    const blocks = Object.values(h.bot.registry.blocksByName)
      .map((b) => b!.name)
      .slice(1, 121);
    const parts = await Promise.all(blocks.map((block, i) => h.run(builder.fill, { from: [i, 64, 0], to: [i, 64, 0], block })));
    const combined = await h.run(builder.combine, { parts });
    assert.equal(Object.keys(combined.blueprint.palette).length, 120);
    assert.deepEqual([...cellsOf(combined).values()], blocks);
  });
});

describe("builder.build and builder.check take a shape's result as it is", () => {
  // The harness's place needs the target, and the block it places against, within 4.5 blocks of the eyes after one walk, so each structure is small and beside the bot.
  const flat = (position: Xyz) => createHarness({ inventory: { cobblestone: 64, oak_planks: 64, stone_bricks: 64 }, position });

  it("builds a box and an arc of stone bricks, then check reports every cell correct", async () => {
    const g = flat([4.5, 64, 2.5]);
    const box = await g.run(builder.box, { from: [3, 64, 3], to: [5, 67, 5], wall: "cobblestone", floor: "cobblestone", roof: "oak_planks", door: { side: "south" } });
    const built = await g.run(builder.build, box);
    assert.deepEqual(built.failed, []);
    const total = builder.blueprintBlocks(box.blueprint).length;
    assert.equal(built.placed + built.alreadyCorrect, total);
    assert.deepEqual(await g.run(builder.check, box), { correct: total, total, mismatches: [] });
    assert.equal(g.blockAt([4, 65, 5]).name, "air");
    assert.equal(g.blockAt([4, 66, 5]).name, "air");
    assert.equal(g.blockAt([4, 67, 4]).name, "oak_planks");

    const outside = flat([13.5, 64, 2.5]);
    const arc = await outside.run(builder.arc, { from: [10, 64, 0], to: [16, 64, 0], rise: 3, block: "stone_bricks" });
    const arcBuilt = await outside.run(builder.build, arc);
    assert.deepEqual(arcBuilt.failed, []);
    assert.equal(outside.blockAt([13, 67, 0]).name, "stone_bricks");
    const arcTotal = builder.blueprintBlocks(arc.blueprint).length;
    assert.deepEqual(await outside.run(builder.check, arc), { correct: arcTotal, total: arcTotal, mismatches: [] });
    assert.deepEqual(await outside.run(builder.materials, arc), { stone_bricks: arcTotal });
  });

  it("builds a combined blueprint: a wall with a doorway cut by a later 'air' fill", async () => {
    const g = flat([5.5, 64, 0.5]);
    const wall = await g.run(builder.fill, { from: [3, 64, 3], to: [7, 66, 3], block: "cobblestone" });
    const doorway = await g.run(builder.fill, { from: [5, 64, 3], to: [5, 65, 3], block: "air" });
    const combined = await g.run(builder.combine, { parts: [wall, doorway] });
    const built = await g.run(builder.build, combined);
    assert.deepEqual(built.failed, []);
    assert.equal(g.blockAt([5, 64, 3]).name, "air");
    assert.equal(g.blockAt([5, 66, 3]).name, "cobblestone");
    assert.equal(g.count("cobblestone"), 64 - 13);
  });

  it("places a block only once something solid touches it: a bridge off a pillar goes in from the pillar out, though its far end is nearest the bot", async () => {
    const g = createHarness({ blocks: [{ name: "stone", at: [3, 66, 0] }], inventory: { cobblestone: 16 }, position: [3.5, 64, 4.5] });
    const bridge = await g.run(builder.line, { from: [3, 66, 1], to: [3, 66, 4], block: "cobblestone" });
    const built = await g.run(builder.build, bridge);
    assert.deepEqual(built, { placed: 4, alreadyCorrect: 0, failed: [] });
  });

  it("reports a floating diagonal line cell by cell: a block with only an edge or corner neighbor has nothing to be placed against", async () => {
    const g = createHarness({ inventory: { cobblestone: 16 }, position: [11.5, 64, 2.5] });
    const floating = await g.run(builder.line, { from: [10, 66, 0], to: [12, 68, 0], block: "cobblestone" });
    const built = await g.run(builder.build, floating);
    assert.equal(built.placed, 0);
    assert.equal(built.failed.length, 3);
    assert.ok(built.failed.every((f) => /nothing solid next to/.test(f.reason)));
  });
});

describe("'air' cells", () => {
  const air = { palette: { a: "air", d: "oak_planks" }, layers: [["ad"]] };

  it("are omitted from materials, whether written 'air' or 'minecraft:air'", () => {
    assert.deepEqual(builder.blueprintMaterials(air), { oak_planks: 1 });
    assert.deepEqual(builder.blueprintMaterials({ palette: { a: "minecraft:air" }, layers: ["aaa"] }), {});
    assert.equal(builder.blueprintBlocks(air).length, 2);
  });

  it("are dug out by build, which counts them placed and needs no material for them", async () => {
    const g = createHarness({ blocks: [{ name: "dirt", from: [3, 64, 0], to: [5, 65, 0] }, { name: "oak_planks", at: [3, 66, 0] }], position: [0.5, 64, 0.5] });
    const clear = await g.run(builder.fill, { from: [3, 64, 0], to: [5, 65, 0], block: "air" });
    assert.deepEqual(await g.run(builder.materials, clear), {});
    const result = await g.run(builder.build, clear);
    assert.deepEqual(result, { placed: 6, alreadyCorrect: 0, failed: [] });
    for (const x of [3, 4, 5]) for (const y of [64, 65]) assert.equal(g.blockAt([x, y, 0]).name, "air");
    assert.equal(g.blockAt([3, 66, 0]).name, "oak_planks", "outside the cells stays");
    // A second build finds everything already clear.
    assert.deepEqual(await g.run(builder.build, clear), { placed: 0, alreadyCorrect: 6, failed: [] });
  });

  it("are dug with the right tool, and a block that needs one the inventory lacks is reported as failed with the tools it needs", async () => {
    const bare = createHarness({ blocks: [{ name: "stone", at: [2, 64, 0] }], position: [0.5, 64, 0.5] });
    const cut = await bare.run(builder.fill, { from: [2, 64, 0], to: [2, 64, 0], block: "air" });
    const failed = await bare.run(builder.build, cut);
    assert.equal(failed.placed, 0);
    assert.match(failed.failed[0]!.reason, /stone needs one of: .*pickaxe/);
    const tooled = createHarness({ blocks: [{ name: "stone", at: [2, 64, 0] }], inventory: { wooden_pickaxe: 1 }, position: [0.5, 64, 0.5] });
    assert.deepEqual(await tooled.run(builder.build, cut), { placed: 1, alreadyCorrect: 0, failed: [] });
    assert.equal(tooled.blockAt([2, 64, 0]).name, "air");
  });

  it("walk within reach of a far cell before digging it", async () => {
    const g = createHarness({ blocks: [{ name: "dirt", at: [20, 64, 0] }], position: [0.5, 64, 0.5] });
    const far = await g.run(builder.fill, { from: [20, 64, 0], to: [20, 64, 0], block: "air" });
    assert.deepEqual(await g.run(builder.build, far), { placed: 1, alreadyCorrect: 0, failed: [] });
    assert.ok(g.position.distanceTo(g.blockAt([20, 64, 0]).position) < 6, "the bot walked up");
  });

  it("clear thin blocks without a collision box, which dig.dig leaves, and report water and unloaded cells by what they are", async () => {
    const g = createHarness({ blocks: [{ name: "short_grass", at: [2, 64, 0] }, { name: "water", at: [3, 64, 0] }], position: [0.5, 64, 0.5] });
    const cut = await g.run(builder.fill, { from: [2, 64, 0], to: [3, 64, 0], block: "air" });
    const result = await g.run(builder.build, cut);
    assert.equal(result.placed, 1);
    assert.equal(g.blockAt([2, 64, 0]).name, "air");
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]!.reason, /water at .* cannot be dug out; place a block there first/);
    assert.equal(result.failed[0]!.block, "air");
  });

  it("are correct in check when the world holds air or cave_air, and nothing else", async () => {
    const g = createHarness({ blocks: [{ name: "cave_air", at: [1, 64, 0] }, { name: "dirt", at: [2, 64, 0] }, { name: "short_grass", at: [3, 64, 0] }, { name: "water", at: [4, 64, 0] }] });
    const cut = await g.run(builder.fill, { from: [0, 64, 0], to: [4, 64, 0], block: "air" });
    const checked = await g.run(builder.check, cut);
    assert.equal(checked.total, 5);
    assert.equal(checked.correct, 2);
    assert.deepEqual(
      checked.mismatches.map((m) => [m.position.x, m.expected, m.actual]),
      [
        [2, "air", "dirt"],
        [3, "air", "short_grass"],
        [4, "air", "water"],
      ],
    );
  });

  /**
   * Sand and gravel that fall as in the game: when the block under one is dug, it and the falling blocks stacked on it turn into
   * falling_block entities at once and land `ticks` later on the first solid block below (checked whenever the run yields).
   * Stop it with the returned function.
   */
  function gravity(g: Harness, ticks: number): () => void {
    const pending: { entity: { id: number }; at: Xyz; block: string; due: number }[] = [];
    g.bot.on("diggingCompleted", (dug) => {
      for (let y = dug.position.y + 1; /^(?:sand|gravel)$/.test(g.blockAt([dug.position.x, y, dug.position.z]).name); y++) {
        const at: Xyz = [dug.position.x, y, dug.position.z];
        const entity = g.spawn({ name: "falling_block", at: [at[0] + 0.5, at[1], at[2] + 0.5] });
        pending.push({ entity, at, block: g.blockAt(at).name, due: g.bot.time.age + ticks });
        g.setBlock(at, "air");
      }
    });
    let timer: NodeJS.Immediate;
    const land = () => {
      const due = pending.filter((p) => p.due <= g.bot.time.age).sort((a, b) => a.at[1] - b.at[1]);
      for (const p of due) {
        pending.splice(pending.indexOf(p), 1);
        let y = p.at[1];
        while (g.blockAt([p.at[0], y - 1, p.at[2]]).boundingBox !== "block") y--;
        g.setBlock([p.at[0], y, p.at[2]], p.block);
        delete (g.bot.entities as Record<number, unknown>)[p.entity.id];
      }
      timer = setImmediate(land);
    };
    timer = setImmediate(land);
    return () => clearImmediate(timer);
  }

  it("stay clear over sand and gravel: a column is dug from the top, and what falls in from above once it lands is dug out again", async () => {
    for (const block of ["gravel", "sand"]) {
      // A 3-high column to clear, two more blocks of it above. They land 2 s after they come loose, long after dig.dig stops watching the cell.
      const g = createHarness({ blocks: [{ name: block, from: [2, 64, 0], to: [2, 68, 0] }], inventory: { wooden_shovel: 1 }, position: [0.5, 64, 0.5] });
      const stop = gravity(g, 40);
      try {
        const column = await g.run(builder.fill, { from: [2, 64, 0], to: [2, 66, 0], block: "air" });
        const built = await g.run(builder.build, column);
        assert.deepEqual(built, { placed: 3, alreadyCorrect: 0, failed: [] }, block);
        g.advance(100);
        await nextTurn();
        assert.deepEqual(await g.run(builder.check, column), { correct: 3, total: 3, mismatches: [] }, block);
        for (const y of [67, 68]) assert.equal(g.blockAt([2, y, 0]).name, "air", `${block} above fell in and was dug out`);
      } finally {
        stop();
      }
    }
  });

  it("that falling blocks keep refilling are reported as failed, naming the block and what to clear; every cell is counted once", async () => {
    const g = createHarness({ blocks: [{ name: "gravel", from: [2, 64, 0], to: [2, 100, 0] }], inventory: { wooden_shovel: 1 }, position: [0.5, 64, 0.5] });
    const stop = gravity(g, 40);
    try {
      const cells = await g.run(builder.fill, { from: [2, 64, 0], to: [2, 65, 0], block: "air" });
      const built = await g.run(builder.build, cells);
      assert.equal(built.placed + built.alreadyCorrect + built.failed.length, 2);
      assert.ok(built.failed.length > 0);
      for (const f of built.failed) {
        assert.equal(f.block, "air");
        assert.match(f.reason, /^gravel kept falling into .* from above; clear the cells above it too/);
      }
    } finally {
      stop();
    }
  });

  /**
   * Lava that spreads as in the game: a dug-out cell among `cells` turns to lava `ticks` after it is both clear and beside lava, the clock's
   * own time even when a sleep passes many ticks at once, so lava runs on along a row (checked whenever the run yields).
   */
  function lavaFlow(g: Harness, cells: Xyz[], ticks: number): () => void {
    const clearedAt = new Map<string, number>();
    const lavaAt = new Map<string, number>();
    g.bot.on("diggingCompleted", (dug) => {
      clearedAt.set(key([dug.position.x, dug.position.y, dug.position.z]), g.bot.time.age);
    });
    let timer: NodeJS.Immediate;
    const spread = () => {
      for (let changed = true; changed; ) {
        changed = false;
        for (const c of cells) {
          const cleared = clearedAt.get(key(c));
          if (cleared === undefined || g.blockAt(c).name !== "air") continue;
          const wet = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
            .map(([dx, dy, dz]) => [c[0] + dx!, c[1] + dy!, c[2] + dz!] as Xyz)
            .filter((n) => g.blockAt(n).name === "lava")
            .map((n) => lavaAt.get(key(n)) ?? -Infinity);
          if (wet.length === 0) continue;
          const due = Math.max(cleared, Math.min(...wet)) + ticks;
          if (g.bot.time.age < due) continue;
          g.setBlock(c, "lava");
          lavaAt.set(key(c), due);
          changed = true;
        }
      }
      timer = setImmediate(spread);
    };
    timer = setImmediate(spread);
    return () => clearImmediate(timer);
  }

  it("that lava flows into after they are dug out are reported as failed, naming the lava and the fix, one cell or a row of them", async () => {
    for (const cells of [[[2, 64, 0]], [[1, 64, 0], [2, 64, 0]]] as Xyz[][]) {
      // Lava spreads one block in 30 ticks, after dig.dig and the falling-block wait are done with the cell.
      const g = createHarness({ blocks: [...cells.map((at) => ({ name: "dirt", at })), { name: "lava", at: [3, 64, 0] }], position: [0.5, 64, 2.5] });
      const stop = lavaFlow(g, cells, 30);
      try {
        const cut = await g.run(builder.fill, { from: cells[0]!, to: cells.at(-1)!, block: "air" });
        const built = await g.run(builder.build, cut);
        assert.equal(built.placed, 0, `${cells.length} cell(s)`);
        assert.equal(built.alreadyCorrect, 0);
        assert.deepEqual(built.failed.map((f) => [f.position.x, f.block]).sort(), cells.map((c) => [c[0], "air"]));
        for (const f of built.failed) assert.match(f.reason, /^lava flowed into .* after it was cleared; place a block there first or clear the lava$/);
        assert.equal((await g.run(builder.check, cut)).correct, 0, "check agrees: the cells hold lava");
      } finally {
        stop();
      }
    }
  });
});

describe("builder.check and builder.build agree on the block placing an item gives", () => {
  it("count a torch cell holding wall_torch, an oak_sign cell holding oak_wall_sign and a bamboo cell holding bamboo_sapling as correct, and another wall form as a mismatch", async () => {
    const g = createHarness({
      blocks: [
        { name: "stone", from: [0, 64, 1], to: [3, 65, 1] },
        { name: "wall_torch", at: [0, 64, 0] },
        { name: "oak_wall_sign", at: [1, 64, 0] },
        { name: "bamboo_sapling", at: [2, 64, 0] },
        { name: "redstone_wall_torch", at: [3, 64, 0] },
      ],
      position: [1.5, 64, -2.5],
    });
    const right = { origin: { x: 0, y: 64, z: 0 }, blueprint: { palette: { t: "torch", s: "oak_sign", b: "bamboo" }, layers: [["tsb"]] } };
    assert.deepEqual(await g.run(builder.check, right), { correct: 3, total: 3, mismatches: [] });
    // build finds them already there and needs no torch, sign or bamboo for them.
    assert.deepEqual(await g.run(builder.build, right), { placed: 0, alreadyCorrect: 3, failed: [] });
    const wrong = await g.run(builder.check, { origin: { x: 3, y: 64, z: 0 }, blueprint: { palette: { t: "torch" }, layers: [["t"]] } });
    assert.deepEqual(wrong.mismatches.map((m) => m.actual), ["redstone_wall_torch"]);
  });
});
