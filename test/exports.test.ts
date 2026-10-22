// The runtime export sets of the three public entry points that carry values are closed: each equals the
// list committed in fixtures/package-exports.json, so a name added or dropped changes that file too.
// The published layout is checked by dist-routine.test.ts against the same file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as client from "minebot-sdk/client";
import * as routine from "minebot-sdk/routine";
import * as testing from "minebot-sdk/testing";

const COMMITTED = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "package-exports.json"), "utf8")) as Record<"client" | "testing" | "routine", string[]>;

describe("the runtime exports of the public entry points", () => {
  it("minebot-sdk/client exports exactly the committed names", () => {
    assert.deepEqual(Object.keys(client).sort(), COMMITTED.client);
  });

  it("minebot-sdk/testing exports createHarness and UnsupportedApiError and nothing else", () => {
    assert.deepEqual(Object.keys(testing).sort(), COMMITTED.testing);
    assert.deepEqual(COMMITTED.testing, ["UnsupportedApiError", "createHarness"]);
  });

  it("minebot-sdk/routine exports exactly the committed names", () => {
    assert.deepEqual(Object.keys(routine).sort(), COMMITTED.routine);
  });

  it("no entry point exports a kit name", () => {
    for (const names of Object.values(COMMITTED)) assert.deepEqual(names.filter((name) => /kit/i.test(name)), []);
  });

  it("minebot-sdk/kit is not an entry point", async () => {
    // The specifier is a variable: the compiler would reject a literal one, and the loader's refusal is what is under test.
    const specifier = "minebot-sdk/kit";
    await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
});
