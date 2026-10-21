// Type-checking agent kit source when it is saved or tried. The check runs the TypeScript compiler
// on the source against `minebot-sdk/kit` and KitRegistry entries for the body's other kits from
// outside the package (the shipped kits are typed by the package itself), so `ctx.kits` and every
// action call are checked as `tsc` checks them in a workspace. TypeScript is an optional peer
// dependency: without it the check is skipped and says so. It never blocks a save or a try.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "../package.ts";
import { registryBlock } from "../protocol/declarations.ts";
import type { KitSchema, KitTypeCheck } from "../protocol/index.ts";

const run = promisify(execFile);

const TIMEOUT_MS = 30_000;

/** The kit surface's types: the source when the body runs from source, the declarations of the build otherwise. */
const KIT_SURFACE = import.meta.url.endsWith(".ts") ? path.join(PACKAGE_ROOT, "src/kit/public.ts") : path.join(PACKAGE_ROOT, "dist/kit/public.d.ts");

/** The compiler's command-line script, or undefined when `typescript` does not resolve from this package. */
function compilerScript(): string | undefined {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  } catch {
    return undefined;
  }
}

/** The options of the workspace `minebot init` writes, with `minebot-sdk/kit` mapped onto this package. */
function tsconfig(files: string[]): string {
  return JSON.stringify({
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // Node 24 has what esnext declares (Promise.withResolvers, which the built-in kits use).
      lib: ["esnext"],
      types: [],
      moduleDetection: "force",
      allowImportingTsExtensions: true,
      customConditions: ["minebot-sdk:source"],
      paths: { "minebot-sdk/kit": [KIT_SURFACE] },
    },
    files,
  });
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
async function compile(tsc: string, dir: string, file: string, signal: AbortSignal | undefined): Promise<KitTypeCheck> {
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
    // Only the package's own files errored: nothing for the kit's author to fix.
    return { status: "passed" };
  }
}

/**
 * Type-checks the source of kit `name`. `others` are the schemas of the kits the body offers from
 * outside the package; the kit itself is left out of them. Never rejects: a check that cannot run
 * is `skipped`, so it never turns a save or a try into an error.
 */
export async function typeCheckKit(source: string, name: string, others: readonly KitSchema[], signal?: AbortSignal): Promise<KitTypeCheck> {
  const tsc = compilerScript();
  if (!tsc) return { status: "skipped", reason: "typescript is not installed next to minebot-sdk (an optional peer dependency); install it to type-check kits" };
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "minebot-kit-check-"));
    const file = `${name}.ts`;
    const registry = others.filter((kit) => kit.name !== name);
    const files = [file];
    await writeFile(path.join(dir, file), source);
    if (registry.length > 0) {
      await writeFile(path.join(dir, "registry.d.ts"), `import type { KitRegistry } from "minebot-sdk/kit";\n${registryBlock(registry)}`);
      files.push("registry.d.ts");
    }
    // Without a module package scope, nodenext treats the kit as CommonJS, and TypeScript before 5.8 refuses its ESM import.
    await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
    await writeFile(path.join(dir, "tsconfig.json"), tsconfig(files));
    return await compile(tsc, dir, file, signal);
  } catch (err) {
    return { status: "skipped", reason: `the type check could not run: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The program log lines that report a type check: none when it passed. */
export function typeCheckLog(check: KitTypeCheck): string | undefined {
  switch (check.status) {
    case "passed":
      return undefined;
    case "failed":
      return `type errors in the kit source (it ran anyway; kits.save would save it anyway):\n${check.errors.join("\n")}`;
    case "skipped":
      return `type check skipped: ${check.reason}`;
  }
}
