// Type-checking a routine when it is saved: the routine check types a library module as the body loads it.
// TypeScript is an optional peer dependency: without it the check is skipped and says so. It never blocks a save.
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "../package.ts";
import type { TypeCheck } from "../protocol/index.ts";
import { RoutineLibrary } from "./routines/library.ts";

const run = promisify(execFile);

const TIMEOUT_MS = 30_000;

/** The compiler's command-line script, or undefined when `typescript` does not resolve from this package. */
function compilerScript(): string | undefined {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  } catch {
    return undefined;
  }
}

/** The diagnostics the compiler printed for `file`, each with its continuation lines. Diagnostics in other files (the package's own sources) are not the agent's to fix. */
function diagnosticsFor(lines: readonly string[], file: string): string[] {
  const diagnostics: string[][] = [];
  let mine = false;
  for (const line of lines) {
    if (/^\s/.test(line)) {
      if (mine) diagnostics.at(-1)!.push(line);
      continue;
    }
    mine = line.startsWith(`${file}(`);
    if (mine) diagnostics.push([line]);
  }
  return diagnostics.map((group) => group.join("\n"));
}

/** Runs the compiler on the project in `dir` and reads its answer for `file`. */
async function compile(tsc: string, dir: string, file: string, signal: AbortSignal | undefined): Promise<TypeCheck> {
  try {
    await run(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { cwd: dir, timeout: TIMEOUT_MS, signal, maxBuffer: 4 * 1024 * 1024 });
    return { status: "passed" };
  } catch (err) {
    // promisified execFile rejects with the error of the child, carrying its output and exit code.
    const failed = err as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
    if (signal?.aborted) return { status: "skipped", reason: "the type check was aborted" };
    if (failed.killed) return { status: "skipped", reason: `the type check took longer than ${TIMEOUT_MS / 1000} s` };
    const lines = (failed.stdout ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
    const errors = diagnosticsFor(lines, file);
    if (errors.length > 0) return { status: "failed", errors };
    if (typeof failed.code !== "number" || lines.length === 0) {
      return { status: "skipped", reason: `the type checker did not run: ${(failed.stderr || String(err)).trim().split(/\r?\n/)[0]}` };
    }
    // An error tied to no file (a bad option, a missing library) means the check itself is broken.
    const global = lines.find((line) => line.startsWith("error TS"));
    if (global) return { status: "skipped", reason: `the type checker failed: ${global}` };
    // Only the package's own files errored: nothing for the routine's author to fix.
    return { status: "passed" };
  }
}

/** Node's lookup path for a package imported from the package's own location: its `node_modules`, then each ancestor's (an installed package has its dependencies hoisted above it). */
function nodeModulesChain(): string[] {
  const chain: string[] = [];
  for (let dir = path.resolve(PACKAGE_ROOT); ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") chain.push(path.join(dir, "node_modules"));
    if (path.dirname(dir) === dir) return chain;
  }
}

/** The names in directory `dir`, or none when it does not exist. */
async function namesIn(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/**
 * Fills `<project>/node_modules` with a symlink for every package Node would find from the package's own
 * location, the nearest directory of the lookup path first, so the bare specifiers of the routines resolve
 * where the body resolves them. (`paths` cannot say this: it skips the packages' `exports` and `@types`.)
 * `minebot-sdk` itself is the package, as in Node, where a package imports itself ahead of any lookup.
 */
async function linkPackages(project: string): Promise<void> {
  const modules = path.join(project, "node_modules");
  await mkdir(modules);
  await symlink(path.resolve(PACKAGE_ROOT), path.join(modules, "minebot-sdk"), "junction");
  const linked = new Set(["minebot-sdk"]);
  const link = async (from: string, name: string) => {
    if (linked.has(name)) return;
    linked.add(name);
    await symlink(path.join(from, name), path.join(modules, name), "junction");
  };
  for (const dir of nodeModulesChain()) {
    await Promise.all(
      (await namesIn(dir)).map(async (name) => {
        if (name.startsWith(".")) return;
        if (!name.startsWith("@")) return link(dir, name);
        // A scope is a directory of packages, which the lookup path may spread over several `node_modules`.
        await mkdir(path.join(modules, name), { recursive: true });
        await Promise.all((await namesIn(path.join(dir, name))).map((member) => link(dir, `${name}/${member}`)));
      }),
    );
  }
}

/** The file name of the ambient declaration of `require` (a routine's file name has no dot, so it never names a routine). */
const REQUIRE_DECLARATION = "routine.require.d.ts";

/**
 * The `require` a routine has at run time (see the loader), declared for a project without `@types/node`,
 * which declares it otherwise: `@types/node` is a development dependency of this package, so a workspace
 * that did not install it for the body has none. As in Node's declaration, `require(id)` is `any`.
 */
const REQUIRE_TYPES = `interface RoutineRequire {
  (id: string): any;
  resolve: { (id: string, options?: { paths?: string[] }): string; paths(request: string): string[] | null };
  cache: Record<string, unknown>;
  main: unknown;
  extensions: Record<string, unknown>;
}
declare var require: RoutineRequire;
`;

/**
 * The options of the check of a routine: the ones that make the module load as the body loads it, as
 * ES TypeScript that Node only strips of types. `verbatimModuleSyntax` rejects `import { Bot } from
 * "mineflayer"` (a type imported as a value, which the runtime cannot load) and `erasableSyntaxOnly` rejects
 * enums, namespaces with code, and parameter properties.
 */
function routineTsconfig(file: string, nodeTypes: boolean): string {
  return JSON.stringify({
    compilerOptions: {
      target: "esnext",
      module: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["esnext"],
      types: nodeTypes ? ["node"] : [],
      moduleDetection: "force",
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      // A body running from source takes the package's entry points from src/; an installed one from dist/.
      ...(import.meta.url.endsWith(".ts") && { customConditions: ["minebot-sdk:source"] }),
    },
    files: nodeTypes ? [file] : [file, REQUIRE_DECLARATION],
  });
}

/**
 * Type-checks routine `name` of the library in `dir`. The check sees the other library modules (so
 * `./helper.ts` resolves) and the packages the body resolves for them, and reports only the errors in
 * the routine's own file: a helper's errors belong to the helper's own check. Nothing is evaluated.
 * Never rejects: a check that cannot run is `skipped`, so it never turns a save into an error.
 */
export async function typeCheckRoutine(dir: string, name: string, signal?: AbortSignal): Promise<TypeCheck> {
  const tsc = compilerScript();
  if (!tsc) return { status: "skipped", reason: "typescript is not installed next to minebot-sdk (an optional peer dependency); install it to type-check routines" };
  let project: string | undefined;
  try {
    const modules = new RoutineLibrary({ dir, savedBy: "typecheck" }).list().map((routine) => routine.name);
    if (!modules.includes(name)) return { status: "skipped", reason: `there is no routine "${name}" to check` };
    project = await mkdtemp(path.join(tmpdir(), "minebot-routine-check-"));
    // The compiler names each file relative to its working directory, which it knows by its real path:
    // through a symlink (a linked TMPDIR) it would print `../../<link>/<name>.ts(...)`, and the routine's
    // errors would not be recognised as the routine's.
    project = await realpath(project);
    // Copies, not links: tsc resolves a linked file's packages from where it really is, not from here.
    await Promise.all(modules.map((module) => copyFile(path.join(dir, `${module}.ts`), path.join(project!, `${module}.ts`))));
    await linkPackages(project);
    // Without a module package scope, nodenext treats the routine as CommonJS, and it loads as ESM.
    await writeFile(path.join(project, "package.json"), '{ "type": "module" }\n');
    const nodeTypes = await access(path.join(project, "node_modules/@types/node")).then(() => true, () => false);
    if (!nodeTypes) await writeFile(path.join(project, REQUIRE_DECLARATION), REQUIRE_TYPES);
    await writeFile(path.join(project, "tsconfig.json"), routineTsconfig(`${name}.ts`, nodeTypes));
    return await compile(tsc, project, `${name}.ts`, signal);
  } catch (err) {
    return { status: "skipped", reason: `the type check could not run: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (project) await rm(project, { recursive: true, force: true }).catch(() => {});
  }
}
