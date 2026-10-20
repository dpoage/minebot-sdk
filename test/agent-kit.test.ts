import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeFile, unlink } from "node:fs/promises";
import { findEscapeAttempts } from "../src/audit.ts";
import { compileKit, KitSourceError } from "../src/kit/agent.ts";
import { BUILTIN_KIT_DIR, BUILTIN_KITS } from "../src/kit/index.ts";
import { KitLibrary } from "../src/kit/library.ts";
import { KitHost, type KitCalls } from "../src/kit/kit.ts";
import { KitStats } from "../src/kit/stats.ts";
import { JsonStore } from "../src/store.ts";

const IMPORTS = 'import { defineKit, action, z } from "minebot-sdk/kit";\n';

const GOOD_SOURCE = `${IMPORTS}
// A kit an agent might save: dig from above, then walk home.
export default defineKit(
  { name: "woodcutter", description: "Chops a tree by digging its log blocks and walking back.", uses: ["move", "dig"] },
  {
    chop: action({
      doc: "Digs the block at the bot's head height and returns where it stands.",
      args: z.object({ times: z.number().int().positive().default(1) }),
      run: async (ctx, { times }) => {
        for (let i = 0; i < times; i++) {
          const p = ctx.bot.entity.position.offset(0, 1, 0);
          await ctx.kits.dig.dig({ at: { x: p.x, y: p.y, z: p.z } });
        }
        return ctx.kits.move.to({ position: [0, 64, 0] });
      },
    }),
  },
);
`;

function library(dir: string, problems: { file: string; error: string }[] = []): KitLibrary {
  return new KitLibrary({ dir, onProblem: (file, error) => problems.push({ file, error }) });
}

function hostOver(lib: KitLibrary, dir: string): KitHost {
  const cache = new Map<string, JsonStore>();
  return new KitHost({
    kits: lib.list(),
    stores: (kit) => {
      let store = cache.get(kit);
      if (!store) {
        store = new JsonStore(path.join(dir, "stores", `${kit}.json`));
        cache.set(kit, store);
      }
      return store;
    },
    agent: (name) => lib.isAgent(name),
  });
}

