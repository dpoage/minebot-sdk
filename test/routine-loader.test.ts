import osDefault from "node:os";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import mineflayer from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { RoutineLoader, RoutineNotFoundError } from "../src/host/routines/loader.ts";
import { PACKAGE_ROOT } from "../src/package.ts";
import * as routine from "../src/routine/public.ts";

const run = promisify(execFile);

// The libraries live in a scratch directory outside the package: no node_modules above them, so only the loader can find `vec3`.
const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "routine-loader-")));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;
/** A fresh scratch directory holding `files` (paths relative to it); returns its path. */
function scratch(files: Record<string, string>): string {
  const dir = path.join(SCRATCH, `t${counter++}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

type Module = Record<string, unknown> & { default: (...args: unknown[]) => unknown };
const load = async (loader: RoutineLoader, name: string) => (await loader.load(name)) as Module;

describe("RoutineLoader: what a library module can import", () => {
  const probe = `
    import { Vec3 } from "vec3";
    import { z } from "zod";
    import mineflayer from "mineflayer";
    import * as routine from "minebot-sdk/routine";
    import os from "node:os";
    import plainOs from "os";
    export default async () => ({
      Vec3, z, mineflayer, routine, os, plainOs,
      later: {
        vec3: (await import("vec3")).Vec3,
        zod: (await import("zod")).z,
        routine: await import("minebot-sdk/routine"),
        os: (await import("os")).default,
      },
      resolved: ["vec3", "zod", "mineflayer", "minebot-sdk/routine", "node:os", "os"].map((specifier) => import.meta.resolve(specifier)),
    });
  `;

  interface Probe {
    Vec3: unknown;
    z: unknown;
    mineflayer: unknown;
    routine: unknown;
    os: unknown;
    plainOs: unknown;
    later: { vec3: unknown; zod: unknown; routine: unknown; os: unknown };
    resolved: string[];
  }
  const probed = async (): Promise<Probe> => {
    const loader = new RoutineLoader(scratch({ "probe.ts": probe }));
    // The module is the fixture above: its default export returns a Probe.
    return (await (await load(loader, "probe")).default()) as Probe;
  };

  it("gives every package and built-in the instance the body package has", async () => {
    const got = await probed();
    assert.equal(got.Vec3, Vec3);
    assert.equal(got.z, z);
    assert.equal(got.mineflayer, mineflayer);
    assert.equal(got.routine, routine);
    assert.equal(got.later.vec3, Vec3);
    assert.equal(got.later.zod, z);
    assert.equal(got.later.routine, routine);
    assert.equal(got.os, got.plainOs);
    assert.equal(got.later.os, got.os);
    assert.equal(got.os, osDefault);
  });

  it("resolves each specifier to the URL it has from the body package, with the named-export facade's query on a CommonJS package's alone", async () => {
    const { resolved } = await probed();
    const specifiers = ["vec3", "zod", "mineflayer", "minebot-sdk/routine", "node:os", "os"];
    // `mineflayer` is the one CommonJS package here (`vec3` has an ES wrapper, `zod` is ES).
    const own = specifiers.map((specifier) => import.meta.resolve(specifier) + (specifier === "mineflayer" ? "?minebot-named-exports" : ""));
    assert.deepEqual(resolved, own);
    assert.ok(resolved[0]!.includes("/node_modules/vec3/"), resolved[0]!);
    assert.equal(((await import(resolved[2]!)) as { default: unknown }).default, mineflayer);
  });

  it("imports other library modules by relative path, statically and dynamically", async () => {
    const loader = new RoutineLoader(
      scratch({
        "a.ts": `import { twice } from "./helper.ts"; export default async () => [twice(2), (await import("./helper.ts")).twice(3)];`,
        "helper.ts": `export const twice = (n: number): number => n * 2;`,
      }),
    );
    assert.deepEqual(await (await load(loader, "a")).default(), [4, 6]);
  });

  for (const [what, specifier] of [
    ["a parent directory", "../outside.ts"],
    ["a subdirectory", "./sub/x.ts"],
    ["an absolute path", "OUTSIDE"],
    ["a file URL", "FILE-URL"],
  ] as const) {
    it(`refuses an import of ${what} naming the specifier, statically and dynamically`, async () => {
      const dir = scratch({ "sub/x.ts": "export const x = 1;", "../outside.ts": "export const x = 1;" });
      const spec = specifier === "OUTSIDE" ? path.join(SCRATCH, "outside.ts") : specifier === "FILE-URL" ? pathToFileURL(path.join(dir, "sub/x.ts")).href : specifier;
      writeFileSync(path.join(SCRATCH, "outside.ts"), "export const x = 1;");
      writeFileSync(path.join(dir, "static.ts"), `import { x } from ${JSON.stringify(spec)}; export default x;`);
      writeFileSync(path.join(dir, "dynamic.ts"), `export default () => import(${JSON.stringify(spec)});`);
      const loader = new RoutineLoader(dir);
      const names = (error: unknown) => error instanceof Error && error.message.includes(`"${spec}"`);
      await assert.rejects(loader.load("static"), names);
      await assert.rejects(async () => (await load(loader, "dynamic")).default(), names);
    });
  }

  it("loads a library reached through a symlink, under the real path", async () => {
    const real = scratch({ "a.ts": `import { Vec3 } from "vec3"; import { n } from "./helper.ts"; export default () => [new Vec3(n, 0, 0).x, Vec3];`, "helper.ts": "export const n = 7;" });
    const link = path.join(SCRATCH, "link");
    symlinkSync(real, link);
    const loader = new RoutineLoader(link);
    assert.equal(loader.dir, real);
    const [x, V] = (await (await load(loader, "a")).default()) as [number, unknown];
    assert.equal(x, 7);
    assert.equal(V, Vec3);
  });

  it("loads a library as an ES module under a package that says commonjs", async () => {
    const dir = scratch({
      "pkg/package.json": '{ "type": "commonjs" }',
      "pkg/lib/a.ts": `import { Vec3 } from "vec3"; import { n } from "./helper.ts"; const v: Vec3 = new Vec3(n, 0, 0); export default (): number => v.x;`,
      "pkg/lib/helper.ts": "export const n: number = 9;",
    });
    const loader = new RoutineLoader(path.join(dir, "pkg/lib"));
    assert.equal(await (await load(loader, "a")).default(), 9);
  });

  it("finds no routine for a name that is absent, malformed, or not a library module", async () => {
    const dir = scratch({ "a.ts": "export default 1;", "Upper.ts": "export default 1;", "sub/b.ts": "export default 1;", ".hidden.ts": "export default 1;" });
    writeFileSync(path.join(SCRATCH, "outside.ts"), "export default 1;");
    const loader = new RoutineLoader(dir);
    for (const name of ["missing", "Upper", "sub/b", "../outside", ".hidden", "", "a.ts", "a/../a"]) {
      await assert.rejects(loader.load(name), RoutineNotFoundError, name);
    }
    await assert.doesNotReject(loader.load("a"));
  });
});

describe("RoutineLoader: generations", () => {
  const counted = (value: string) => `
    import { n } from "./helper.ts";
    globalThis.evaluations = [...(globalThis.evaluations ?? []), ${JSON.stringify(value)}];
    export default () => n;
  `;
  const helper = (n: number) => `export const n = ${n}; globalThis.evaluations = [...(globalThis.evaluations ?? []), "helper${n}"];`;
  const evaluations = (): unknown[] => {
    const log: unknown = Reflect.get(globalThis, "evaluations");
    return Array.isArray(log) ? log : [];
  };

  it("returns the same namespace until some library module's bytes change, not for a touch", async () => {
    const dir = scratch({ "a.ts": "export default () => 1;", "b.ts": "export default () => 2;" });
    const loader = new RoutineLoader(dir);
    const first = await loader.load("a");
    assert.equal(await loader.load("a"), first);
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "a.ts"), later, later);
    assert.equal(await loader.load("a"), first);
    assert.equal(await new RoutineLoader(dir).load("a"), first, "another loader on the directory shares the generation");
    writeFileSync(path.join(dir, "b.ts"), "export default () => 3;");
    assert.notEqual(await loader.load("a"), first);
  });

  for (const viaSymlink of [false, true]) {
    it(`evaluates every module of the graph from its current bytes after any change${viaSymlink ? ", through a symlinked directory" : ""}`, async () => {
      const real = scratch({ "a.ts": counted("a1"), "helper.ts": helper(1) });
      const dir = viaSymlink ? path.join(SCRATCH, `link${counter++}`) : real;
      if (viaSymlink) symlinkSync(real, dir);
      const loader = new RoutineLoader(dir);
      const before = evaluations().length;
      assert.equal(await (await load(loader, "a")).default(), 1);
      writeFileSync(path.join(real, "helper.ts"), helper(2));
      assert.equal(await (await load(loader, "a")).default(), 2);
      writeFileSync(path.join(real, "a.ts"), counted("a3"));
      assert.equal(await (await load(loader, "a")).default(), 2);
      // Each generation evaluates the helper first (a's import), then a, whichever of the two was edited.
      assert.deepEqual(evaluations().slice(before), ["helper1", "a1", "helper2", "a1", "helper2", "a3"]);
    });
  }

  it("brings an earlier generation back, with its module state, when the bytes revert", async () => {
    const dir = scratch({ "a.ts": "let calls = 0; export default () => ++calls;", "b.ts": "export default 1;" });
    const loader = new RoutineLoader(dir);
    const first = await load(loader, "a");
    assert.equal(first.default(), 1);
    writeFileSync(path.join(dir, "b.ts"), "export default 2;");
    const second = await load(loader, "a");
    assert.notEqual(second, first);
    assert.equal(second.default(), 1, "the new generation starts its own state");
    writeFileSync(path.join(dir, "b.ts"), "export default 1;");
    const third = await load(loader, "a");
    assert.equal(third, first);
    assert.equal(third.default(), 2, "the earlier instance kept its state");
  });

  it("keeps one instance of the body's modules across generations", async () => {
    const dir = scratch({ "a.ts": `import * as routine from "minebot-sdk/routine"; import { Vec3 } from "vec3"; export { routine, Vec3 };`, "b.ts": "export default 1;" });
    const loader = new RoutineLoader(dir);
    const first = await load(loader, "a");
    writeFileSync(path.join(dir, "b.ts"), "export default 2;");
    const second = await load(loader, "a");
    assert.notEqual(second, first);
    assert.equal(second.routine, first.routine);
    assert.equal(second.routine, routine);
    assert.equal(second.Vec3, Vec3);
  });

  for (const viaSymlink of [false, true]) {
    it(`gives a dynamic import from an older generation's module that generation's helper${viaSymlink ? ", through a symlinked directory" : ""}`, async () => {
      const real = scratch({
        "a.ts": `export default async () => (await import("./helper.ts")).n;`,
        "helper.ts": "export const n = 1;",
      });
      const dir = viaSymlink ? path.join(SCRATCH, `link${counter++}`) : real;
      if (viaSymlink) symlinkSync(real, dir);
      const loader = new RoutineLoader(dir);
      const old = await load(loader, "a");
      writeFileSync(path.join(real, "helper.ts"), "export const n = 2;");
      const current = await load(loader, "a");
      assert.notEqual(current, old);
      // The old module imports its helper for the first time only now, after the save.
      assert.equal(await old.default(), 1);
      assert.equal(await current.default(), 2);
    });
  }

  it("keeps a module added after a generation out of that generation's dynamic imports", async () => {
    const dir = scratch({ "a.ts": `export default () => import("./late.ts");` });
    const loader = new RoutineLoader(dir);
    const old = await load(loader, "a");
    writeFileSync(path.join(dir, "late.ts"), "export const n = 1;");
    await assert.rejects(async () => old.default(), (error: unknown) => error instanceof Error && error.message.includes('"./late.ts"'));
  });
});

describe("RoutineLoader: every module that is not a routine resolves and loads as Node's own", () => {
  it("leaves a package under the library's node_modules and a file imported directly from the library alone", async () => {
    const dir = scratch({
      "node_modules/lazy/package.json": '{ "name": "lazy", "main": "index.js" }',
      "node_modules/lazy/index.js": 'exports.later = () => require("./lib/part.js").value;',
      "node_modules/lazy/lib/part.js": "exports.value = 42;",
      "plain.ts": 'import { dep } from "./sub/dep.ts"; export const plain: number = dep + 1;',
      "sub/dep.ts": "export const dep = 1;",
      "r.ts": 'import { Vec3 } from "vec3"; import * as routine from "minebot-sdk/routine"; export default () => [new Vec3(0, 5, 0).y, routine];',
    });
    const loader = new RoutineLoader(dir);
    assert.deepEqual(await (await load(loader, "r")).default(), [5, routine]);
    // Both import relative files a routine may not: neither is a routine.
    const lazy = (await import(pathToFileURL(path.join(dir, "node_modules/lazy/index.js")).href)) as { default: { later(): number } };
    assert.equal(lazy.default.later(), 42);
    const plain = (await import(pathToFileURL(path.join(dir, "plain.ts")).href)) as { plain: number };
    assert.equal(plain.plain, 2);
  });

  it("loads routines from a directory that holds the body package, and leaves the package's own imports alone", async () => {
    // The library is `.` and an ancestor of a copy of the package, so the loader itself, and every
    // module of the package, sits in the library directory's tree.
    const ancestor = scratch({
      "r.ts": 'import { Vec3 } from "vec3"; import * as routine from "minebot-sdk/routine"; import { n } from "./helper.ts"; export default () => [new Vec3(n, 0, 0).x, typeof routine.defineRoutine, import.meta.resolve("minebot-sdk/routine")];',
      "helper.ts": "export const n: number = 3;",
    });
    const pkg = path.join(ancestor, "pkg");
    cpSync(path.join(PACKAGE_ROOT, "src"), path.join(pkg, "src"), { recursive: true });
    cpSync(path.join(PACKAGE_ROOT, "package.json"), path.join(pkg, "package.json"));
    symlinkSync(realpathSync(path.join(PACKAGE_ROOT, "node_modules")), path.join(pkg, "node_modules"));
    const driver = path.join(SCRATCH, `driver${counter++}.mjs`);
    writeFileSync(
      driver,
      `
        const src = (file) => new URL(file, ${JSON.stringify(pathToFileURL(path.join(pkg, "src", path.sep)).href)}).href;
        const { RoutineLoader } = await import(src("host/routines/loader.ts"));
        const routine = await (await new RoutineLoader(".").load("r")).default();
        const later = [typeof (await import(src("program/runner.ts"))).ProgramRunner, typeof (await import(src("routine/invoke.ts"))).invokeRoutine];
        console.log(JSON.stringify({ routine, later }));
      `,
    );
    const { stdout } = await run(process.execPath, ["--conditions=minebot-sdk:source", driver], { cwd: ancestor });
    assert.deepEqual(JSON.parse(stdout), {
      routine: [3, "function", pathToFileURL(path.join(pkg, "src/routine/public.ts")).href],
      later: ["function", "function"],
    });
  });
});

describe("RoutineLoader: memory", () => {
  it("grows by the changed modules and the loaded graph per generation, not by the library", async () => {
    // 20 modules of 64 KiB that the graph never imports; one small module changes per generation.
    const filler = `// ${"x".repeat(64 * 1024)}\n`;
    const files: Record<string, string> = { "a.ts": `import { h } from "./helper.ts"; export default () => h;`, "helper.ts": "export const h = 1;" };
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = `export const f${i} = ${i};\n${filler}`;
    const dir = scratch(files);
    const libraryBytes = Object.values(files).reduce((sum, text) => sum + text.length, 0);
    const driver = path.join(SCRATCH, `driver${counter++}.mjs`);
    writeFileSync(
      driver,
      `
        import { writeFileSync } from "node:fs";
        const { RoutineLoader } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, "src/host/routines/loader.ts")).href)});
        const dir = ${JSON.stringify(dir)};
        const loader = new RoutineLoader(dir);
        await loader.load("a");
        gc(); gc();
        const before = process.memoryUsage().heapUsed;
        for (let g = 1; g <= 20; g++) {
          writeFileSync(dir + "/m.ts", "export const m = " + g + ";");
          await loader.load("a");
        }
        gc(); gc();
        console.log((process.memoryUsage().heapUsed - before) / 20);
      `,
    );
    const { stdout } = await run(process.execPath, ["--expose-gc", driver]);
    const perGeneration = Number(stdout);
    assert.ok(perGeneration < libraryBytes / 4, `${Math.round(perGeneration / 1024)} KiB per generation for a ${Math.round(libraryBytes / 1024)} KiB library`);
  });
});
