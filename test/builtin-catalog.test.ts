import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { PACKAGE_ROOT } from "../src/package.ts";
import { metaOf } from "../src/routine/define.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";

const ROUTINE_DIR = path.join(PACKAGE_ROOT, "src/routines");

/**
 * The kits the built-in routines replaced, generated once from the kit framework at 5218f99 (the last commit
 * that had it) and committed: each kit's description, uses, and actions with their docs and argument schemas.
 * Two checks still read it: the search freeze in test/builtins.test.ts ranks the base routines over these
 * texts, and the import check below allows a module the modules its kit used.
 */
interface BaseKit {
  name: string;
  description: string;
  uses: string[];
  actions: { name: string; doc: string; args: unknown; returns: unknown }[];
  calls: string[];
}
const BASE = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "catalog", "base-5218f99.json"), "utf8")) as BaseKit[];

/**
 * The current catalog, committed as catalog-snapshot.json: every module in catalog order with its description,
 * uses, and routines in declaration order, each with its description and the JSON Schemas of the arguments
 * (input) and the result (output, null when the routine declares none). The live catalog is checked against
 * this table exactly — module and routine order included — so a change that adds, removes, renames, or
 * rewords anything updates its rows here (regenerate with
 * `node --conditions=minebot-sdk:source test/fixtures/catalog/generate-snapshot.ts`), and any unrecorded
 * difference fails.
 */
interface SnapshotRoutine {
  name: string;
  description?: string;
  args: unknown;
  returns: unknown;
}
interface SnapshotModule {
  name: string;
  description: string;
  uses: string[];
  routines: SnapshotRoutine[];
}
const SNAPSHOT = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "catalog", "catalog-snapshot.json"), "utf8")) as SnapshotModule[];

const schemaOf = (schema: z.ZodType | undefined, io: "input" | "output") => (schema === undefined ? null : z.toJSONSchema(schema, { io, unrepresentable: "any" }));

/** The module as an importer sees it: `minebot-sdk/routines/<name>`, resolved from the sources. */
const load = (name: string): Promise<Record<string, unknown>> => import(`minebot-sdk/routines/${name}`);

