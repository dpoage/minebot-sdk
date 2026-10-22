import { z } from "zod";
import { RoutineName } from "../protocol/schemas.ts";
import type { RoutineContext } from "./context.ts";

/** Registered (not local) so a second copy of the package, such as the harness's, still reads what a routine's own copy attached. */
const DECLARED = Symbol.for("minebot-sdk.routine");

/** Registered for the same reason; the property is enumerable so `{ ...ctx, log }` keeps the observer. */
const OBSERVER = Symbol.for("minebot-sdk.routine-observer");

/** What a routine says about itself: enforced when the routine is called. */
export interface RoutineMeta<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  /** The routine's name in messages and call records, `module.routine` for a built-in; a call of a routine without one is reported as "routine". */
  name?: string;
  description?: string;
  /** The arguments a call may pass; a call that does not match fails before the routine runs, and the routine receives the parsed value, defaults applied. */
  args?: A;
  /** What the routine returns; a result that does not match fails the call. */
  returns?: R;
}

/** `args` is optional in a call exactly when the schema accepts `{}`: its keys are all optional or defaulted. */
type ArgsTuple<Input> = {} extends Input ? [args?: Input] : [args: Input];

/**
 * A routine as a module exports it: a function of the run's context and the schema's input, which
 * resolves with the schema's output. Every call, direct or through `invokeRoutine`, validates the arguments
 * (omitted arguments are `{}`) and the result.
 */
export type Routine<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> = (
  ctx: RoutineContext,
  ...args: ArgsTuple<z.input<A>>
) => Promise<z.output<R>>;

/** How a call of a routine value ended. `aborted` is whether the run's signal had fired by then. */
export type RoutineCallEnd = { ok: true } | { ok: false; message: string; aborted: boolean };

/**
 * Told of every call of a routine value made with a context that carries it: at the start, with
 * the arguments as the caller passed them, and at the end through the function it returns.
 * `name` is the routine's declared `meta.name`.
 */
export type RoutineCallObserver = (call: { routine: Routine; name?: string; args: unknown }) => (end: RoutineCallEnd) => void;

/** The context with `observer` on it, in place of any observer it carried. */
export function withObserver<C extends object>(ctx: C, observer: RoutineCallObserver): C {
  return { ...ctx, [OBSERVER]: observer };
}

/** The observer a context carries, if any. */
export function observerOf(ctx: object): RoutineCallObserver | undefined {
  const observer: unknown = Reflect.get(ctx, OBSERVER);
  return typeof observer === "function" ? (observer as RoutineCallObserver) : undefined;
}

/** Names that hold the body's own state files beside the routines' stores. */
const RESERVED_STORES: readonly string[] = ["notes", "body"];

/** Throws, naming the rule, unless `namespace` may name a routine store: a routine name that is not one of the body's own. */
export function checkStoreNamespace(namespace: string): void {
  const named = RoutineName.safeParse(namespace);
  if (!named.success) throw new Error(`ctx.store namespace ${JSON.stringify(namespace)} is not allowed: ${named.error.issues[0]?.message ?? "not a routine name"}`);
  if (RESERVED_STORES.includes(namespace)) throw new Error(`ctx.store namespace "${namespace}" is reserved for the body's own state (${RESERVED_STORES.join(" and ")}); choose another namespace`);
}

function isSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "safeParse" in value && typeof value.safeParse === "function";
}

/** What `defineRoutine` attaches: the metadata, and the validating call that `invokeRoutine` shares with a direct call. */
interface Declared {
  meta: RoutineMeta;
  call(label: string, ctx: RoutineContext, args: unknown): Promise<unknown>;
}

/**
 * Declares a routine: `export default defineRoutine({ description, args, returns }, async (ctx, args) => result)`.
 * A routine with no `args` receives its arguments unvalidated and unknown.
 */
export function defineRoutine<A extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType>(
  meta: RoutineMeta<A, R>,
  run: (ctx: RoutineContext, args: z.output<A>) => z.input<R> | Promise<z.input<R>>,
): Routine<A, R> {
  if (meta.args !== undefined && !isSchema(meta.args)) throw new Error("routine args must be a zod schema");
  if (meta.returns !== undefined && !isSchema(meta.returns)) throw new Error("routine returns must be a zod schema");
  if (typeof run !== "function") throw new Error("a routine needs a function (ctx, args) => result");

  /** Parses the arguments, runs, checks the result; `label` names the routine in the messages. */
  async function validated(label: string, ctx: RoutineContext, args: unknown): Promise<unknown> {
    let input: unknown = args === undefined ? {} : args;
    if (meta.args) {
      const parsed = meta.args.safeParse(input);
      if (!parsed.success) {
        throw new Error(`routine "${label}" arguments: ${z.prettifyError(parsed.error)}\nargs schema: ${JSON.stringify(z.toJSONSchema(meta.args, { io: "input", unrepresentable: "any" }))}`);
      }
      input = parsed.data;
    }
    const result: unknown = await run(ctx, input as z.output<A>);
    if (!meta.returns) return result;
    const valid = meta.returns.safeParse(result);
    if (!valid.success) {
      throw new Error(`routine "${label}" returned a value that does not match its returns schema: ${z.prettifyError(valid.error)}\nreturns schema: ${JSON.stringify(z.toJSONSchema(meta.returns, { io: "output", unrepresentable: "any" }))}`);
    }
    return valid.data;
  }

  /** `validated`, reported to the context's observer: one start with the raw arguments, one end. */
  async function call(label: string, ctx: RoutineContext, args: unknown): Promise<unknown> {
    const end = observerOf(ctx)?.({ routine, name: meta.name, args });
    let value: unknown;
    try {
      value = await validated(label, ctx, args);
    } catch (error) {
      end?.({ ok: false, message: error instanceof Error ? error.message : String(error), aborted: ctx.signal.aborted });
      throw error;
    }
    end?.({ ok: true });
    return value;
  }

  // The schemas the type is built from are the ones `validated` enforces, so the cast states what the call does.
  const routine = ((ctx: RoutineContext, args?: unknown) => call(meta.name ?? "routine", ctx, args)) as unknown as Routine<A, R>;
  const declared: Declared = { meta: { name: meta.name, description: meta.description, args: meta.args, returns: meta.returns }, call };
  Object.defineProperty(routine, DECLARED, { value: declared });
  return routine;
}

function declaredOf(routine: object): Declared | undefined {
  const declared: unknown = Reflect.get(routine, DECLARED);
  return typeof declared === "object" && declared !== null && "call" in declared && typeof declared.call === "function" ? (declared as Declared) : undefined;
}

/** The metadata `defineRoutine` attached; undefined for a plain function. */
export function metaOf(routine: object): RoutineMeta | undefined {
  return declaredOf(routine)?.meta;
}

/** The validating call of a routine value, which names the routine `label` in its messages; undefined for a plain function. `invokeRoutine` calls through it, so a routine validates once per call. */
export function callOf(routine: object): Declared["call"] | undefined {
  return declaredOf(routine)?.call;
}
