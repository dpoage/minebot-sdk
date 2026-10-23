// `minebot init`: the files it writes, that it never overwrites, and that the `types` command it
// once pointed at is an unknown command. That the workspace type-checks and its test passes against
// the installed package is measured on the published layout, outside this suite (see dist-routine.test.ts
// for the published layout's own check).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { initWorkspace } from "../src/client/init.ts";
import { ROUTINE_COMPILER_OPTIONS } from "../src/protocol/routine-tsconfig.ts";
import { usageFor } from "../src/client/usage.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const ROOT = path.join(import.meta.dirname, "..");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "minebot-init-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let next = 0;
const freshDir = () => path.join(SCRATCH, `ws${next++}`);
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), "utf8");

/** The CLI with no body to ask: an empty runtime directory, so a command that needs one is unknown or fails to connect. */
async function minebot(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, MINEBOT_RUNTIME_DIR: path.join(SCRATCH, "no-bodies") };
  try {
    const { stdout, stderr } = await exec("node", [...CLI, ...args], { env });
    return { code: 0, out: stdout, err: stderr };
  } catch (err) {
    const failed = err as { code: number; stdout: string; stderr: string };
    return { code: failed.code, out: failed.stdout, err: failed.stderr };
  }
}

/**
 * The compiler options of the project the body's routine check compiles. The check runs in a child whose
 * `typescript` resolves to a stand-in compiler that copies the project's tsconfig.json out and passes.
 */
async function routineCheckOptions(): Promise<Record<string, unknown>> {
  const root = path.join(SCRATCH, "check");
  const typescript = path.join(root, "typescript");
  mkdirSync(path.join(typescript, "bin"), { recursive: true });
  writeFileSync(path.join(typescript, "package.json"), '{ "name": "typescript" }\n');
  writeFileSync(
    path.join(typescript, "bin", "tsc"),
    'const fs = require("node:fs");\nconst path = require("node:path");\nfs.copyFileSync(path.join(process.argv[process.argv.indexOf("-p") + 1], "tsconfig.json"), process.env.MINEBOT_TEST_TSCONFIG);\n',
  );
  const preload = path.join(root, "stand-in-typescript.cjs");
  writeFileSync(
    preload,
    `const Module = require("node:module");\nconst resolve = Module._resolveFilename;\nModule._resolveFilename = function (request, ...rest) {\n  return request === "typescript/package.json" ? ${JSON.stringify(path.join(typescript, "package.json"))} : resolve.call(this, request, ...rest);\n};\n`,
  );
  const library = path.join(root, "library");
  mkdirSync(library);
  writeFileSync(path.join(library, "walk.ts"), "export default 1;\n");
  const copied = path.join(root, "tsconfig.json");
  const script = `import { typeCheckRoutine } from ${JSON.stringify(new URL("../src/host/typecheck.ts", import.meta.url).href)};
console.log(JSON.stringify(await typeCheckRoutine(${JSON.stringify(library)}, "walk")));`;
  const { stdout } = await exec("node", ["--conditions=minebot-sdk:source", "--require", preload, "--input-type=module", "--eval", script], {
    env: { ...process.env, MINEBOT_TEST_TSCONFIG: copied },
  });
  assert.deepEqual(JSON.parse(stdout), { status: "passed" });
  return JSON.parse(readFileSync(copied, "utf8")).compilerOptions;
}

