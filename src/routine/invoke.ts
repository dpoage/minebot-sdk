import { z } from "zod";
import type { RoutineContext } from "./context.ts";
import { metaOf } from "./define.ts";

/** What a module exports, for the error of one that exports no routine. */
function describeExports(module: unknown): string {
  if (typeof module !== "object" || module === null) return `the module is ${module === null ? "null" : typeof module}`;
  const others = Object.keys(module).filter((name) => name !== "default");
  if ("default" in module) return `its default export is ${module.default === null ? "null" : `of type ${typeof module.default}`}${others.length > 0 ? ` (other exports: ${others.join(", ")})` : ""}`;
  return others.length > 0 ? `it has no default export (it exports: ${others.join(", ")})` : "it exports nothing";
}

/**
 * Calls routine `name`, the default export of `module`, with `ctx` and `args`, and resolves with its
 * awaited result. Absent arguments (`undefined`) are `{}`, so a call without arguments gets the
 * schema's defaults. A routine declared with `defineRoutine` has its `args` parsed first (a mismatch
 * rejects with the schema, before the routine runs) and its result checked against `returns`
 * (the parsed value is the result); a plain function is called with the arguments unparsed.
 * Rejects when the module's default export is not a function.
 */
export async function invokeRoutine(module: unknown, name: string, ctx: RoutineContext, args: unknown): Promise<unknown> {
  const routine = typeof module === "object" && module !== null && "default" in module ? module.default : undefined;
  if (typeof routine !== "function") {
    throw new Error(`routine "${name}" must default-export a function (ctx, args) => result; ${describeExports(module)}`);
  }
  const meta = metaOf(routine);
  let input: unknown = args === undefined ? {} : args;
  if (meta?.args) {
    const parsed = meta.args.safeParse(input);
    if (!parsed.success) {
      throw new Error(`routine "${name}" arguments: ${z.prettifyError(parsed.error)}\nargs schema: ${JSON.stringify(z.toJSONSchema(meta.args, { io: "input", unrepresentable: "any" }))}`);
    }
    input = parsed.data;
  }
  const result: unknown = await routine(ctx, input);
  if (!meta?.returns) return result;
  const valid = meta.returns.safeParse(result);
  if (!valid.success) {
    throw new Error(`routine "${name}" returned a value that does not match its returns schema: ${z.prettifyError(valid.error)}\nreturns schema: ${JSON.stringify(z.toJSONSchema(meta.returns, { io: "output", unrepresentable: "any" }))}`);
  }
  return valid.data;
}
