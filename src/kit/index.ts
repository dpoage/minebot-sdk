// The one kit-era module that remains: the built-in modules' names and `uses`, in the shape the benchmark's
// task generator (bench/gen-tasks.ts) reads them. Round D2 deletes it with src/audit.ts.
import { BUILTIN_MODULES } from "../routines/index.ts";

/** Every built-in module a body can offer, primitives first, with the modules each one uses. */
export const BUILTIN_KITS: readonly { name: string; uses: readonly string[] }[] = BUILTIN_MODULES.map(({ name, uses }) => ({ name, uses }));
