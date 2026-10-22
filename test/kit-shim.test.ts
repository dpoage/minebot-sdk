// src/kit/ is what the kit framework left: one data module, `BUILTIN_KITS`, for the benchmark's task generator
// (bench/gen-tasks.ts reads `.name` and `.uses`). It is derived from the built-in routine catalog, and equals what the kits listed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as shim from "../src/kit/index.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";

/** The names and `uses` of the 18 built-in kits at 5218f99, from the table frozen for builtin-catalog.test.ts. */
const BASE = (JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "catalog", "base-5218f99.json"), "utf8")) as { name: string; uses: string[] }[]).map(({ name, uses }) => ({ name, uses }));

describe("src/kit, the data module the benchmark reads", () => {
  it("holds only index.ts, which exports only BUILTIN_KITS", () => {
    assert.deepEqual(readdirSync(path.join(import.meta.dirname, "..", "src", "kit")), ["index.ts"]);
    assert.deepEqual(Object.keys(shim), ["BUILTIN_KITS"]);
  });

  it("lists the names and uses the 18 kits had, in their order", () => {
    assert.equal(BASE.length, 18);
    assert.deepEqual(shim.BUILTIN_KITS.map(({ name, uses }) => ({ name, uses: [...uses] })), BASE);
    // Nothing else: the generator reads two fields, and an entry has no more.
    for (const entry of shim.BUILTIN_KITS) assert.deepEqual(Object.keys(entry).sort(), ["name", "uses"]);
  });

  it("is derived from the routine catalog, entry for entry", () => {
    assert.equal(shim.BUILTIN_KITS.length, BUILTIN_MODULES.length);
    shim.BUILTIN_KITS.forEach((entry, i) => {
      assert.equal(entry.name, BUILTIN_MODULES[i]!.name);
      assert.equal(entry.uses, BUILTIN_MODULES[i]!.uses, "the entry's uses are the module's own list");
    });
  });
});
