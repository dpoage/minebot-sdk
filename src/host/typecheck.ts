// Type-checking a routine when it is saved: the routine check types a library module as the body loads it.
// TypeScript is an optional peer dependency: without it the check is skipped and says so. It never blocks a save.
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "../package.ts";
import type { TypeCheck } from "../protocol/index.ts";
import { ROUTINE_COMPILER_OPTIONS } from "../protocol/routine-tsconfig.ts";
import { RoutineLibrary } from "./routines/library.ts";
import { checkedText, type Diagnostic, lineColumn, parseDiagnostics, refusing, renderRefusal, RUN_CHECK_FILE } from "./typecheck-run.ts";

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

/** What the compiler did with a project: passed it, could not answer, or printed diagnostics (`notRun` says why its exit was not a compile). */
type Compiled = { status: "passed" } | { status: "skipped"; reason: string } | { status: "output"; lines: string[]; notRun?: string };

/** Runs the compiler on the project in `dir`; it is killed at `timeoutMs` or when `signal` aborts, and either is a skip. */
async function compile(tsc: string, dir: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Compiled> {
  try {
    await run(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { cwd: dir, timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 });
    return { status: "passed" };
  } catch (err) {
    // promisified execFile rejects with the error of the child, carrying its output and exit code.
    const failed = err as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
    if (signal?.aborted) return { status: "skipped", reason: "the type check was aborted" };
    if (failed.killed) return { status: "skipped", reason: `the type check took longer than ${timeoutMs / 1000} s` };
    const lines = (failed.stdout ?? "").split(/\r?\n/).filter((line) => line.trim() !== "");
    const notRun = typeof failed.code !== "number" || lines.length === 0 ? `the type checker did not run: ${(failed.stderr || String(err)).trim().split(/\r?\n/)[0]}` : undefined;
    return { status: "output", lines, notRun };
  }
}

/** The line of the compiler's output that names no file (a bad option, a missing library), which means the check itself is broken. */
function globalError(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.startsWith("error TS"));
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
 * The project of the check of a routine: the routine options (shared with the workspace `minebot init`
 * writes), the Node types when they are installed, and the source entry points when the body runs from source.
 */
function routineTsconfig(file: string, nodeTypes: boolean): string {
  return JSON.stringify({
    compilerOptions: {
      ...ROUTINE_COMPILER_OPTIONS,
      types: nodeTypes ? ["node"] : [],
      // A body running from source takes the package's entry points from src/; an installed one from dist/.
      ...(import.meta.url.endsWith(".ts") && { customConditions: ["minebot-sdk:source"] }),
    },
    files: nodeTypes ? [file] : [file, REQUIRE_DECLARATION],
  });
}

/**
 * Builds the project of a check in a temporary directory and returns its real path (the caller removes
 * it): a copy of each of `modules` of the library in `dir`, the packages the body resolves, and the
 * routine options, with `entry` the file the compiler is pointed at. `entry` is a library module or, when
 * `text` is given, a file of that text the library does not have.
 */
async function buildProject(dir: string | undefined, modules: readonly string[], entry: { file: string; text?: string }): Promise<string> {
  let project = await mkdtemp(path.join(tmpdir(), "minebot-routine-check-"));
  try {
    // The compiler names each file relative to its working directory, which it knows by its real path:
    // through a symlink (a linked TMPDIR) it would print `../../<link>/<name>.ts(...)`, and the routine's
    // errors would not be recognised as the routine's.
    project = await realpath(project);
    // Copies, not links: tsc resolves a linked file's packages from where it really is, not from here.
    if (dir !== undefined) await Promise.all(modules.map((module) => copyFile(path.join(dir, `${module}.ts`), path.join(project, `${module}.ts`))));
    if (entry.text !== undefined) await writeFile(path.join(project, entry.file), entry.text);
    await linkPackages(project);
    // Without a module package scope, nodenext treats the routine as CommonJS, and it loads as ESM.
    await writeFile(path.join(project, "package.json"), '{ "type": "module" }\n');
    const nodeTypes = await access(path.join(project, "node_modules/@types/node")).then(() => true, () => false);
    if (!nodeTypes) await writeFile(path.join(project, REQUIRE_DECLARATION), REQUIRE_TYPES);
    await writeFile(path.join(project, "tsconfig.json"), routineTsconfig(entry.file, nodeTypes));
    return project;
  } catch (err) {
    await rm(project, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** The reason a check is skipped when `typescript` does not resolve. */
const NO_TYPESCRIPT = "typescript is not installed next to minebot-sdk (an optional peer dependency)";

/**
 * Type-checks routine `name` of the library in `dir`. The check sees the other library modules (so
 * `./helper.ts` resolves) and the packages the body resolves for them, and reports only the errors in
 * the routine's own file: a helper's errors belong to the helper's own check. Nothing is evaluated.
 * Never rejects: a check that cannot run is `skipped`, so it never turns a save into an error.
 */
export async function typeCheckRoutine(dir: string, name: string, signal?: AbortSignal): Promise<TypeCheck> {
  const tsc = compilerScript();
  if (!tsc) return { status: "skipped", reason: `${NO_TYPESCRIPT}; install it to type-check routines` };
  let project: string | undefined;
  try {
    const modules = new RoutineLibrary({ dir, savedBy: "typecheck" }).list().map((routine) => routine.name);
    if (!modules.includes(name)) return { status: "skipped", reason: `there is no routine "${name}" to check` };
    project = await buildProject(dir, modules, { file: `${name}.ts` });
    const compiled = await compile(tsc, project, signal, TIMEOUT_MS);
    if (compiled.status !== "output") return compiled;
    const errors = diagnosticsFor(compiled.lines, `${name}.ts`);
    if (errors.length > 0) return { status: "failed", errors };
    if (compiled.notRun) return { status: "skipped", reason: compiled.notRun };
    const global = globalError(compiled.lines);
    if (global) return { status: "skipped", reason: `the type checker failed: ${global}` };
    // Only the package's own files errored: nothing for the routine's author to fix.
    return { status: "passed" };
  } catch (err) {
    return { status: "skipped", reason: `the type check could not run: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (project) await rm(project, { recursive: true, force: true }).catch(() => {});
  }
}

/** How long the check of a run may take before it is skipped. */export const RUN_CHECK_BUDGET_MS = 3000;

/** The editor API of the installed TypeScript, or undefined when it is not installed (an optional peer dependency). */
async function warmModule(): Promise<typeof import("typescript/unstable/async") | undefined> {
  try {
    return await import("typescript/unstable/async");
  } catch {
    return undefined;
  }
}

/** The warm checker of this process: the compiler's own API, one child process, one project kept open, its run file rewritten per check. */
interface Warm {
  readonly api: import("typescript/unstable/async").API;
  readonly dir: string;
  readonly config: string;
  readonly entry: string;
  /** The library modules the project holds, by file name. */
  texts: Map<string, string>;
  /** Whether the project has been opened with the API; the first snapshot opens it, and it stays open. */
  opened: boolean;
}

/** The warm checker, opened on the first check that needs it (`null` when the API is not installed), and one check at a time: the project is one directory. */
let warm: Promise<Warm | null> | undefined;
let warmQueue: Promise<unknown> = Promise.resolve();

/** Opens the warm checker: a project like `buildProject`'s, in a directory that outlives the check. */
async function openWarm(): Promise<Warm | null> {
  const module = await warmModule();
  if (!module) return null;
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "minebot-run-check-")));
  try {
    await linkPackages(dir);
    // Without a module package scope, nodenext treats the run as CommonJS, and it loads as ESM.
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
    const nodeTypes = await access(path.join(dir, "node_modules/@types/node")).then(() => true, () => false);
    if (!nodeTypes) await writeFile(path.join(dir, REQUIRE_DECLARATION), REQUIRE_TYPES);
    await writeFile(path.join(dir, "tsconfig.json"), routineTsconfig(RUN_CHECK_FILE, nodeTypes));
    const api = new module.API();
    // The compiler child and the project live as long as this process: both go with it.
    process.once("exit", () => {
      void api.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    return { api, dir, config: path.join(dir, "tsconfig.json"), entry: path.join(dir, RUN_CHECK_FILE), texts: new Map(), opened: false };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** The warm checker, opened once per process: `null` when the API is not installed, and a failed open is retried by the next check. */
async function warmState(): Promise<Warm | null> {
  if (!warm) {
    const opening = openWarm();
    warm = opening;
    opening.catch(() => {
      if (warm === opening) warm = undefined;
    });
  }
  return warm;
}

/** The diagnostics of `text`, checked by the warm backend, for the run in `libraryDir`. */
async function warmCheck(state: Warm, libraryDir: string | undefined, text: string): Promise<Diagnostic[]> {
  const modules = new Map<string, string>();
  if (libraryDir !== undefined) {
    for (const routine of new RoutineLibrary({ dir: libraryDir, savedBy: "typecheck" }).list()) {
      modules.set(`${routine.name}.ts`, await readFile(path.join(libraryDir, `${routine.name}.ts`), "utf8"));
    }
  }
  const changed: string[] = [state.entry];
  const created: string[] = [];
  const deleted: string[] = [];
  for (const [file, source] of modules) {
    if (state.texts.get(file) === source) continue;
    await writeFile(path.join(state.dir, file), source);
    (state.texts.has(file) ? changed : created).push(path.join(state.dir, file));
  }
  for (const file of state.texts.keys()) {
    if (modules.has(file)) continue;
    await rm(path.join(state.dir, file), { force: true });
    deleted.push(path.join(state.dir, file));
  }
  state.texts = new Map(modules);
  await writeFile(state.entry, text);
  const snapshot = await state.api.updateSnapshot(state.opened ? { fileChanges: { changed, created, deleted } } : { openProjects: [state.config] });
  state.opened = true;
  try {
    const project = snapshot.getProject(state.config);
    if (!project) throw new Error("the compiler did not open the run's project");
    const found = [
      ...(await project.program.getSyntacticDiagnostics(state.entry)),
      ...(await project.program.getSemanticDiagnostics(state.entry)),
    ];
    return found.flatMap((d) => {
      if (d.fileName !== undefined && d.fileName !== state.entry) return [];
      const { line, column } = lineColumn(text, d.pos);
      return [{ line, column, code: d.code, message: (d.text ?? "").split("\n")[0]! }];
    });
  } finally {
    await snapshot.dispose().catch(() => {});
  }
}

/** The options of a run's type check: the run's abort signal and how long the check may take. */
export interface RunCheckOptions {
  /** The run's own end: once it aborts, the check answers `skipped` instead of waiting. */
  signal?: AbortSignal;
  /** How long the check may take, in milliseconds, before it is skipped. */
  budgetMs?: number;
}

/**
 * Type-checks the source of a run as the body evaluates it: a module whose imports resolve as a
 * library module's do (`libraryDir` is the library's directory, or undefined when the body has none), with
 * the parameters of its default function typed as the run calls it (`ctx` a `RoutineContext`, `args`
 * `any`). `failed.errors` are the diagnostics that refuse the run, each `line <L>:<C> <message>` at its
 * position in `source` with the real member under it when one is known; any other diagnostic leaves the
 * run to run. Nothing is evaluated.
 *
 * The warm backend (`typescript/unstable/async`, held open by the host) answers in a few hundred
 * milliseconds; it falls back to the compiler's command line when the API is not installed or fails.
 * Never rejects: a check that cannot answer within `opts.budgetMs`, or at all, or is aborted by
 * `opts.signal`, is `skipped`.
 */
export async function typeCheckRun(libraryDir: string | undefined, source: string, opts: RunCheckOptions = {}): Promise<TypeCheck> {
  const { signal } = opts;
  const budgetMs = opts.budgetMs ?? RUN_CHECK_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const tsc = compilerScript();
  if (!tsc) return { status: "skipped", reason: NO_TYPESCRIPT };
  if (/^\s*\/\/\s*@ts-nocheck\b/.test(source)) return { status: "passed" };
  if (signal?.aborted) return { status: "skipped", reason: "the type check was aborted" };
  const text = checkedText(source);
  const answered = (found: Diagnostic[]): TypeCheck => {
    const refused = refusing(found, text);
    return refused.length > 0 ? { status: "failed", errors: refused.map((d) => renderRefusal(d, text)) } : { status: "passed" };
  };
  try {
    const state = await warmState();
    if (state !== null) {
      // The check ends with the run (an abort) or the budget; a check the API is still working on settles behind the next one.
      const limit = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(deadline - Date.now(), 1))]);
      const work = serialized(() => warmCheck(state, libraryDir, text));
      return answered(await untilAborted(work, limit));
    }
  } catch {
    if (signal?.aborted) return { status: "skipped", reason: "the type check was aborted" };
    if (Date.now() >= deadline) return { status: "skipped", reason: `the type check took longer than ${budgetMs / 1000} s` };
    // A backend that cannot answer is not the run's to fix: the command line answers instead (and a check that cannot is a skip).
  }
  let project: string | undefined;
  try {
    const modules = libraryDir === undefined ? [] : new RoutineLibrary({ dir: libraryDir, savedBy: "typecheck" }).list().map((routine) => routine.name);
    project = await buildProject(libraryDir, modules, { file: RUN_CHECK_FILE, text });
    const left = deadline - Date.now();
    if (left <= 0) return { status: "skipped", reason: `the type check took longer than ${budgetMs / 1000} s` };
    const compiled = await compile(tsc, project, signal, left);
    if (compiled.status !== "output") return compiled;
    const found = parseDiagnostics(compiled.lines, RUN_CHECK_FILE);
    if (found.length === 0 && compiled.notRun) return { status: "skipped", reason: compiled.notRun };
    const global = globalError(compiled.lines);
    if (found.length === 0 && global) return { status: "skipped", reason: `the type checker failed: ${global}` };
    return answered(found);
  } catch (err) {
    return { status: "skipped", reason: `the type check could not run: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (project) await rm(project, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runs `work` after every check started before it. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = warmQueue.then(work, work);
  warmQueue = next.catch(() => {});
  return next;
}

/**
 * Closes the warm checker and removes its project. The body never calls this (its compiler child goes with the
 * process); a script or a test that will not check another run does, because the child keeps the process alive.
 * The next check opens a new one.
 */
export async function closeRunCheck(): Promise<void> {
  const opening = warm;
  warm = undefined;
  await warmQueue.catch(() => {});
  const state = await opening?.catch(() => null);
  if (state === null || state === undefined) return;
  await state.api.close().catch(() => {});
  await rm(state.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * `promise`, rejected with the reason of `limit` once it aborts — the promise itself is left to settle, so what it holds
 * (the project's file writes, one snapshot) stays one check's. Its listener is removed when either settles.
 */
function untilAborted<T>(promise: Promise<T>, limit: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  if (limit.aborted) aborted.reject(limit.reason);
  const stop = () => aborted.reject(limit.reason);
  limit.addEventListener("abort", stop, { once: true });
  const done = () => limit.removeEventListener("abort", stop);
  promise.then(done, done);
  return Promise.race([promise, aborted.promise]);
}