/** The names a module file declares with `export const <name> = defineRoutine(`, in source order. */
const declared = (name: string) => [...readFileSync(path.join(ROUTINE_DIR, `${name}.ts`), "utf8").matchAll(/^export const (\w+) = defineRoutine\(/gm)].map((m) => m[1]!);

describe("the built-in catalog against its committed snapshot", () => {
  it("keeps the base kit table intact: 18 kits, 50 actions", () => {
    // The two checks that still read the base table — the search freeze's texts and the import check's uses — break silently on a truncated or grown row, so its size is pinned.
    assert.equal(BASE.length, 18);
    assert.equal(BASE.reduce((count, kit) => count + kit.actions.length, 0), 50);
  });

  it("lists the modules of the snapshot, in its order, one source file each and no other", () => {
    assert.deepEqual(BUILTIN_MODULES.map((module) => module.name), SNAPSHOT.map((module) => module.name));
    assert.deepEqual(readdirSync(ROUTINE_DIR).sort(), [...SNAPSHOT.map((module) => `${module.name}.ts`), "index.ts"].sort());
    for (const module of BUILTIN_MODULES) {
      assert.equal(module.file, path.join(ROUTINE_DIR, `${module.name}.ts`));
      assert.ok(existsSync(module.file), module.file);
    }
  });

  for (const snap of SNAPSHOT) {
    it(`${snap.name}: description, uses, and its routines in order, each with description, args, and returns`, async () => {
      const module = await load(snap.name);
      const entry = BUILTIN_MODULES.find((candidate) => candidate.name === snap.name)!;
      const routines = Object.entries(entry.routines).map(([name, routine]) => {
        assert.equal(typeof routine, "function", `${snap.name}.${name} is not exported`);
        const meta = metaOf(routine as object);
        assert.ok(meta, `${snap.name}.${name} is not a routine value`);
        assert.equal(meta.name, `${snap.name}.${name}`);
        return { name, description: meta.description, args: schemaOf(meta.args, "input"), returns: schemaOf(meta.returns, "output") };
      });
      assert.deepEqual({ description: module.description, uses: module.uses, routines }, { description: snap.description, uses: snap.uses, routines: snap.routines }, `${snap.name}: the catalog as the snapshot records it`);
      assert.deepEqual(declared(snap.name), snap.routines.map((routine) => routine.name), `${snap.name}: the source declares them in this order`);
    });
  }
});

/** Each top-level `import`/`export ... from` statement, matched whole even when it spans lines: its clause and module specifier. */
function fromStatements(source: string): { clause: string; specifier: string }[] {
  return [...source.matchAll(/^(?:import|export)\s+([^;"'`]*?)\s*\bfrom\s*["']([^"']+)["']/gm)].map((m) => ({ clause: m[1]!, specifier: m[2]! }));
}

/** The module specifiers a source file imports or re-exports at the top level, multi-line statements included. */
function specifiers(source: string): string[] {
  return [...fromStatements(source).map((s) => s.specifier), ...[...source.matchAll(/^import\s*["']([^"']+)["']/gm)].map((m) => m[1]!)];
}

/** The names an import clause takes from its module: `{ a, type B as C }` gives a and B, a default import gives "default", a namespace import none. */
function importedNames(clause: string): string[] {
  const body = clause.replace(/^type\s+/, "");
  const named = (/\{([^}]*)\}/.exec(body)?.[1] ?? "").split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!);
  const rest = body.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\w+/, "").replace(/,/g, "").trim();
  return [...(rest === "" ? [] : ["default"]), ...named.filter((name) => name !== "")];
}

describe("built-in routine modules compose by import", () => {
  it("reads import statements that span lines, and the names they take", () => {
    const source = 'import type { A } from "x";\nimport {\n  till,\n  type B as C,\n} from "minebot-sdk/routines/farm";\nimport "y";\nimport D, * as E from "z";\n';
    assert.deepEqual(specifiers(source), ["x", "minebot-sdk/routines/farm", "z", "y"]);
    assert.deepEqual(fromStatements(source).map((s) => importedNames(s.clause)), [["A"], ["till", "B"], ["default"]]);
  });

  for (const snap of SNAPSHOT) {
    it(`${snap.name}: imports only minebot-sdk/routine and built-in modules its snapshot row declares in uses`, () => {
      const source = readFileSync(path.join(ROUTINE_DIR, `${snap.name}.ts`), "utf8");
      const allowed = new Set(["minebot-sdk/routine", ...snap.uses.map((use) => `minebot-sdk/routines/${use}`)]);
      for (const specifier of specifiers(source)) assert.ok(allowed.has(specifier), `${snap.name} imports ${specifier}`);
      assert.doesNotMatch(source, /\brequire\(|\bimport\(|minebot-sdk\/kit|src\/kit\//);
    });
  }
});

describe("built-in routine modules export only their interface", () => {
  // The helpers a module keeps exported: the names some test file imports from it by name, across lines.
  const testImports = new Map<string, Set<string>>();
  const TEST_DIR = path.join(PACKAGE_ROOT, "test");
  for (const file of readdirSync(TEST_DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
    for (const { clause, specifier } of fromStatements(readFileSync(path.join(TEST_DIR, file), "utf8"))) {
      const name = /(?:^minebot-sdk\/routines\/|\/src\/routines\/)(\w+)(?:\.ts)?$/.exec(specifier)?.[1];
      if (name === undefined || name === "index") continue;
      if (!testImports.has(name)) testImports.set(name, new Set());
      for (const imported of importedNames(clause)) testImports.get(name)!.add(imported);
    }
  }

  for (const entry of BUILTIN_MODULES) {
    it(`${entry.name}: exports description, uses, its routines, and the helpers tests import, as values and as types`, async () => {
      const allowed = [...new Set(["description", "uses", ...Object.keys(entry.routines), ...(testImports.get(entry.name) ?? [])])].sort();
      // Type exports leave no trace at run time, so the source's export statements are read too; a form this does not read fails.
      const values = new Set<string>();
      const types = new Set<string>();
      for (const line of readFileSync(entry.file, "utf8").split("\n").filter((l) => /^\s*export\b/.test(l))) {
        const m = /^export\s+(?:async\s+)?(const|let|var|function\*?|class|enum|type|interface)\s+(\w+)/.exec(line);
        assert.ok(m, `${entry.name} exports in a form this check does not read: ${line}`);
        (m[1] === "type" || m[1] === "interface" ? types : values).add(m[2]!);
      }
      assert.deepEqual([...new Set([...values, ...types])].sort(), allowed, `${entry.name}: exports in the source`);
      assert.deepEqual(Object.keys(await load(entry.name)).sort(), allowed.filter((name) => values.has(name)), `${entry.name}: exports at run time`);
    });
  }
});
