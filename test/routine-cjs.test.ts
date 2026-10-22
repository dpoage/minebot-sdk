import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import pathfinderPackage from "mineflayer-pathfinder";
import * as pathfinderNamespace from "mineflayer-pathfinder";
import { RoutineLoader } from "../src/host/routines/loader.ts";
import { PACKAGE_ROOT } from "../src/package.ts";

// The libraries live in a scratch directory outside the package: no node_modules above them, so only the loader can find a package.
const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "routine-cjs-")));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;
/** A fresh scratch directory holding the modules `files` (name → source); returns its path. */
function library(files: Record<string, string>): string {
  const dir = path.join(SCRATCH, `t${counter++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(path.join(dir, `${name}.ts`), source);
  return dir;
}

type Module = Record<string, (...args: unknown[]) => unknown> & { default: (...args: unknown[]) => unknown };
const load = async (dir: string, name: string) => (await new RoutineLoader(dir).load(name)) as Module;

/** The body packages, and the CommonJS export each has as the body's own `require` sees it. */
const BODY_PACKAGES = ["mineflayer", "mineflayer-pathfinder", "vec3", "minecraft-data", "prismarine-block", "prismarine-entity", "prismarine-item", "prismarine-nbt", "prismarine-recipe", "prismarine-registry"];
const bodyRequire = createRequire(path.join(PACKAGE_ROOT, "package.json"));

describe("a library module imports the body's CommonJS packages by name", () => {
  for (const name of BODY_PACKAGES) {
    it(`${name}: every own enumerable key of its CommonJS export imports, and is the key of the default import`, async () => {
      const exported = bodyRequire(name) as Record<string, unknown>;
      const keys = Object.keys(exported);
      const imports = keys.map((key, index) => `${JSON.stringify(key)} as named${index}`).join(", ");
      const dir = library({
        [name]: `import fromDefault from ${JSON.stringify(name)};
${keys.length > 0 ? `import { ${imports} } from ${JSON.stringify(name)};` : ""}
export default () => ({ fromDefault, named: [${keys.map((_, index) => `named${index}`).join(", ")}] });
`,
      });
      const { fromDefault, named } = (await (await load(dir, name)).default()) as { fromDefault: Record<string, unknown>; named: unknown[] };
      assert.equal(fromDefault, exported, "the default import is the body's own instance");
      assert.equal(fromDefault, (await import(name)).default);
      assert.equal(named.length, keys.length);
      keys.forEach((key, index) => assert.equal(named[index], fromDefault[key], `${name}: ${key}`));
    });
  }

  it("takes the keys programmatically: the packages have keys to import, among them goals", () => {
    const total = BODY_PACKAGES.reduce((sum, name) => sum + Object.keys(bodyRequire(name) as object).length, 0);
    assert.ok(total > 0, String(total));
    assert.ok(Object.keys(bodyRequire("mineflayer-pathfinder") as object).includes("goals"));
  });

  it("gives a class imported by name the identity of the default import's class", async () => {
    const dir = library({
      classes: `import { goals, Movements } from "mineflayer-pathfinder";
import pathfinder from "mineflayer-pathfinder";
export default () => ({ near: new goals.GoalNear(1, 2, 3, 4), goals, Movements, pathfinder });
`,
    });
    const got = (await (await load(dir, "classes")).default()) as { near: unknown; goals: unknown; Movements: unknown; pathfinder: unknown };
    assert.ok(got.near instanceof pathfinderPackage.goals.GoalNear);
    assert.ok(got.near instanceof (got.pathfinder as typeof pathfinderPackage).goals.GoalNear);
    assert.equal(got.goals, pathfinderPackage.goals);
    assert.equal(got.Movements, pathfinderPackage.Movements);
    assert.equal(got.pathfinder, pathfinderPackage);
  });

  it("resolves each bare specifier to the URL the body package resolves, plus the facade query for a CommonJS package alone", async () => {
    const specifiers = [...BODY_PACKAGES, "zod", "minebot-sdk/routine", "node:os", "os"];
    const dir = library({ resolved: `export default () => ${JSON.stringify(specifiers)}.map((specifier) => import.meta.resolve(specifier));` });
    const resolved = (await (await load(dir, "resolved")).default()) as string[];
    resolved.forEach((url, index) => {
      const own = import.meta.resolve(specifiers[index]!);
      const commonJs = ["mineflayer", "mineflayer-pathfinder", "minecraft-data", "prismarine-block", "prismarine-entity", "prismarine-item", "prismarine-nbt", "prismarine-recipe", "prismarine-registry"].includes(specifiers[index]!);
      assert.equal(url, commonJs ? `${own}?minebot-named-exports` : own, `${specifiers[index]}`);
    });
  });

  it("leaves the body's own import of a CommonJS package as Node makes it, and the same instance", async () => {
    const dir = library({ same: `import * as namespace from "mineflayer-pathfinder"; export default () => namespace;` });
    const facade = (await (await load(dir, "same")).default()) as Record<string, unknown>;
    assert.notEqual(facade, pathfinderNamespace);
    assert.equal(facade.default, pathfinderNamespace.default);
    assert.equal("goals" in pathfinderNamespace, false, "Node's own namespace has no goals to import by name; only the facade does");
    assert.equal(facade.goals, pathfinderNamespace.default.goals);
  });
});

describe("a library module has require", () => {
  const builtins = ["fs", "node:fs", "os", "node:os"];
  const withDefaults = BODY_PACKAGES.map((name, index) => `import default${index} from ${JSON.stringify(name)};`).join("\n");
  const ids = JSON.stringify([...BODY_PACKAGES, ...builtins]);

  it("returns, at the top level and in a function, the instance import gives for a body package, and Node's built-in with or without node:", async () => {
    const dir = library({
      req: `${withDefaults}
const atTop = ${ids}.map((id) => require(id));
export default () => ({ atTop, inFunction: ${ids}.map((id) => require(id)), defaults: [${BODY_PACKAGES.map((_, index) => `default${index}`).join(", ")}] });
`,
    });
    const { atTop, inFunction, defaults } = (await (await load(dir, "req")).default()) as Record<string, unknown[]>;
    for (const [what, got] of [["top level", atTop!], ["function", inFunction!]] as const) {
      BODY_PACKAGES.forEach((name, index) => {
        assert.equal(got[index], defaults![index], `${what}: ${name}`);
        assert.equal(got[index], bodyRequire(name));
      });
      assert.equal(got[BODY_PACKAGES.length], fs);
      assert.equal(got[BODY_PACKAGES.length + 1], fs);
      assert.equal(got[BODY_PACKAGES.length + 2], os);
      assert.equal(got[BODY_PACKAGES.length + 3], os);
    }
  });

  it("offers require.resolve, which resolves from the body package as require does", async () => {
    const dir = library({ resolve: `export default () => [require.resolve("vec3"), typeof require.cache, require.resolve.paths("vec3")?.length];` });
    const [resolved, cache, paths] = (await (await load(dir, "resolve")).default()) as [string, string, number];
    assert.equal(resolved, bodyRequire.resolve("vec3"));
    assert.equal(cache, "object");
    assert.ok(paths > 0);
  });

  it("refuses a path, naming it: a library's modules import one another", async () => {
    const dir = library({ paths: `export default (_: unknown, args: { id: string }) => require(args.id);`, helper: "export const x = 1;" });
    const routine = (await load(dir, "paths")).default;
    for (const id of ["./helper.ts", "../x", "/etc/passwd", "file:///etc/passwd"]) {
      await assert.rejects(async () => routine({}, { id }), (error: Error) => error.message.includes(`"${id}"`) && /packages and Node built-ins/.test(error.message), id);
    }
  });

  it("fails for a package the body does not have, as require does, naming it", async () => {
    const dir = library({ missing: `export default () => require("no-such-package");` });
    await assert.rejects(async () => (await load(dir, "missing")).default(), /no-such-package/);
  });

  for (const [what, declaration] of [
    ["const", `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`],
    ["function", `function require(id: string): string { return "own " + id; }`],
    ["import alias", `import { createRequire as require } from "node:module";`],
    ["destructuring", `const { require } = { require: (id: string) => "own " + id };`],
  ] as const) {
    it(`leaves a module that declares its own require (${what}) as it is`, async () => {
      const dir = library({ own: `${declaration}\nexport default () => typeof require;` });
      assert.equal(await (await load(dir, "own")).default(), "function");
      // The module's own require is the one in use: the library sits outside the package, where no body package resolves.
      if (what === "const") {
        const withUse = library({ own: `${declaration}\nexport default () => require("node:fs") === require("fs");` });
        assert.equal(await (await load(withUse, "own")).default(), true);
        const missing = library({ own: `${declaration}\nexport default () => require("vec3");` });
        await assert.rejects(async () => (await load(missing, "own")).default(), /vec3/);
      }
    });
  }
});

describe("a module that uses these reports the lines and columns its source has", () => {
  /** `line:column` of the first stack frame in a library module. */
  const frame = (error: Error): string => {
    const match = /\.ts\?g=[0-9a-f]+:(\d+):(\d+)/.exec(error.stack ?? "");
    assert.ok(match, `${error.stack}`);
    return `${match[1]}:${match[2]}`;
  };
  /** Where `needle` starts in `source`, as `line:column` (1-based). */
  const where = (source: string, needle: string): string => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, needle);
    const before = source.slice(0, index).split("\n");
    return `${before.length}:${before.at(-1)!.length + 1}`;
  };

  const source = [
    `import { goals } from "mineflayer-pathfinder"; // line 1`,
    `const top = require("vec3");`,
    `export const inFunction = () => {`,
    `  require("node:fs");`,
    `  throw new Error(\`first \${typeof goals} \${typeof top}\`);`,
    `};`,
    `export default () => {`,
    `  throw new Error("default");`,
    `};`,
    `export const last = () => { throw new Error("last"); }; // no line break after this`,
  ].join("\n");

  it("for errors a module throws when it is called, whatever its last line is", async () => {
    const dir = library({ lines: source });
    const module = await load(dir, "lines");
    for (const [call, needle] of [
      [module.inFunction!, "new Error(`first"],
      [module.default, 'new Error("default")'],
      [module.last!, 'new Error("last")'],
    ] as const) {
      try {
        call();
        assert.fail("did not throw");
      } catch (error) {
        assert.equal(frame(error as Error), where(source, needle), needle);
      }
    }
  });

  it("for an error the module throws on its first line, as it loads", async () => {
    const first = `import { goals } from "mineflayer-pathfinder"; if (goals) throw new Error("on line one"); const never = require("vec3");`;
    const dir = library({ first });
    await assert.rejects(new RoutineLoader(dir).load("first"), (error: Error) => frame(error) === where(first, 'new Error("on line one")'));
  });

  it("for a require that fails", async () => {
    const text = `\n\nexport default () => {\n  return require("no-such-package");\n};`;
    const dir = library({ failing: text });
    const module = await load(dir, "failing");
    // Node's own frames of a failed require come first; the module's frame is further down.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    try {
      assert.throws(
        () => module.default(),
        (error: Error) => frame(error).split(":")[0] === where(text, 'require("no-such').split(":")[0],
      );
    } finally {
      Error.stackTraceLimit = limit;
    }
  });
});