describe("compileKit", () => {
  it("compiles a well-formed kit, types included", () => {
    const kit = compileKit(GOOD_SOURCE);
    assert.equal(kit.name, "woodcutter");
    assert.deepEqual(kit.uses, ["move", "dig"]);
    assert.deepEqual(Object.keys(kit.actions), ["chop"]);
  });

  it("binds named imports from minebot-sdk/kit, aliases and type imports included", () => {
    const kit = compileKit(
      `import { defineKit as define, action, z, nameMatcher } from "minebot-sdk/kit";\nimport type { Vec3 } from "vec3";\nimport { type Block, Point } from "minebot-sdk/kit";\n` +
        `const matches = nameMatcher("*_log");\nexport default define({ name: "tagged", description: "x" }, { a: action({ doc: "d", args: z.object({}), returns: Point, run: () => ({ x: matches("oak_log") ? 1 : 0, y: 0, z: 0 }) }) });`,
    );
    assert.deepEqual(Object.keys(kit.actions), ["a"]);
  });

  it("rejects every other import, naming the one allowed", () => {
    const help = /import \{ defineKit, action, z \} from "minebot-sdk\/kit"/;
    assert.throws(() => compileKit(`import { z } from "zod";\n${IMPORTS}export default defineKit({ name: "a", description: "x" }, {});`), /cannot import "zod"/);
    assert.throws(() => compileKit(`import { readFileSync } from "node:fs";\n${IMPORTS}export default defineKit({ name: "a", description: "x" }, {});`), /cannot import "node:fs"/);
    assert.throws(() => compileKit(`import fs from "node:fs";\n${IMPORTS}export default defineKit({ name: "a", description: "x" }, {});`), help);
    assert.throws(() => compileKit(`import * as sdk from "minebot-sdk/kit";\n${IMPORTS}export default defineKit({ name: "a", description: "x" }, {});`), help);
    assert.throws(() => compileKit(`import "node:fs";\n${IMPORTS}export default defineKit({ name: "a", description: "x" }, {});`), help);
    assert.throws(() => compileKit(`${IMPORTS}const fs = require("fs");\nexport default defineKit({ name: "a", description: "x" }, {});`), /dynamic import\(\), import\.meta, or require\(\)/);
    assert.throws(() => compileKit(`${IMPORTS}const fs = await import("node:fs");\nexport default defineKit({ name: "a", description: "x" }, {});`), /dynamic import\(\), import\.meta, or require\(\)/);
    assert.throws(() => compileKit(`import { defineKit, bogus } from "minebot-sdk/kit";\nexport default defineKit({ name: "a", description: "x" }, {});`), /has no export "bogus"/);
  });

  it("rejects the globals form, naming the import line to add", () => {
    const globals = `export default defineKit({ name: "a", description: "x" }, { a: action({ doc: "d", args: z.object({}), run: () => 1 }) });`;
    assert.throws(() => compileKit(globals), /import \{ defineKit, action, z \} from "minebot-sdk\/kit"/);
    assert.throws(() => compileKit(`import { defineKit } from "minebot-sdk/kit";\n${globals}`), /action is not defined; import it: import \{ action \} from "minebot-sdk\/kit"/);
    assert.throws(
      () => compileKit(`${IMPORTS}export default defineKit({ name: "a", description: "x", actions: {} });`),
      /needs an actions object as the second argument: defineKit\(\{ name, description, uses \}, \{ actionName: action\(\{ \.\.\. \}\) \}\)/,
    );
  });

  it("rejects syntax errors, missing or extra default exports, and bad shapes", () => {
    assert.throws(() => compileKit("export default defineKit({"), KitSourceError);
    assert.throws(() => compileKit(`${IMPORTS}const x = 1;`), /export exactly one kit/);
    assert.throws(
      () =>
        compileKit(
          "import { defineKit } from \"minebot-sdk/kit\";\nexport default defineKit({ name: 'a', description: 'x' }, {});\nexport default defineKit({ name: 'b', description: 'x' }, {});",
        ),
      /export exactly one kit/,
    );
    assert.throws(() => compileKit(`export default { name: "a" };`), KitSourceError);
    assert.throws(() => compileKit(`${IMPORTS}export default { name: "a" };`), /export exactly one kit/);
    assert.throws(() => compileKit(`${IMPORTS}export default defineKit({ name: "Bad", description: "x" }, {});`), /kit name "Bad"/);
  });

  it("accepts the built-in shape: one exported kit, other exports ignored", () => {
    const named = compileKit(`${IMPORTS}export const helper = 1;\nexport async function walk() {}\nexport const mine = defineKit({ name: "mine", description: "x" }, {});`);
    assert.equal(named.name, "mine");
    const mixed = compileKit(`${IMPORTS}export const helper = 1;\nexport default defineKit({ name: "a", description: "x" }, {});`);
    assert.equal(mixed.name, "a");
    const twoKits = `${IMPORTS}export const a = defineKit({ name: "a", description: "x" }, {});\nexport const b = defineKit({ name: "b", description: "x" }, {});`;
    assert.throws(() => compileKit(twoKits), /exports 2 kits \(a, b\)/);
    assert.throws(() => compileKit(`${IMPORTS}export const n = 1;`), /export exactly one kit/);
    assert.throws(() => compileKit(`${IMPORTS}export { defineKit };\nexport default defineKit({ name: "a", description: "x" }, {});`), /export exactly one kit/);
  });

  it("compiles the source of every built-in kit, submitted verbatim under a new name", () => {
    const files = readdirSync(BUILTIN_KIT_DIR).filter((f) => f.endsWith(".ts"));
    assert.equal(files.length, BUILTIN_KITS.length);
    for (const file of files) {
      const source = readFileSync(path.join(BUILTIN_KIT_DIR, file), "utf8");
      const renamed = source.replace(/(defineKit\(\s*\{\s*name: )"[a-z_]+"/, '$1"copy"');
      assert.notEqual(renamed, source, `${file}: kit name not found`);
      assert.equal(compileKit(renamed).name, "copy", file);
      assert.deepEqual(findEscapeAttempts(renamed), [], file);
    }
  });

  it("rejects a dynamic import however it is spelled, and import.meta", () => {
    const kit = (body: string) => `${IMPORTS}${body}\nexport default defineKit({ name: "a", description: "x" }, {});`;
    for (const spelling of ['import/**/("node:os")', 'import//x\n("node:os")', 'import /* a */ // b\n ("node:os")', 'import ("node:os")', "import.meta.url"]) {
      assert.throws(() => compileKit(kit(`const loaded = ${spelling};`)), /dynamic import\(\), import\.meta, or require\(\)/, spelling);
    }
    assert.throws(() => compileKit(kit('const r = require/**/("fs");')), /dynamic import\(\), import\.meta, or require\(\)/);
    assert.throws(() => compileKit(`import/**/{ defineKit } from "minebot-sdk/kit";\nexport default defineKit({ name: "a", description: "x" }, {});`), /cannot import/);
  });

  it("leaves the words import, require, and export alone inside strings, comments, and templates", () => {
    const kit = compileKit(
      `${IMPORTS}// import("node:os") require("fs") export default\n/* import("node:os") */\n` +
        'const text = "import(x) require(y) export default" + `import(${1 + 1}) ${"export"}`;\nconst pattern = /import\\("x"\\)/;\n' +
        `export default defineKit({ name: "words", description: text.length > 0 && pattern ? "mentions import and require" : "x" }, {});`,
    );
    assert.equal(kit.name, "words");
  });

  it("blocks import() at run time even when the source scan is fooled", async () => {
    // After `if (1)` a slash starts a regex, which the scan reads as division; the quote then hides the import() from it.
    const kit = compileKit(
      `${IMPORTS}export default defineKit({ name: "sneaky", description: "x" }, { a: action({ doc: "d", args: z.object({}), run: async () => { if (1)\n/"/.test("x"); return await import("node:os"); } }) });`,
    );
    await assert.rejects(async () => kit.actions.a!.invoke({} as never, {}, "sneaky.a"), /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING|dynamic import callback/i);
  });
});

/** Waits past the directory-mtime granularity the library refresh relies on. */
const bump = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("KitLibrary", () => {
  it("saves a valid kit, loads it on the next construction, and reports what it wrote", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    const kit = await lib.save(GOOD_SOURCE, () => true);
    assert.equal(kit.name, "woodcutter");
    assert.deepEqual(kitFiles(dir), ["woodcutter.ts"]);
    assert.equal(new KitLibrary({ dir }).isAgent("woodcutter"), true);
    assert.match(lib.source("woodcutter")!, /export default defineKit/);
    assert.equal(lib.source("move")!.length > 100, true);
  });

  it("writes nothing when the source is rejected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    const rejects: [string, RegExp][] = [
      [IMPORTS + "export default defineKit({ name: \"bad\", description: \"x\" }, ", /not valid TypeScript|failed to run/], // syntax error
      [`import x from "y";\n${IMPORTS}export default defineKit({ name: "b", description: "x" }, {});`, /cannot import "y"/],
      [`${IMPORTS}export default defineKit({ name: "move", description: "steal" }, {});`, /taken by a built-in/],
      [`${IMPORTS}export default defineKit({ name: "lonely", description: "x", uses: ["nothere"] }, {});`, /does not offer/],
      [`${IMPORTS}export default defineKit({ name: "selfish", description: "x", uses: ["selfish"] }, {});`, /cannot use itself/],
      [`${IMPORTS}export default defineKit({ name: "sneaky", description: "x" }, { a: action({ doc: "d", args: z.object({}), run: () => globalThis.constructor.constructor("return process")() }) });`, /escape audit/],
    ];
    const offered = (name: string) => name === "move" || name === "dig";
    for (const [source, pattern] of rejects) {
      await assert.rejects(() => lib.save(source, offered), pattern);
    }
    assert.deepEqual(readdirSync(dir), []);
  });

  it("replaces a saved kit with the same name and removes it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    const replaced = await lib.save(
      GOOD_SOURCE.replace("Chops a tree", "Chops many trees").replace(/name: "woodcutter"/, 'name: "woodcutter"'),
      () => true,
    );
    assert.match(replaced.description, /many trees/);
    assert.deepEqual(kitFiles(dir), ["woodcutter.ts"]);
    await lib.remove("woodcutter");
    assert.deepEqual(kitFiles(dir), []);
    await assert.rejects(() => lib.remove("move"), /built-in/);
    await assert.rejects(() => lib.remove("woodcutter"), /no agent kit/);
  });

  it("skips a bad file on disk and reports it, without failing the rest", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const problems: { file: string; error: string }[] = [];
    const lib = library(dir, problems);
    await lib.save(GOOD_SOURCE, () => true);
    await bump();
    await writeFile(path.join(dir, "broken.ts"), "this is not ( valid typescript ]]");
    await writeFile(path.join(dir, "mismatch.ts"), GOOD_SOURCE);
    const agentKits = lib.agentKits();
    assert.deepEqual([...agentKits.keys()], ["woodcutter"]);
    const files = problems.map((p) => p.file).sort();
    assert.deepEqual(files, ["broken.ts", "mismatch.ts"]);
  });

  it("drops kits whose uses vanished, and kits that form a cycle", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const problems: { file: string; error: string }[] = [];
    const lib = library(dir, problems);
    const writes = (name: string, uses: readonly string[]) =>
      `${IMPORTS}export default defineKit({ name: "${name}", description: "chain", uses: [${uses.map((u) => `"${u}"`).join(", ")}] }, {});`;
    await writeFile(path.join(dir, "aaa.ts"), writes("aaa", ["bbb", "move"]));
    await writeFile(path.join(dir, "bbb.ts"), writes("bbb", ["move"]));
    await bump();
    assert.deepEqual([...lib.agentKits().keys()].sort(), ["aaa", "bbb"]);
    // Break the chain: bbb disappears, so aaa is dropped too.
    await unlink(path.join(dir, "bbb.ts"));
    await bump();
    assert.deepEqual([...lib.agentKits().keys()], []);
    assert.ok(problems.some((p) => p.file === "aaa.ts" && /uses "bbb"/.test(p.error)));
    problems.length = 0;
    // A cycle: both compile, both resolve against each other, and both are dropped.
    await writeFile(path.join(dir, "ccc.ts"), writes("ccc", ["ddd"]));
    await writeFile(path.join(dir, "ddd.ts"), writes("ddd", ["ccc"]));
    await bump();
    assert.deepEqual([...lib.agentKits().keys()], []);
    assert.ok(problems.some((p) => /cycle/.test(p.error)));
  });

  it("shares a directory: a kit saved through one library appears in another", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const a = library(dir);
    const b = library(dir);
    await a.save(GOOD_SOURCE, () => true);
    await bump();
    assert.equal(b.isAgent("woodcutter"), true);
    assert.equal(b.source("woodcutter")!.length > 0, true);
  });
});

