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

/** The module specifiers a source file imports or re-exports at the top level of a line. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\b.* from ["']([^"']+)["'];$|^import ["']([^"']+)["'];$/gm)].map((m) => m[1] ?? m[2]!);
}

describe("built-in routine modules compose by import", () => {
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
