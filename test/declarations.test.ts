import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { initWorkspace } from "../src/client/init.ts";
import { generateEnv } from "../src/protocol/declarations.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";

const EVERYTHING: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: [] };

describe("generateEnv", () => {
  it("is deterministic: regenerating for the same features is a no-op", () => {
    assert.equal(generateEnv(EVERYTHING), generateEnv({ ...EVERYTHING }));
  });

  it("declares only the globals the body offers, and none of the kits", () => {
    const bare: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };
    const env = generateEnv(bare);
    assert.doesNotMatch(env, /const wiki\b|const triggers\b|addLesson|milestones/);
    assert.doesNotMatch(generateEnv(EVERYTHING), /const triggers\b/, "the triggers global is gone on a body that offers everything");
    assert.match(env, /const bot:/);
    assert.match(env, /const notes:/);
    for (const features of [bare, EVERYTHING]) assert.doesNotMatch(generateEnv(features), /Registry|const kits?\b|minebot-sdk\/kit/);
    const readOnlyWiki = generateEnv({ ...EVERYTHING, wiki: "read", lessons: false });
    assert.match(readOnlyWiki, /const wiki:/);
    assert.doesNotMatch(readOnlyWiki, /addLesson/);
  });

  it("types the bot and the pathfinder values from the package's routine entry point", () => {
    const env = generateEnv(EVERYTHING);
    assert.match(env, /const bot: import\("minebot-sdk\/routine"\)\.Bot;/);
    assert.match(env, /const goals: typeof import\("minebot-sdk\/routine"\)\.goals;/);
  });
});

describe("initWorkspace", () => {
  it("scaffolds the workspace and never overwrites an existing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "minebot-init-"));
    try {
      const written = await initWorkspace(dir);
      for (const file of [".gitignore", "README.md", "kits/hello.ts", "package.json", "programs/hello.ts", "tsconfig.json"]) assert.ok(written.includes(file), file);
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      assert.ok(pkg.dependencies["minebot-sdk"]);
      assert.ok(pkg.devDependencies.typescript);
      assert.deepEqual(await initWorkspace(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