describe("agent kits in a host", () => {
  it("join the host active, and validate their arguments like any other kit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    const host = hostOver(lib, dir);
    assert.ok(host.active.includes("woodcutter"));
    const fakeBot = {
      entity: { position: { x: 1, y: 64, z: 2, offset: (dx: number, dy: number, dz: number) => ({ x: 1 + dx, y: 64 + dy, z: 2 + dz }) } },
    } as unknown as Parameters<KitHost["api"]>[1];
    const scope = {
      log: () => {},
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
      on: () => {},
    };
    const kit = host.api(scope, fakeBot);
    // Validation rejects before the bot is touched, so a fake bot is enough to prove the call path.
    assert.throws(() => kit.woodcutter!.chop!({ times: "many" }), /kit\.woodcutter\.chop arguments/);
  });

  it("fail a call whose result violates the declared returns, naming the action", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(
      `${IMPORTS}export default defineKit({ name: "liar", description: "returns the wrong shape" }, {\n` +
        `  honest: action({ doc: "d", args: z.object({}), returns: z.object({ n: z.number() }), run: () => ({ n: 1 }) }),\n` +
        `  lies: action({ doc: "d", args: z.object({}), returns: z.object({ n: z.number() }), run: async () => ({ n: "one" } as unknown as { n: number }) }),\n` +
        `});`,
      () => true,
    );
    const host = hostOver(lib, dir);
    const kit = host.api({ log: () => {}, sleep: () => Promise.resolve(), signal: new AbortController().signal, on: () => {} }, {} as Parameters<KitHost["api"]>[1]);
    assert.deepEqual(kit.liar!.honest!({}), { n: 1 });
    await assert.rejects(async () => kit.liar!.lies!({}), /kit\.liar\.lies returned a value that does not match its returns schema[\s\S]*returns: \{ n: number \}/);
  });

  it("save against the daemon's resolvable predicate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    const offered = new Set(["move", "dig", "sense"]);
    await assert.rejects(
      () => lib.save(`${IMPORTS}export default defineKit({ name: "far", description: "x", uses: ["craft"] }, {});`, (name) => offered.has(name)),
      /uses "craft", which this body does not offer/,
    );
    const kit = await lib.save(`${IMPORTS}export default defineKit({ name: "near", description: "x", uses: ["move"] }, {});`, (name) => offered.has(name));
    assert.equal(kit.name, "near");
  });

  it("compile through KitLibrary with agent kits resolvable against each other", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    const second = await lib.save(
      `${IMPORTS}export default defineKit({ name: "haul", description: "x", uses: ["woodcutter", "move"] }, {});`,
      (name) => name === "woodcutter" || name === "move",
    );
    assert.equal(second.name, "haul");
  });
});