describe("initWorkspace", () => {
  it("writes the routine workspace and nothing else", async () => {
    const dir = freshDir();
    const written = await initWorkspace(dir);
    const expected = [".gitignore", "README.md", "package.json", "routines/hello.ts", "runs/say-hello.ts", "test/hello.test.ts", "tsconfig.json"];
    assert.deepEqual([...written].sort(), expected);
    assert.deepEqual(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort(), expected);
  });

  it("depends on this package's version and the compiler, and has the check and test scripts", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const pkg = JSON.parse(read(dir, "package.json"));
    const own = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.dependencies, { "minebot-sdk": `^${own.version}` });
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ["@types/node", "typescript"]);
    assert.deepEqual(pkg.scripts, { check: "tsc", test: "node --test test/" });
  });

  it("lets a run import a routine by its file name: rootDirs joins the two folders, and the check covers both and the tests", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const { compilerOptions, include } = JSON.parse(read(dir, "tsconfig.json"));
    assert.equal(compilerOptions.module, "nodenext");
    assert.equal(compilerOptions.strict, true);
    assert.equal(compilerOptions.noEmit, true);
    assert.equal(compilerOptions.allowImportingTsExtensions, true);
    assert.deepEqual(compilerOptions.rootDirs, ["routines", "runs"]);
    assert.deepEqual(include, ["routines/**/*.ts", "runs/**/*.ts", "test/**/*.ts"]);
  });

  it("type-checks with the options of the body's routine check: the shared options, and every option the check's project sets", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const workspace: Record<string, unknown> = JSON.parse(read(dir, "tsconfig.json")).compilerOptions;
    const check = await routineCheckOptions();
    for (const [key, value] of Object.entries(ROUTINE_COMPILER_OPTIONS)) {
      assert.deepEqual(workspace[key], value, `workspace ${key}`);
      assert.deepEqual(check[key], value, `check ${key}`);
    }
    // The check's own project sets customConditions only because it runs from source here; a workspace takes the installed package.
    const { customConditions, ...checkOptions } = check;
    assert.deepEqual(customConditions, ["minebot-sdk:source"]);
    for (const [key, value] of Object.entries(checkOptions)) assert.deepEqual(workspace[key], value, `the check sets ${key}`);
    assert.deepEqual(Object.keys(workspace).filter((key) => !(key in checkOptions)), ["rootDirs"]);
  });

  it("writes a routine that counts items with the bot, a run that imports it, and a test through the harness", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const routine = read(dir, "routines/hello.ts");
    assert.match(routine, /^import \{ defineRoutine, nameMatcher, z \} from "minebot-sdk\/routine";$/m);
    assert.match(routine, /ctx\.bot\.inventory\.items\(\)/);
    assert.match(routine, /^export default defineRoutine\($/m);
    assert.match(routine, /^ {4}args: z\.object\(/m);
    assert.match(routine, /^ {4}returns: z\.object\(/m);
    const run = read(dir, "runs/say-hello.ts");
    assert.match(run, /^import hello from "\.\/hello\.ts";$/m);
    assert.match(run, /^export default /m);
    const test = read(dir, "test/hello.test.ts");
    assert.match(test, /^import \{ createHarness \} from "minebot-sdk\/testing";$/m);
    assert.match(test, /h\.run\(hello, \{ message: "hi" \}\)/);
    assert.match(test, /assert\.rejects\(h\.run\(hello, /);
  });

  it("names no built-in routine and imports no built-in module, which a tier may withhold", async () => {
    const dir = freshDir();
    const written = await initWorkspace(dir);
    for (const file of written) {
      const text = read(dir, file);
      for (const module of BUILTIN_MODULES) {
        assert.ok(!text.includes(`minebot-sdk/routines/${module.name}`), `${file} imports the built-in module ${module.name}`);
        for (const routine of Object.keys(module.routines)) {
          assert.doesNotMatch(text, new RegExp(`(?<![\\w.])${module.name}\\.${routine}\\b`), `${file} names the built-in ${module.name}.${routine}`);
        }
      }
    }
    assert.ok(BUILTIN_MODULES.length > 0 && written.includes("routines/hello.ts"));
  });

  it("gives no run file the file name of a routine: a run's ./x.ts must name the routine, not the run", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const routines = new Set(readdirSync(path.join(dir, "routines")));
    const runs = readdirSync(path.join(dir, "runs"));
    assert.ok(runs.length > 0 && routines.size > 0);
    for (const run of runs) assert.ok(!routines.has(run), `runs/${run} shares its name with routines/${run}`);
  });

  it("has a README with the workspace's commands and the file-name rule", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    const readme = read(dir, "README.md");
    for (const command of ["npm install", "minebot routines save routines/*.ts", "minebot bind action hello hello", "minebot call hello", "minebot run runs/say-hello.ts", "npm test", "npx tsc"]) {
      assert.ok(readme.includes(command), command);
    }
    assert.match(readme, /must not have the same file name as a routine/);
    assert.doesNotMatch(readme, /minebot\s+types|env\.d\.ts/);
  });

  it("never overwrites an existing file", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    writeFileSync(path.join(dir, "routines/hello.ts"), "// mine\n");
    writeFileSync(path.join(dir, "tsconfig.json"), "{}\n");
    assert.deepEqual(await initWorkspace(dir), []);
    assert.equal(read(dir, "routines/hello.ts"), "// mine\n");
    assert.equal(read(dir, "tsconfig.json"), "{}\n");
  });

  it("writes only the files that are missing", async () => {
    const dir = freshDir();
    await initWorkspace(dir);
    rmSync(path.join(dir, "runs"), { recursive: true });
    writeFileSync(path.join(dir, "README.md"), "mine\n");
    assert.deepEqual(await initWorkspace(dir), ["runs/say-hello.ts"]);
    assert.equal(read(dir, "README.md"), "mine\n");
  });
});

describe("the minebot command", () => {
  it("`minebot init` names the next steps, and no `types` among them", async () => {
    const dir = freshDir();
    const result = await minebot("init", dir);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, new RegExp(`wrote ${path.join(dir, "runs/say-hello.ts").replaceAll("/", "\\/")}`));
    assert.match(result.out, /Next: .*npm install.*minebot routines save routines\/\*\.ts.*minebot bind action hello hello/);
    assert.doesNotMatch(result.out, /types/);
    const again = await minebot("init", dir);
    assert.match(again.out, /already has every workspace file/);
  });

  it("answers the `types` command as any unknown command, and its usage has no `types`", async () => {
    const types = await minebot("types");
    const other = await minebot("no-such-command");
    assert.equal(types.code, 1);
    assert.equal(types.err, other.err.replaceAll("no-such-command", "types"));
    assert.match(types.err, /^unknown command: types\n/);
    assert.doesNotMatch(types.err.slice(types.err.indexOf("\n")), /^ {2}types\b|declarations|env\.d\.ts/m);
    const refused = await minebot("types", "--out", path.join(SCRATCH, "env.d.ts"));
    assert.equal(refused.code, 1);
  });

  it("lists no `types` in the usage of an install that can start bodies, and still lists init", () => {
    const usage = usageFor(null, true);
    assert.doesNotMatch(usage, /^ {2}types\b/m);
    assert.match(usage, /^ {2}init \[dir\]/m);
  });
});