describe("typeCheckRoutine agrees with the runtime", () => {
  /** What each row's module should do when it runs and when it is checked. */
  const ROWS: Record<string, { source: string; runs: boolean; check: "passed" | "failed"; why: string }> = {
    "named-import-goals": { source: `import { goals } from "mineflayer-pathfinder";\nexport default () => typeof goals;`, runs: true, check: "passed", why: "a named import of a CommonJS package" },
    "require-vec3-in-function": { source: `export default () => typeof require("vec3");`, runs: true, check: "passed", why: "require of a body package in a function" },
    "require-fs-at-top": { source: `const fs = require("node:fs");\nexport default () => typeof fs.readFileSync;`, runs: true, check: "passed", why: "require of a built-in at the top level" },
    // `require(id)` takes a string that is known only when it runs, so the compiler types it `any` for every id, as it does for any Node program: a package that is not there fails the run alone.
    "require-missing-package": { source: `export default () => require("no-such-pkg");`, runs: false, check: "passed", why: "runtime-only: require's argument is a run-time string" },
    "named-import-missing-name": { source: `import { nope } from "mineflayer-pathfinder";\nexport default () => nope;`, runs: false, check: "failed", why: "a named import of a name the package lacks" },
  };

  /** The runner a child process executes: loads and calls each row's routine through the loader at `argv[2]`, then checks it, and prints what happened. */
  const RUNNER = `
import { pathToFileURL } from "node:url";
const [, , root, dir, ...names] = process.argv;
const { RoutineLoader } = await import(pathToFileURL(root + "/src/host/routines/loader.ts").href);
const { invokeRoutine } = await import(pathToFileURL(root + "/src/routine/invoke.ts").href);
const { typeCheckRoutine } = await import(pathToFileURL(root + "/src/host/typecheck.ts").href);
const out = {};
for (const name of names) {
  const runs = await new RoutineLoader(dir).load(name).then((module) => invokeRoutine(module, name, {}, undefined)).then(() => true, () => false);
  out[name] = { runs, check: await typeCheckRoutine(dir, name) };
}
console.log(JSON.stringify(out));
`;

  /** A copy of the package without `@types/node`, as an installed package finds it (`@types/node` is a development dependency). */
  function packageWithoutNodeTypes(): string {
    const root = path.join(SCRATCH, "package-without-node-types");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    cpSync(path.join(PACKAGE_ROOT, "src"), path.join(root, "src"), { recursive: true });
    cpSync(path.join(PACKAGE_ROOT, "package.json"), path.join(root, "package.json"));
    const modules = realpathSync(path.join(PACKAGE_ROOT, "node_modules"));
    for (const name of readdirSync(modules)) {
      if (name === "@types") continue;
      symlinkSync(path.join(modules, name), path.join(root, "node_modules", name), "junction");
    }
    // Packages that bring their own types are still found: only the `@types` scope is left out.
    return root;
  }

  const environments = [
    ["with @types/node (the repository)", () => PACKAGE_ROOT],
    ["without @types/node (an installed package)", packageWithoutNodeTypes],
  ] as const;

  for (const [environment, rootOf] of environments) {
    it(`runs and checks each row alike ${environment}`, () => {
      const root = rootOf();
      const dir = library(Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, row.source])));
      const runner = path.join(SCRATCH, `runner${counter++}.ts`);
      writeFileSync(runner, RUNNER);
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", runner, root, dir, ...Object.keys(ROWS)], { encoding: "utf8", env, cwd: root });
      assert.equal(child.status, 0, child.stderr);
      const got = JSON.parse(child.stdout) as Record<string, { runs: boolean; check: { status: string; errors?: string[] } }>;
      for (const [name, row] of Object.entries(ROWS)) {
        assert.equal(got[name]!.runs, row.runs, `${name} (${row.why}) runs`);
        assert.equal(got[name]!.check.status, row.check, `${name} (${row.why}) is checked: ${JSON.stringify(got[name]!.check)}`);
      }
    });
  }
});