/** The saved kits in a directory: the history lives beside them in a dot directory. */
function kitFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith(".ts"));
}

const SECOND_SOURCE = GOOD_SOURCE.replace("Chops a tree", "Chops two trees");
const THIRD_SOURCE = GOOD_SOURCE.replace("Chops a tree", "Chops three trees");

describe("kit check", () => {
  it("validates like a save and writes nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    assert.equal(lib.check(GOOD_SOURCE, () => true).name, "woodcutter");
    assert.throws(() => lib.check(GOOD_SOURCE, () => false), /does not offer/);
    assert.throws(() => lib.check(`${IMPORTS}export default defineKit({ name: "move", description: "x" }, {});`, () => true), /taken by a built-in/);
    assert.throws(() => lib.check(`${IMPORTS}export default defineKit({ name: "a", description: "x" }, { b: action({ doc: "d", args: z.object({}), run: () => process.exit() }) });`, () => true), /escape audit/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe("kit versions", () => {
  it("keeps every saved source, lists them, and restores one as a new version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = new KitLibrary({ dir, savedBy: "ana" });
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(SECOND_SOURCE, () => true);
    const versions = await lib.versions("woodcutter");
    assert.deepEqual(
      versions.map((v) => [v.version, v.current, v.savedBy]),
      [
        [1, false, "ana"],
        [2, true, "ana"],
      ],
    );
    assert.match(versions[0]!.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(readFileSync(path.join(dir, ".history", "woodcutter", "1.ts"), "utf8"), GOOD_SOURCE);
    assert.match(lib.source("woodcutter")!, /two trees/);

    const restored = await lib.revert("woodcutter", 1, () => true);
    assert.match(restored.description, /a tree/);
    assert.equal(lib.source("woodcutter"), GOOD_SOURCE);
    const after = await lib.versions("woodcutter");
    assert.deepEqual(
      after.map((v) => [v.version, v.current, v.revertedFrom]),
      [
        [1, false, undefined],
        [2, false, undefined],
        [3, true, 1],
      ],
    );
    assert.deepEqual(kitFiles(dir), ["woodcutter.ts"]);
  });

  it("does not add a version for the source that is already saved", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(GOOD_SOURCE, () => true);
    assert.equal((await lib.versions("woodcutter")).length, 1);
  });

  it("makes a file written by hand the first version before saving over it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    await writeFile(path.join(dir, "woodcutter.ts"), GOOD_SOURCE);
    const lib = library(dir);
    await lib.save(SECOND_SOURCE, () => true);
    const versions = await lib.versions("woodcutter");
    assert.deepEqual(
      versions.map((v) => [v.version, v.savedBy, v.current]),
      [
        [1, "unknown", false],
        [2, "unknown", true],
      ],
    );
    await lib.revert("woodcutter", 1, () => true);
    assert.equal(lib.source("woodcutter"), GOOD_SOURCE);
  });

  it("validates a revert like a save, and rejects unknown versions and names", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(SECOND_SOURCE, () => true);
    await assert.rejects(() => lib.revert("woodcutter", 9, () => true), /no version 9; saved versions: 1, 2/);
    // The version's `uses` no longer resolve on this body.
    await assert.rejects(() => lib.revert("woodcutter", 1, () => false), /does not offer/);
    assert.match(lib.source("woodcutter")!, /two trees/);
    await assert.rejects(() => lib.versions("../etc"), /not a kit name/);
    await assert.rejects(() => lib.versions("nothing"), /no saved versions/);
  });

  it("keeps the history of a removed kit, so it can come back", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(GOOD_SOURCE, () => true);
    await lib.remove("woodcutter");
    assert.deepEqual((await lib.versions("woodcutter")).map((v) => v.current), [false]);
    await lib.revert("woodcutter", 1, () => true);
    assert.equal(lib.isAgent("woodcutter"), true);
    assert.deepEqual((await lib.versions("woodcutter")).map((v) => [v.version, v.current]), [[1, true]]);
  });

  it("numbers versions across libraries that share a directory, and tells which body saved each", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const ana = new KitLibrary({ dir, savedBy: "ana" });
    const bo = new KitLibrary({ dir, savedBy: "bo" });
    await ana.save(GOOD_SOURCE, () => true);
    await bo.save(SECOND_SOURCE, () => true);
    await ana.save(THIRD_SOURCE, () => true);
    assert.deepEqual((await bo.versions("woodcutter")).map((v) => [v.version, v.savedBy]), [
      [1, "ana"],
      [2, "bo"],
      [3, "ana"],
    ]);
  });

  it("never loads the history as kits", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const problems: { file: string; error: string }[] = [];
    const lib = library(dir, problems);
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(SECOND_SOURCE, () => true);
    assert.deepEqual([...lib.agentKits().keys()], ["woodcutter"]);
    assert.deepEqual(problems, []);
  });

  it("reports a changed source, and a removal, to onChange", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const changed: string[] = [];
    const lib = new KitLibrary({ dir, onChange: (kit) => changed.push(kit) });
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(GOOD_SOURCE, () => true);
    await lib.save(SECOND_SOURCE, () => true);
    await lib.remove("woodcutter");
    assert.deepEqual(changed, ["woodcutter", "woodcutter", "woodcutter"]);
  });
});

