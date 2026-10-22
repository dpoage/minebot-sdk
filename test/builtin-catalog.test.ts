import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { BUILTIN_KITS } from "../src/kit/index.ts";
import { PACKAGE_ROOT } from "../src/package.ts";
import { metaOf } from "../src/routine/define.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";

const KIT_DIR = path.join(PACKAGE_ROOT, "src/kit/kits");
const ROUTINE_DIR = path.join(PACKAGE_ROOT, "src/routines");

const schemaOf = (schema: z.ZodType | undefined, io: "input" | "output") => (schema === undefined ? undefined : z.toJSONSchema(schema, { io, unrepresentable: "any" }));

/** The module as an importer sees it: `minebot-sdk/routines/<name>`, resolved from the sources. */
const load = (name: string): Promise<Record<string, unknown>> => import(`minebot-sdk/routines/${name}`);

/** The names a module file declares with `export const <name> = defineRoutine(`, in source order. */
const declared = (name: string) => [...readFileSync(path.join(ROUTINE_DIR, `${name}.ts`), "utf8").matchAll(/^export const (\w+) = defineRoutine\(/gm)].map((m) => m[1]!);

describe("built-in routine modules against the kits they replace", () => {
  it("lists the modules in the order of the kits", () => {
    assert.deepEqual(BUILTIN_MODULES.map((m) => m.name), BUILTIN_KITS.map((k) => k.name));
    assert.equal(BUILTIN_MODULES.length, 18);
  });

  it("ships one source file per module, and no other", () => {
    assert.deepEqual(readdirSync(ROUTINE_DIR).sort(), [...BUILTIN_KITS.map((k) => `${k.name}.ts`), "index.ts"].sort());
    for (const module of BUILTIN_MODULES) {
      assert.equal(module.file, path.join(ROUTINE_DIR, `${module.name}.ts`));
      assert.ok(existsSync(module.file), module.file);
    }
  });

  for (const kit of BUILTIN_KITS) {
    it(`${kit.name}: description, uses, and every action as a routine with the kit's schemas`, async () => {
      const module = await load(kit.name);
      const entry = BUILTIN_MODULES.find((m) => m.name === kit.name)!;
      assert.equal(module.description, kit.description);
      assert.deepEqual(module.uses, [...kit.uses]);
      assert.equal(entry.description, kit.description);
      assert.deepEqual(entry.uses, [...kit.uses]);
      for (const [name, act] of Object.entries(kit.actions)) {
        const routine = module[name];
        assert.equal(typeof routine, "function", `${kit.name}.${name} is not exported`);
        const meta = metaOf(routine as object);
        assert.ok(meta, `${kit.name}.${name} is not a routine value`);
        assert.equal(meta.name, `${kit.name}.${name}`);
        assert.equal(meta.description, act.doc);
        assert.deepEqual(schemaOf(meta.args, "input"), schemaOf(act.args, "input"), `${kit.name}.${name} args`);
        assert.deepEqual(schemaOf(meta.returns, "output"), schemaOf(act.returns, "output"), `${kit.name}.${name} returns`);
        assert.equal(meta.returns === undefined, act.returns === undefined, `${kit.name}.${name} returns presence`);
        assert.equal(entry.routines[name], routine, `${kit.name}.${name} in the catalog`);
      }
    });

    it(`${kit.name}: exports exactly the kit's actions as routines, declared and cataloged in the kit's order`, async () => {
      const module = await load(kit.name);
      const actions = Object.keys(kit.actions);
      const routines = Object.entries(module).filter(([, value]) => typeof value === "function" && metaOf(value) !== undefined).map(([name]) => name);
      assert.deepEqual(routines.sort(), [...actions].sort());
      assert.deepEqual(declared(kit.name), actions);
      assert.deepEqual(Object.keys(BUILTIN_MODULES.find((m) => m.name === kit.name)!.routines), actions);
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

  for (const kit of BUILTIN_KITS) {
    it(`${kit.name}: imports only minebot-sdk/routine and built-in modules it declares in uses`, () => {
      const source = readFileSync(path.join(ROUTINE_DIR, `${kit.name}.ts`), "utf8");
      const allowed = new Set(["minebot-sdk/routine", ...kit.uses.map((use) => `minebot-sdk/routines/${use}`)]);
      for (const specifier of specifiers(source)) assert.ok(allowed.has(specifier), `${kit.name} imports ${specifier}`);
      assert.doesNotMatch(source, /\brequire\(|\bimport\(|minebot-sdk\/kit|src\/kit\//);
    });

    it(`${kit.name}: calls each built-in the kit called through ctx.kits as a direct call of that module's export`, () => {
      const calls = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => `${m[1]}.${m[2]}`).sort();
      const kitCalls = calls(readFileSync(path.join(KIT_DIR, `${kit.name}.ts`), "utf8"), /ctx\.kits\.(\w+)\.(\w+)\(/g);
      const routineCalls = calls(readFileSync(path.join(ROUTINE_DIR, `${kit.name}.ts`), "utf8"), /\b(move|sense|dig|place|inventory|craft|items|furnace|container|survival|combat|farm|bucket|gatherer|crafter|builder|explorer|social)\.(\w+)\(ctx\b/g);
      assert.deepEqual(routineCalls, kitCalls);
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
