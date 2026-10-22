import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
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

  it("is no module of its own: an importer that is not a library module gets Node's answer for the specifier", async () => {
    const dir = library({ uses: `export default () => typeof require;` });
    assert.equal(await (await load(dir, "uses")).default(), "function");
    // A variable, so the compiler does not try to resolve the specifier.
    const specifier = "minebot:require";
    await assert.rejects(import(specifier), { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" });
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

  /** The runner a child process executes: loads and calls each routine through the loader at `argv[2]`, then checks it, and prints what happened. */
  const RUNNER = `
import { pathToFileURL } from "node:url";
const [, , root, dir, ...names] = process.argv;
const { RoutineLoader } = await import(pathToFileURL(root + "/src/host/routines/loader.ts").href);
const { invokeRoutine } = await import(pathToFileURL(root + "/src/routine/invoke.ts").href);
const { typeCheckRoutine } = await import(pathToFileURL(root + "/src/host/typecheck.ts").href);
const out = {};
for (const name of names) {
  const run = await new RoutineLoader(dir).load(name).then((module) => invokeRoutine(module, name, {}, undefined)).then((value) => ({ runs: true, value }), (error) => ({ runs: false, error: String(error) }));
  out[name] = { ...run, check: await typeCheckRoutine(dir, name) };
}
console.log(JSON.stringify(out));
`;

  /** A copy of the package without `@types/node`, as an installed package finds it (`@types/node` is a development dependency). */
  function packageWithoutNodeTypes(): string {
    const root = path.join(SCRATCH, "package-without-node-types");
    if (fs.existsSync(root)) return root;
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
    ["with @types/node (the repository)", () => PACKAGE_ROOT, true],
    ["without @types/node (an installed package)", packageWithoutNodeTypes, false],
  ] as const;

  type Outcome = { runs: boolean; value?: unknown; error?: string; check: { status: string; errors?: string[] } };
  /** Runs and checks the routines `sources` (name → source) in a child process, as the package at `root` does. */
  function runAndCheck(root: string, sources: Record<string, string>): Record<string, Outcome> {
    const dir = library(sources);
    const runner = path.join(SCRATCH, `runner${counter++}.ts`);
    writeFileSync(runner, RUNNER);
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", runner, root, dir, ...Object.keys(sources)], { encoding: "utf8", env, cwd: root });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as Record<string, Outcome>;
  }

  const VEC3 = typeof bodyRequire("vec3");
  /** An expression that tells the module's own `require` (a `createRequire` at the library, which finds no body package) from the routine's. */
  const WHOSE = `(() => { try { require.resolve("vec3"); return "routine require"; } catch { return "own require"; } })()`;
  /**
   * Modules with and without a binding named `require` at module scope. `value` is what the routine
   * returns: the routine's `require` where it has none, its own binding where it has one, which it
   * then loads with as it would without the routine's. A row with `nodeTypes` uses a Node built-in or
   * `import.meta.url`, which only a project with `@types/node` types; without it the check fails on
   * those, and on nothing about `require`.
   */
  const REQUIRE_ROWS: Record<string, { source: string; value: unknown; nodeTypes?: true; why: string }> = {
    "plain-in-function": { source: `export default () => typeof require("vec3");`, value: VEC3, why: "no binding: require in a function" },
    "plain-at-top": { source: `const eol = require("node:os").EOL;\nexport default () => eol.length;`, value: os.EOL.length, why: "no binding: require at the top level" },
    "comment-mentions-require-call": { source: `// Node packages such as require("vec3") style CommonJS ones work here.\nexport default () => typeof require("vec3");`, value: VEC3, why: "seat A B1: a comment that calls require" },
    "jsdoc-mentions-require": { source: `/** Calls the function require provides. */\nexport default () => typeof require("vec3");`, value: VEC3, why: "seat A B1: a JSDoc that names require" },
    "comment-let-require": { source: "// never write `let require`\nexport default () => typeof require(\"vec3\");", value: VEC3, why: "seat A B1: a comment that declares require" },
    "comment-const-require": { source: `// const require = createRequire(import.meta.url) is not needed here\nexport default () => typeof require("vec3");`, value: VEC3, why: "seat B row 42: a comment that declares require" },
    "string-var-require": { source: `export default () => ["var require is not used", typeof require("vec3")];`, value: ["var require is not used", VEC3], why: "seat A B1: a string that declares require" },
    "template-const-require": { source: "const note = `const require = ${1}`;\nexport default () => [note, typeof require(\"vec3\")];", value: ["const require = 1", VEC3], why: "a template literal that declares require" },
    "for-of-destructuring-in-function": {
      source: `export default () => {\n  const m = new Map([["a", 1]]);\n  const out: number[] = [];\n  for (const [k] of m) out.push(k.length + require("node:os").EOL.length);\n  return out;\n};`,
      value: [1 + os.EOL.length],
      why: "seat A B1: a for-of head with a destructuring const, then require",
    },
    "for-of-require-at-top": { source: `const seen: number[] = [];\nfor (const require of [1, 2]) seen.push(require);\nexport default () => [seen, typeof require("vec3")];`, value: [[1, 2], VEC3], why: "a for-of head that binds require in the loop alone" },
    "for-in-require-in-function": { source: `export default () => {\n  const keys: string[] = [];\n  for (const require in { a: 1 }) keys.push(require);\n  return [keys, typeof require("vec3")];\n};`, value: [["a"], VEC3], why: "a for-in head that binds require in the loop alone" },
    "nested-function-const-require": {
      source: `function other() {\n  const require = (id: string) => "inner " + id;\n  return require("x");\n}\nexport default () => [other(), typeof require("vec3")];`,
      value: ["inner x", VEC3],
      why: "seat A N4: const require in another function",
    },
    "parameter-require": { source: `const call = (require: (id: string) => string) => require("p");\nexport default () => [call((id) => id), typeof require("vec3")];`, value: ["p", VEC3], why: "seat A row 33: a parameter named require" },
    "export-as-require": { source: `const x = 1;\nexport { x as require };\nexport default () => typeof require("vec3");`, value: VEC3, why: "seat A N4: an export named require binds nothing" },
    "declare-const-require": {
      source: `declare const require: (id: string) => { Vec3: unknown };\nexport default () => typeof require("vec3").Vec3;`,
      value: "function",
      why: "seat A N4: declare const is a type, which stripping erases: no binding at run time, the declared type in the check",
    },
    "let-list-require": {
      source: `import { createRequire } from "node:module";\nlet a = 1, require = createRequire(import.meta.url);\nexport default () => [a, ${WHOSE}];`,
      value: [1, "own require"],
      nodeTypes: true,
      why: "seat B B1: let list",
    },
    "const-destructuring-list-require": {
      source: `import * as mod from "node:module";\nconst { createRequire } = mod, require = createRequire(import.meta.url);\nexport default () => ${WHOSE};`,
      value: "own require",
      nodeTypes: true,
      why: "seat B B1: destructuring, then require, in one const",
    },
    "const-list-across-lines": {
      source: `import { createRequire } from "node:module";\nimport { fileURLToPath } from "node:url";\nconst __filename = fileURLToPath(import.meta.url),\n  require = createRequire(import.meta.url);\nexport default () => [typeof __filename, ${WHOSE}];`,
      value: ["string", "own require"],
      nodeTypes: true,
      why: "seat B B1: const list across lines",
    },
    "destructuring-default-require": {
      source: `const lib: { a?: number; require: (id: string) => string } = { require: (id) => "own " + id };\nconst { a = 1, require } = lib;\nexport default () => [a, require("vec3")];`,
      value: [1, "own vec3"],
      why: "seat B B1: destructuring with a default, then require",
    },
    "const-require": {
      source: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport default () => ${WHOSE};`,
      value: "own require",
      nodeTypes: true,
      why: "seat A row 34: const require = createRequire(import.meta.url)",
    },
    "var-list-require": { source: `var b = 2, require = (id: string) => "own " + id;\nexport default () => [b, require("vec3")];`, value: [2, "own vec3"], why: "var list" },
    "array-destructuring-require": { source: `const [require = (id: string) => "own " + id]: Array<(id: string) => string> = [];\nexport default () => require("vec3");`, value: "own vec3", why: "array destructuring with a default" },
    "function-require": { source: `export function require(id: string): string {\n  return "own " + id;\n}\nexport default () => require("vec3");`, value: "own vec3", why: "seat B row 37: an exported function declaration" },
    "default-function-require": { source: `export default function require() {\n  return require.name;\n}`, value: "require", why: "a default-exported function declaration named require" },
    "class-require": { source: `class require {\n  static own = "own class";\n}\nexport default () => require.own;`, value: "own class", why: "a class declaration" },
    "import-as-require": {
      source: `import { createRequire as require } from "node:module";\nexport default () => require.name;`,
      value: "createRequire",
      nodeTypes: true,
      why: "an import binding: import { x as require }",
    },
  };

  for (const [environment, rootOf, nodeTypes] of environments) {
    it(`runs and checks each row alike ${environment}`, () => {
      const got = runAndCheck(rootOf(), Object.fromEntries(Object.entries(ROWS).map(([name, row]) => [name, row.source])));
      for (const [name, row] of Object.entries(ROWS)) {
        assert.equal(got[name]!.runs, row.runs, `${name} (${row.why}) runs`);
        assert.equal(got[name]!.check.status, row.check, `${name} (${row.why}) is checked: ${JSON.stringify(got[name]!.check)}`);
      }
    });

    it(`gives require to a module exactly when it has no binding of that name at module scope, and checks it alike, ${environment}`, () => {
      const got = runAndCheck(rootOf(), Object.fromEntries(Object.entries(REQUIRE_ROWS).map(([name, row]) => [name, row.source])));
      // Every row's outcome at once, so a failure names each row that differs.
      const differing: string[] = [];
      for (const [name, row] of Object.entries(REQUIRE_ROWS)) {
        const outcome = got[name]!;
        const onRequire = (outcome.check.errors ?? []).filter((error) => error.includes("'require'"));
        const check = outcome.check.status !== "failed" ? outcome.check.status : onRequire.length > 0 ? `failed: ${onRequire.join(" | ")}` : "failed, not on require";
        const actual = { run: outcome.runs ? outcome.value : `throws ${outcome.error}`, check };
        const expected = { run: row.value, check: row.nodeTypes && !nodeTypes ? "failed, not on require" : "passed" };
        if (!isDeepStrictEqual(actual, expected)) differing.push(`${name} (${row.why}): got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
      }
      assert.equal(differing.length, 0, `${differing.length} of ${Object.keys(REQUIRE_ROWS).length} rows differ:\n${differing.join("\n")}`);
    });
  }
});