const COUNTER_SOURCE = `${IMPORTS}
export default defineKit(
  { name: "counter", description: "Counts how it is called and fails on demand." },
  {
    ok: action({ doc: "Returns 1.", args: z.object({}), run: () => 1 }),
    later: action({ doc: "Returns 2 after a tick.", args: z.object({}), run: async () => 2 }),
    fail: action({ doc: "Throws.", args: z.object({ why: z.string().default("because") }), run: (_ctx, { why }) => { throw new Error(why + "\\nsecond line"); } }),
    failLater: action({ doc: "Rejects.", args: z.object({}), run: async () => { throw new Error("late"); } }),
    remember: action({ doc: "Stores a value in the kit's store and returns the store's keys.", args: z.object({}), run: (ctx) => { ctx.store.set("seen", true); return ctx.store.keys(); } }),
  },
);
`;

const fakeScope = { log: () => {}, sleep: () => Promise.resolve(), signal: new AbortController().signal, on: () => {} };
const fakeBot = {} as unknown as Parameters<KitHost["api"]>[1];

describe("kit statistics", () => {
  async function counterHost(dir: string, stats: KitStats): Promise<{ host: KitHost; kit: KitCalls }> {
    const lib = library(dir);
    await lib.save(COUNTER_SOURCE, () => true);
    const host = new KitHost({ kits: lib.list(), stores: (name) => new JsonStore(path.join(dir, "stores", `${name}.json`)), stats });
    return { host, kit: host.api(fakeScope, fakeBot) };
  }

  it("counts successes and failures of sync and async actions, and keeps the last error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    const { host, kit } = await counterHost(dir, stats);
    const counter = kit.counter!;
    counter.ok!({});
    counter.ok!({});
    assert.equal(await counter.later!({}), 2);
    assert.throws(() => counter.fail!({ why: "no" }), /no/);
    await assert.rejects(async () => counter.failLater!({}), /late/);
    assert.throws(() => counter.fail!({ why: 5 }), /arguments/);
    const info = host.info().find((k) => k.name === "counter")!;
    assert.deepEqual(info.stats.ok, { ok: 2, failed: 0 });
    assert.deepEqual(info.stats.later, { ok: 1, failed: 0 });
    assert.equal(info.stats.fail!.failed, 2);
    assert.match(info.stats.fail!.lastError!, /arguments/);
    assert.deepEqual(info.stats.failLater, { ok: 0, failed: 1, lastError: "late" });
    assert.equal("remember" in info.stats, false);
    assert.deepEqual(host.info().find((k) => k.name === "move")!.stats, {});
  });

  it("does not count a call to a kit that is not active", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    const lib = library(dir);
    await lib.save(COUNTER_SOURCE, () => true);
    const host = new KitHost({ kits: lib.list(), stores: () => JsonStore.memory(), stats, active: ["move"] });
    assert.throws(() => host.api(fakeScope, fakeBot).counter!.ok!({}), /not active/);
    assert.deepEqual(stats.forKit("counter"), {});
  });

  it("survives a restart through the store, and a reset forgets a kit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const file = path.join(dir, "kit-stats.json");
    const stats = new KitStats(new JsonStore(file));
    const { kit } = await counterHost(dir, stats);
    kit.counter!.ok!({});
    assert.throws(() => kit.counter!.fail!({}), /because/);
    stats.flush();
    const reloaded = new KitStats(new JsonStore(file));
    assert.deepEqual(reloaded.forKit("counter").ok, { ok: 1, failed: 0 });
    assert.equal(reloaded.forKit("counter").fail!.lastError, "because\nsecond line");
    reloaded.reset("counter");
    assert.deepEqual(new KitStats(new JsonStore(file)).forKit("counter"), {});
  });
});

