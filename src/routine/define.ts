import { z } from "zod";
import type { RoutineContext } from "./context.ts";

/** Registered (not local) so a second copy of the package, such as the harness's, still reads the metadata a routine's own copy attached. */
const META = Symbol.for("minebot-sdk.routine");

/** What a routine says about itself: shown to whoever calls it, and enforced when it is called. */
export interface RoutineMeta<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  description?: string;
  /** The arguments a call may pass; a call that does not match fails before the routine runs, and the routine receives the parsed value, defaults applied. */
  args?: A;
  /** What the routine returns; a result that does not match fails the call. */
  returns?: R;
}

/** A routine as a module's default export: a function of the run's context and its arguments. */
export type Routine<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> = (
  ctx: RoutineContext,
  args: z.output<A>,
) => z.input<R> | Promise<z.input<R>>;

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value && typeof value.safeParse === "function";
}

/**
 * Declares a routine: `export default defineRoutine({ description, args, returns }, async (ctx, args) => result)`.
 * A routine with no `args` receives its arguments unvalidated and unknown.
 */
export function defineRoutine<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType>(
  meta: RoutineMeta<A, R>,
  run: Routine<A, R>,
): Routine<A, R> {
  if (meta.args !== undefined && !isSchema(meta.args)) throw new Error("routine args must be a zod schema");
  if (meta.returns !== undefined && !isSchema(meta.returns)) throw new Error("routine returns must be a zod schema");
  if (typeof run !== "function") throw new Error("a routine needs a function (ctx, args) => result");
  const routine: Routine<A, R> = (ctx, args) => run(ctx, args);
  Object.defineProperty(routine, META, { value: { description: meta.description, args: meta.args, returns: meta.returns } });
  return routine;
}

/** The metadata `defineRoutine` attached; undefined for a plain function. */
export function metaOf(routine: object): RoutineMeta | undefined {
  const meta: unknown = Reflect.get(routine, META);
  return typeof meta === "object" && meta !== null ? meta : undefined;
}
