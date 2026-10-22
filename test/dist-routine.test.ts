import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[]; dependencies: Record<string, string> };

/** The export lists the package commits to, which the consumer compares the built entry points against. */
const COMMITTED_EXPORTS: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "package-exports.json"), "utf8"));

/** A consumer of the published package: a test file that runs a routine through `h.run`. It is plain JavaScript, so the only thing between it and the package is node's own resolution. */
const CONSUMER = `
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineRoutine, z } from "minebot-sdk/routine";
import * as client from "minebot-sdk/client";
import * as routine from "minebot-sdk/routine";
import * as testing from "minebot-sdk/testing";
import * as crafter from "minebot-sdk/routines/crafter";

const { createHarness, UnsupportedApiError } = testing;
const COMMITTED = ${JSON.stringify(COMMITTED_EXPORTS)};

test("runs a routine through the published harness", async () => {
  // The built files answered, not the sources: no source condition is set.
  assert.match(import.meta.resolve("minebot-sdk/routine"), /\\/node_modules\\/minebot-sdk\\/dist\\/routine\\/public\\.js$/);
  assert.match(import.meta.resolve("minebot-sdk/testing"), /\\/node_modules\\/minebot-sdk\\/dist\\/testing\\/index\\.js$/);
  assert.deepEqual(Object.keys(client).sort(), COMMITTED.client);
  assert.deepEqual(Object.keys(testing).sort(), COMMITTED.testing);
  assert.deepEqual(Object.keys(routine).sort(), COMMITTED.routine);
  const h = createHarness({ inventory: { oak_log: 1 } });
  const make = defineRoutine(
    { args: z.object({ item: z.string(), note: z.string().default("made") }), returns: z.object({ made: z.number() }) },
    async (ctx, { item, note }) => {
      ctx.log("making", item);
      await ctx.sleep(100);
      ctx.notes.set("last", note);
      return { made: await crafter.make(ctx, { item }) };
    },
  );
  assert.deepEqual(await h.run(make, { item: "oak_planks" }), { made: 4 });
  assert.deepEqual(h.logs, ["making oak_planks", "crafted 4 oak_planks"]);
  assert.deepEqual(h.calls[0], { kit: "crafter", action: "make", args: { item: "oak_planks" } });
  assert.equal(h.count("oak_planks"), 4);
  assert.equal(await h.run((ctx) => ctx.notes.get("last")), "made");
  await assert.rejects(h.run(make, { item: 3 }), /^Error: routine "under test" arguments: /);
  await assert.rejects(h.run((ctx) => ctx.status()), UnsupportedApiError);
});
`;

/** The same call, for the compiler: the published declarations have to carry the routine's types through \`h.run\`. */
const CONSUMER_TYPES = `
import { defineRoutine, z } from "minebot-sdk/routine";
import { createHarness } from "minebot-sdk/testing";
import * as crafter from "minebot-sdk/routines/crafter";

const h = createHarness();
const make = defineRoutine({ args: z.object({ item: z.string(), note: z.string().default("made") }), returns: z.object({ made: z.number() }) }, async (ctx, { item }) => ({ made: await crafter.make(ctx, { item }) }));
export async function types() {
  const made: number = (await h.run(make, { item: "oak_planks" })).made;
  // @ts-expect-error item is required
  await h.run(make, { note: "x" });
  const plain: number = await h.run(async (_ctx, args: { n: number }) => args.n + 1, { n: 1 });
  return [made, plain];
}
`;

function run(command: string, args: string[], cwd: string): string {
  // NODE_OPTIONS is dropped so that no source condition reaches the child, and NODE_TEST_CONTEXT so that
  // a child test run reports its own failures in its exit code (inherited, it reports them to this run).
  const { NODE_OPTIONS: _options, NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.status, 0, `${path.basename(args[0] ?? command)} ${args.slice(1).join(" ")} exited ${result.status ?? result.signal}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

describe("the published package", () => {
  // Builds the package with the build config (about a second), lays it out the way npm installs it,
  // and runs a consumer in a second node process (about a second more).
  it("runs a routine through minebot-sdk/testing from the built layout, with no source condition", { timeout: 180_000 }, () => {
    const dist = path.join(ROOT, "dist");
    const hadDist = existsSync(dist);
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "minebot-dist-")));
    try {
      const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
      run(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", path.join(work, "dist")], ROOT);

      // app/node_modules/minebot-sdk is a real copy of what `files` ships (under node_modules node does not strip types, as in an install), and its dependencies sit beside it, hoisted.
      const app = path.join(work, "app");
      const installed = path.join(app, "node_modules", "minebot-sdk");
      mkdirSync(installed, { recursive: true });
      cpSync(path.join(ROOT, "package.json"), path.join(installed, "package.json"));
      renameSync(path.join(work, "dist"), path.join(installed, "dist"));
      for (const entry of manifest.files.filter((file) => file !== "dist" && existsSync(path.join(ROOT, file)))) {
        cpSync(path.join(ROOT, entry), path.join(installed, entry), { recursive: true });
      }
      for (const name of [...Object.keys(manifest.dependencies), "@types/node"]) {
        mkdirSync(path.dirname(path.join(app, "node_modules", name)), { recursive: true });
        symlinkSync(path.join(ROOT, "node_modules", name), path.join(app, "node_modules", name));
      }

      writeFileSync(path.join(app, "package.json"), JSON.stringify({ type: "module", private: true }));
      writeFileSync(path.join(app, "consumer.test.mjs"), CONSUMER);
      assert.match(run(process.execPath, ["--test", "consumer.test.mjs"], app), /^ℹ pass 1$/m);

      writeFileSync(path.join(app, "types.ts"), CONSUMER_TYPES);
      writeFileSync(path.join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "esnext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] }, include: ["types.ts"] }));
      run(process.execPath, [tsc, "-p", app], app);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    assert.equal(existsSync(dist), hadDist, "the test must not leave a dist/ in the tree");
  });
});