describe("kit try", () => {
  it("runs one action of unsaved source and leaves no trace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    await lib.save(COUNTER_SOURCE.replace("Counts how", "Saved: counts how"), () => true);
    const host = new KitHost({ kits: lib.list(), stores: (name) => new JsonStore(path.join(dir, "stores", `${name}.json`)), stats });
    const before = readdirSync(dir).sort();

    const kit = lib.check(COUNTER_SOURCE, () => true);
    assert.deepEqual(await host.tryKit(kit, "remember", {}, fakeScope, fakeBot), ["seen"]);
    // A second run starts from an empty store: the first wrote to memory, not to the saved kit's store.
    assert.deepEqual(await host.tryKit(kit, "remember", {}, fakeScope, fakeBot), ["seen"]);
    assert.equal(existsSync(path.join(dir, "stores", "counter.json")), false);
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.match(host.offeredKit("counter")!.description, /^Saved/);
    assert.deepEqual(stats.forKit("counter"), {});
  });

  it("returns an action's error, validates arguments, and names the actions when one is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    const host = new KitHost({ kits: lib.list(), stores: () => JsonStore.memory() });
    const kit = lib.check(COUNTER_SOURCE, () => true);
    assert.equal(await host.tryKit(kit, "later", {}, fakeScope, fakeBot), 2);
    await assert.rejects(async () => host.tryKit(kit, "failLater", {}, fakeScope, fakeBot), /late/);
    assert.throws(() => host.tryKit(kit, "fail", { why: 1 }, fakeScope, fakeBot), /kit\.counter\.fail arguments/);
    assert.throws(() => host.tryKit(kit, "nope", {}, fakeScope, fakeBot), /no action "nope"; it has: ok, later, fail, failLater, remember/);
    assert.throws(() => host.tryKit(kit, "toString", {}, fakeScope, fakeBot), /no action "toString"/);
  });
});

