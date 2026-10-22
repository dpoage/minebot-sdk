import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nameMatcher } from "../src/mc/names.ts";
import { blueprintBlocks, blueprintMaterials } from "../src/routines/builder.ts";

describe("blueprints", () => {
  const hut = {
    palette: { "#": "cobblestone", d: "minecraft:oak_door" },
    layers: [
      `
        ###
        #.#
        #d#
      `,
      ["###", "# #", "###"],
    ],
  };

  it("maps characters to offsets: layers to y, rows to z, columns to x, ignoring indentation", () => {
    const blocks = blueprintBlocks(hut);
    assert.equal(blocks.length, 16);
    assert.deepEqual(blocks.find((b) => b.block === "oak_door"), { dx: 1, dy: 0, dz: 2, block: "oak_door" });
    assert.ok(!blocks.some((b) => b.dx === 1 && b.dz === 1));
  });

  it("counts materials", () => {
    assert.deepEqual(blueprintMaterials(hut), { cobblestone: 15, oak_door: 1 });
  });

  it("rejects characters missing from the palette", () => {
    assert.throws(() => blueprintBlocks({ palette: {}, layers: ["x"] }), /character "x" is not in the palette/);
  });
});

describe("nameMatcher", () => {
  it("matches globs and lists, with or without namespace", () => {
    const logs = nameMatcher(["*_log", "minecraft:crafting_table"]);
    assert.ok(logs("minecraft:oak_log"));
    assert.ok(logs("crafting_table"));
    assert.ok(!logs("oak_log_extra"));
    assert.ok(!nameMatcher("a.b")("axb"));
  });
});
