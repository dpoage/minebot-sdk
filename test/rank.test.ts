import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countTokens, rankFields } from "../src/rank.ts";

const doc = (id: string, ...tokens: string[]) => ({ id, fields: [{ weight: 1, counts: countTokens(tokens) }] });
const weighted = (id: string, ...fields: [number, string[]][]) => ({ id, fields: fields.map(([weight, tokens]) => ({ weight, counts: countTokens(tokens) })) });
const ids = (documents: ReturnType<typeof doc>[], terms: string[]) => rankFields(documents, terms).map((r) => r.document.id);

describe("rankFields fuzzy matching", () => {
  const docs = [doc("furnace", "furnace", "smelt", "ore"), doc("crafting", "crafting", "table"), doc("other", "boat", "river")];

  it("tolerates a typo", () => {
    assert.deepEqual(ids(docs, ["furnce"]), ["furnace"]);
    assert.deepEqual(ids(docs, ["fruance"]), ["furnace"]);
  });

  it("matches prefixes both ways", () => {
    assert.deepEqual(ids(docs, ["craf"]), ["crafting"]);
    assert.deepEqual(ids(docs, ["smelting"]), ["furnace"]);
  });

  it("ranks every exact match above every fuzzy-only match", () => {
    const ranked = [doc("fuzzy", "furnce"), doc("exact", "furnace"), doc("filler", "boat")];
    assert.deepEqual(ids(ranked, ["furnace"]), ["exact", "fuzzy"]);
    // Repeated fuzzy tokens in a heavy field do not lift a document above one exact token in a light field.
    const flooded = [weighted("prefixes", [4, ["crafting", "crafting", "crafting", "crafted"]]), weighted("exact", [1, ["craft"]])];
    assert.deepEqual(ids(flooded, ["craft"]), ["exact", "prefixes"]);
  });

  it("keeps the exact ranking when fuzzy matches exist", () => {
    const documents = [doc("two", "mine", "mine"), doc("one", "mine", "stone"), doc("near", "mined", "mineflayer", "mines")];
    assert.deepEqual(ids(documents, ["mine"]), ["two", "one", "near"]);
  });

  it("lets a fuzzy match add to an exact match of another term", () => {
    const documents = [doc("iron", "iron", "ingot"), doc("iron-pick", "iron", "pickaxe")];
    assert.deepEqual(ids(documents, ["iron", "pikaxe"]), ["iron-pick", "iron"]);
  });

  it("gives a short word no typo budget", () => {
    // "sand" is one edit from "and", but a three-letter word cannot carry a typo.
    assert.deepEqual(ids([doc("filler", "and", "the"), doc("sand", "sand")], ["sand"]), ["sand"]);
    assert.deepEqual(ids([doc("boat", "bot")], ["boat"]), []);
  });

  it("does not fuzzy-match short terms", () => {
    assert.deepEqual(ids([doc("a", "ore"), doc("b", "orb")], ["or"]), []);
    assert.deepEqual(ids([doc("a", "ore")], ["oro"]), []);
  });
});