describe("kit search", () => {
  function builtinHost(): KitHost {
    return new KitHost({ kits: new KitLibrary({}).list(), stores: () => JsonStore.memory() });
  }

  it("finds the kit and the actions that match what the query says", () => {
    const hits = builtinHost().search("collect logs", 5);
    assert.ok(hits.some((hit) => hit.kit === "gatherer" && hit.action === undefined));
    assert.ok(hits.some((hit) => hit.kit === "gatherer" && hit.action === "gather"));
    assert.equal(hits[0]!.kit, "gatherer");
    assert.ok(hits.every((hit, i) => i === 0 || hits[i - 1]!.score >= hit.score));
  });

  it("matches camelCase action names, plurals, and kit names, and limits the hits", () => {
    const host = builtinHost();
    assert.equal(host.search("collect drops", 1)[0]!.action, "collectDrops");
    assert.equal(host.search("waypoints", 1)[0]!.action, "waypoints");
    assert.equal(host.search("crafter", 1)[0]!.kit, "crafter");
    assert.equal(host.search("pickaxe", 2).length <= 2, true);
    assert.deepEqual(host.search("xyzzy plugh", 5), []);
    assert.deepEqual(host.search("   ", 5), []);
  });

  it("shows whether a hit is active and how often its action worked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(COUNTER_SOURCE, () => true);
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    const host = new KitHost({ kits: lib.list(), stores: () => JsonStore.memory(), stats, active: ["move"] });
    host.use(["move", "counter"]);
    await host.api(fakeScope, fakeBot).counter!.later!({});
    const hit = host.search("tick", 5).find((h) => h.kit === "counter" && h.action === "later")!;
    assert.deepEqual(hit.stats, { ok: 1, failed: 0 });
    assert.equal(hit.active, true);
    host.use(["move"]);
    assert.equal(host.search("tick", 5).find((h) => h.kit === "counter")!.active, false);
  });

  it("searches only the active kits of a locked body", () => {
    const host = new KitHost({ kits: new KitLibrary({}).list(), stores: () => JsonStore.memory(), active: ["move"], locked: true });
    assert.ok(host.search("walk", 5).length > 0);
    assert.ok(host.search("collect logs", 5).every((hit) => hit.kit === "move"));
  });
});

const TINY = (name: string, description: string) =>
  `${IMPORTS}export default defineKit({ name: "${name}", description: "${description}" }, { a: action({ doc: "d", args: z.object({}), run: () => 1 }) });`;

