// Regenerates catalog-snapshot.json, the committed snapshot of the current built-in catalog that
// test/builtin-catalog.test.ts checks the live catalog against: every module in catalog order, with
// its description, uses, and routines in declaration order, each with its description and the JSON
// Schemas of its arguments (input) and result (output, null when the routine declares none).
// Run `node --conditions=minebot-sdk:source test/fixtures/catalog/generate-snapshot.ts` after a
// change that adds, removes, renames, or rewords a routine or module, and commit the result.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { metaOf } from "../../../src/routine/define.ts";
import { BUILTIN_MODULES } from "../../../src/routines/index.ts";

const schemaOf = (schema: z.ZodType | undefined, io: "input" | "output") => (schema === undefined ? null : z.toJSONSchema(schema, { io, unrepresentable: "any" }));

const snapshot = BUILTIN_MODULES.map((module) => ({
  name: module.name,
  description: module.description,
  uses: [...module.uses],
  routines: Object.entries(module.routines).map(([name, routine]) => {
    const meta = metaOf(routine as object);
    if (meta === undefined) throw new Error(`${module.name}.${name} is not a routine value`);
    return { name, description: meta.description, args: schemaOf(meta.args, "input"), returns: schemaOf(meta.returns, "output") };
  }),
}));

writeFileSync(new URL("./catalog-snapshot.json", import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`catalog-snapshot.json: ${snapshot.length} modules, ${snapshot.reduce((count, module) => count + module.routines.length, 0)} routines`);
