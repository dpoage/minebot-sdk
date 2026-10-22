import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_ROOT } from "../src/package.ts";
import { WIKI_DIR } from "../src/wiki/wiki.ts";

const ROOT = path.join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, string | null | { "minebot-sdk:source": string; types: string; default: string }>;
};

describe("package layout", () => {
  it("publishes an entry for each public specifier, as source, types, and build", () => {
    assert.equal(manifest.private, undefined);
    assert.deepEqual(Object.keys(manifest.exports).sort(), ["./client", "./package.json", "./routine", "./routines/*", "./routines/index", "./testing"]);
    // The catalog is internal: its null entry has to come before the wildcard that would otherwise export it.
    assert.equal(manifest.exports["./routines/index"], null);
    assert.ok(Object.keys(manifest.exports).indexOf("./routines/index") < Object.keys(manifest.exports).indexOf("./routines/*"));
    for (const [key, entry] of Object.entries(manifest.exports)) {
      if (entry === null || typeof entry === "string") continue;
      const stem = entry["minebot-sdk:source"].replace(/^\.\/src\//, "").replace(/\.ts$/, "");
      assert.ok(existsSync(path.join(ROOT, entry["minebot-sdk:source"].replace("*", "move"))), `${key}: ${entry["minebot-sdk:source"]} is missing`);
      assert.deepEqual(entry, { "minebot-sdk:source": `./src/${stem}.ts`, types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` }, key);
      // Conditions match in order: the `minebot-sdk:source` condition has to come before the types it would otherwise lose to.
      assert.deepEqual(Object.keys(entry), ["minebot-sdk:source", "types", "default"], key);
    }
  });

  it("runs the built CLI and ships the assets that the runtime reads", () => {
    assert.equal(manifest.bin.minebot, "dist/cli.js");
    assert.ok(manifest.files.includes("dist") && manifest.files.includes("src/routines") && manifest.files.includes("wiki"));
    assert.deepEqual(manifest.files.filter((file) => file.includes("kit")), []);
    assert.equal(PACKAGE_ROOT, ROOT + path.sep);
    assert.ok(existsSync(path.join(ROOT, "src/routines", "move.ts")));
    assert.ok(existsSync(path.join(WIKI_DIR, "README.md")));
  });
});