describe("kit try with used kits", () => {
  it("gives the kits a trial calls throwaway stores and counts none of their calls", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(path.join(dir, "agent-kits"));
    await lib.save(
      `${IMPORTS}export default defineKit({ name: "base", description: "Saved." }, {
        remember: action({ doc: "Stores.", args: z.object({}), run: (ctx) => { ctx.store.set("seen", true); return ctx.store.keys(); } }),
        strict: action({ doc: "Needs n.", args: z.object({ n: z.number() }), run: () => 1 }),
      });`,
      () => true,
    );
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    const host = new KitHost({ kits: lib.list(), stores: (name) => new JsonStore(path.join(dir, "stores", `${name}.json`)), stats });
    const tried = lib.check(
      `${IMPORTS}export default defineKit({ name: "exp", description: "Tried.", uses: ["base"] }, {
        go: action({ doc: "Calls base.", args: z.object({}), run: async (ctx) => {
          const first = ctx.kits.base.remember({});
          try { ctx.kits.base.strict({}); } catch {}
          return [first, ctx.kits.base.remember({})];
        } }),
      });`,
      () => true,
    );
    // The two calls share one throwaway store within the trial.
    assert.deepEqual(await host.tryKit(tried, "go", {}, fakeScope, fakeBot), [["seen"], ["seen"]]);
    stats.flush();
    assert.deepEqual(stats.forKit("base"), {});
    assert.deepEqual(stats.forKit("exp"), {});
    assert.equal(existsSync(path.join(dir, "stores", "base.json")), false);
    assert.equal(existsSync(path.join(dir, "stores", "exp.json")), false);
    // Each trial starts empty.
    assert.deepEqual(await host.tryKit(tried, "go", {}, fakeScope, fakeBot), [["seen"], ["seen"]]);
    // A normal call still counts and stores.
    host.api(fakeScope, fakeBot).base!.remember!({});
    assert.deepEqual(stats.forKit("base").remember, { ok: 1, failed: 0 });
    assert.equal(existsSync(path.join(dir, "stores", "base.json")), true);
  });
});

describe("kit statistics and aborted programs", () => {
  it("does not count a failure that follows an abort, and still counts successes and ordinary failures", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const lib = library(dir);
    await lib.save(COUNTER_SOURCE, () => true);
    const stats = new KitStats(new JsonStore(path.join(dir, "kit-stats.json")));
    const host = new KitHost({ kits: lib.list(), stores: () => JsonStore.memory(), stats });
    const controller = new AbortController();
    const kit = host.api({ ...fakeScope, signal: controller.signal }, fakeBot);
    assert.throws(() => kit.counter!.fail!({}), /because/);
    controller.abort();
    assert.throws(() => kit.counter!.fail!({}), /because/);
    await assert.rejects(async () => kit.counter!.failLater!({}), /late/);
    assert.equal(await kit.counter!.later!({}), 2);
    assert.deepEqual(stats.forKit("counter").fail, { ok: 0, failed: 1, lastError: "because\nsecond line" });
    assert.equal("failLater" in stats.forKit("counter"), false);
    assert.deepEqual(stats.forKit("counter").later, { ok: 1, failed: 0 });
  });
});

describe("kit library across bodies", () => {
  it("tells every library that shares the directory when a kit's source changed or vanished", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    const heardA: string[] = [];
    const heardB: string[] = [];
    const a = new KitLibrary({ dir, savedBy: "a", onChange: (kit) => heardA.push(kit) });
    const b = new KitLibrary({ dir, savedBy: "b", onChange: (kit) => heardB.push(kit) });
    await a.save(TINY("wood", "v1"), () => true);
    b.agentKits();
    await bump();
    await a.save(TINY("wood", "v2"), () => true);
    assert.equal(b.agentKits().get("wood")!.description, "v2");
    await bump();
    await a.remove("wood");
    b.agentKits();
    assert.deepEqual(heardA, ["wood", "wood", "wood"]);
    assert.deepEqual(heardB, ["wood", "wood", "wood"]);
  });

  it("does not report the kits that are already on disk when a library starts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    await library(dir).save(TINY("wood", "v1"), () => true);
    const heard: string[] = [];
    const lib = new KitLibrary({ dir, onChange: (kit) => heard.push(kit) });
    lib.agentKits();
    assert.deepEqual(heard, []);
  });
});

describe("kit versions of the wrong kit", () => {
  it("refuses to restore a version whose source holds another kit, and keeps a misnamed file out of the history", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "minebot-agentkits-"));
    // A file whose name does not match the kit it defines: the library skips it on load.
    await writeFile(path.join(dir, "wood.ts"), TINY("stone", "hand-written, misnamed"));
    const lib = library(dir);
    await lib.save(TINY("wood", "real"), () => true);
    assert.deepEqual((await lib.versions("wood")).map((v) => v.version), [1]);
    assert.equal(existsSync(path.join(dir, ".history", "stone")), false);

    // A history file that names another kit cannot be restored as this one.
    const history = path.join(dir, ".history", "wood");
    await writeFile(path.join(history, "2.json"), JSON.stringify({ version: 2, savedAt: "2026-01-01T00:00:00.000Z", savedBy: "x" }));
    await writeFile(path.join(history, "2.ts"), TINY("stone", "wrong kit"));
    await assert.rejects(() => lib.revert("wood", 2, () => true), /holds the kit "stone"; it cannot be restored as "wood"/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".ts")).sort(), ["wood.ts"]);
    assert.match(lib.source("wood")!, /real/);
  });
});
