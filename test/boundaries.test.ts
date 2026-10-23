import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

/** The package's own entry points as the minebot-sdk:source condition resolves them: "minebot-sdk/routine" → src/routine/public.ts. */
const SELF_EXPORTS = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { exports: Record<string, { "minebot-sdk:source"?: string } | null> }).exports;

/** The source file of the export `subpath` (`./routine`), through an exact entry or a `*` pattern (`./routines/*` → src/routines/*.ts); a `null` entry blocks the subpath. */
function exportedSource(subpath: string): string | undefined {
  if (subpath in SELF_EXPORTS) return SELF_EXPORTS[subpath]?.["minebot-sdk:source"];
  for (const [pattern, target] of Object.entries(SELF_EXPORTS)) {
    const star = pattern.indexOf("*");
    if (star < 0 || !subpath.startsWith(pattern.slice(0, star)) || !subpath.endsWith(pattern.slice(star + 1))) continue;
    return target?.["minebot-sdk:source"]?.replace("*", subpath.slice(star, subpath.length - (pattern.length - star - 1)));
  }
  return undefined;
}

/** The source file a local or self-referencing specifier (as `staticImports` returns it) loads. */
function resolveLocal(from: string, specifier: string): string {
  if (!specifier.startsWith("minebot-sdk/")) return path.resolve(path.dirname(from), specifier);
  const source = exportedSource(`./${specifier.slice("minebot-sdk/".length)}`);
  if (!source) throw new Error(`${from} imports ${specifier}, which package.json does not export under the minebot-sdk:source condition`);
  return path.resolve(ROOT, source);
}

/**
 * The specifiers of the local modules a file loads at runtime: relative paths, and the package's own
 * `minebot-sdk/...` entry points. The source is stripped with node's own type stripper first, so
 * exactly what node erases (import type, export type) drops out and everything node keeps —
 * including `export * from` — stays. Template literals are blanked first: `minebot init` writes
 * kit and test sources from them, and the imports in that text are not the module's own.
 */
function staticImports(file: string): string[] {
  const source = stripTypeScriptTypes(readFileSync(file, "utf8")).replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  const specifiers = [
    ...source.matchAll(/(?:^|[;\n])\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|[;\n])\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
  return specifiers.filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("minebot-sdk/"));
}

/** The transitive runtime closure of an entry file over local static value imports. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      queue.push(resolveLocal(file, specifier));
    }
  }
  return [...seen].map((file) => path.relative(ROOT, file)).sort();
}

/** The local modules a file imports dynamically (checked against an allowlist, not the closure). */
function dynamicImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/await\s+import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!).filter((s) => s.startsWith("."));
}

/** The bare package specifiers a file loads at runtime (`closure()` drops them): `mineflayer`, `zod`, ... but not `node:` builtins. */
function bareImports(file: string): string[] {
  const source = stripTypeScriptTypes(readFileSync(file, "utf8")).replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  const specifiers = [
    ...source.matchAll(/(?:^|[;\n])\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|[;\n])\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
  return specifiers.filter((specifier) => !/^(\.|\/|node:|minebot-sdk\/)/.test(specifier));
}

describe("package boundaries", () => {
  it("keeps the client entry inside the client modules", () => {
    const files = closure(path.join(ROOT, "src/cli.ts"));
    // The protocol index re-exports its parts; the closure must follow that into milestones.
    assert.ok(files.includes("src/protocol/schemas.ts") && files.includes("src/milestones/milestones.ts"), `closure too small: ${files.join(", ")}`);
    // The wire contract carries the milestone schema, which grades with the name matcher. `minebot init` reads the package manifest through PACKAGE_ROOT.
    const allowed = (file: string) =>
      file === "src/cli.ts" || file.startsWith("src/client/") || file.startsWith("src/protocol/") || file.startsWith("src/milestones/") || file === "src/mc/names.ts" || file === "src/package.ts";
    const outside = files.filter((file) => !allowed(file));
    assert.deepEqual(outside, [], "the client would ship or crash on body-only modules");
    // Dynamic imports are runtime-optional: only the body entry and the MCP adapter may load late.
    assert.deepEqual(dynamicImports(path.join(ROOT, "src/cli.ts")), ["./body/main.ts", "./client/mcp.ts"]);
  });

  it("keeps the verifier entry inside the grading modules", () => {
    const files = closure(path.join(ROOT, "bench/verify/check.ts"));
    const allowed = (file: string) =>
      file.startsWith("bench/verify/") || file.startsWith("src/milestones/") || file === "src/mc/names.ts";
    const outside = files.filter((file) => !allowed(file));
    assert.deepEqual(outside, [], "the verifier image would miss modules the check needs");
  });

  it("ships the client Containerfile exactly the client closure", () => {
    const containerfile = readFileSync(path.join(ROOT, "bench/images/client/Containerfile"), "utf8");
    const copied = new Set<string>();
    for (const match of containerfile.matchAll(/^COPY ((?:src\/[^\s]+)(?:\s+src\/[^\s]+)*) .+$/gm)) {
      for (const item of match[1]!.split(" ")) copied.add(item);
    }
    const closureFiles = closure(path.join(ROOT, "src/cli.ts"));
    // Directory copies cover every file under them; the test maps a copied file to its covered set.
    const covers = (item: string) => (item.endsWith(".ts") ? [item] : closureFiles.filter((file) => file.startsWith(`${item}/`)));
    const covered = new Set(copied.values());
    for (const item of copied.values()) for (const file of covers(item)) covered.add(file);
    const missing = closureFiles.filter((file) => !covered.has(file));
    assert.deepEqual(missing, [], "the client image misses modules the CLI needs at runtime");
    const extraFiles = [...copied.values()].filter((item) => item.endsWith(".ts") && !closureFiles.includes(item));
    assert.deepEqual(extraFiles, [], "the client image ships modules outside the client closure");
  });

  it("ships the verifier Containerfile exactly the verifier closure", () => {
    const containerfile = readFileSync(path.join(ROOT, "bench/images/verifier/Containerfile"), "utf8");
    const copied = new Set<string>();
    for (const match of containerfile.matchAll(/^COPY ((?:(?:src|bench)\/[^\s]+)(?:\s+(?:src|bench)\/[^\s]+)*) .+$/gm)) {
      for (const item of match[1]!.split(" ")) copied.add(item);
    }
    const closureFiles = closure(path.join(ROOT, "bench/verify/check.ts"));
    const covered = new Set<string>();
    for (const item of copied.values()) {
      if (item.endsWith(".ts")) covered.add(item);
      else for (const file of closureFiles.filter((file) => file.startsWith(`${item}/`))) covered.add(file);
    }
    const missing = closureFiles.filter((file) => !covered.has(file));
    const extraFiles = [...copied.values()].filter((item) => item.endsWith(".ts") && !closureFiles.includes(item));
    assert.deepEqual(missing, [], "the verifier image misses modules the check needs at runtime");
    assert.deepEqual(extraFiles, [], "the verifier image ships modules outside the verifier closure");
  });

  it("keeps the testing entry inside the shipped sources, with no body or client code", () => {
    const files = closure(path.join(ROOT, "src/testing/index.ts"));
    assert.ok(files.includes("src/testing/bot.ts") && files.includes("src/routine/invoke.ts"), `closure too small: ${files.join(", ")}`);
    // The harness ships in dist/, so it may load the routine runtime, and nothing that starts a body or talks to one.
    const outside = files.filter((file) => !file.startsWith("src/") || file.startsWith("src/body/") || file.startsWith("src/host/") || file.startsWith("src/client/") || file === "src/cli.ts");
    assert.deepEqual(outside, [], "the testing entry would ship or crash on body or client code");
    // It runs routines through the routine runtime's one call (invoke, and define for the metadata it reads); the bot host's routine loader and library stay out (src/host/ is refused above).
    assert.deepEqual(files.filter((file) => file.startsWith("src/routine/")), ["src/routine/define.ts", "src/routine/invoke.ts"]);
  });

  it("keeps the supervisor free of the bot host, the built-in routines, the programs, the wiki, and the Minecraft libraries", () => {
    const files = closure(path.join(ROOT, "src/body/main.ts"));
    assert.ok(files.includes("src/body/daemon.ts") && files.includes("src/body/host-process.ts") && files.includes("src/protocol/index.ts"), `closure too small: ${files.join(", ")}`);
    const hostSide = files.filter((file) => ["src/host/", "src/routines/", "src/program/", "src/wiki/"].some((dir) => file.startsWith(dir)));
    assert.deepEqual(hostSide, [], "the supervisor would load code that belongs to the bot host");
    const libraries = files.flatMap((file) =>
      bareImports(path.join(ROOT, file))
        .filter((specifier) => /^(mineflayer|prismarine|minecraft-data(\/|$)|vec3(\/|$))/.test(specifier))
        .map((specifier) => `${file} imports ${specifier}`),
    );
    assert.deepEqual(libraries, [], "the supervisor would load a Minecraft library");
  });

  it("keeps the bot host free of the supervisor", () => {
    // The host loads its world late, so this closure follows dynamic imports as well as static ones.
    const seen = new Set<string>();
    const queue = [path.join(ROOT, "src/host/main.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = stripTypeScriptTypes(readFileSync(file, "utf8")).replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
      const lazy = [...source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]!);
      for (const specifier of [...staticImports(file), ...lazy]) queue.push(resolveLocal(file, specifier));
    }
    const files = [...seen].map((file) => path.relative(ROOT, file));
    assert.ok(files.includes("src/host/world.ts") && files.includes("src/host/triggers.ts"), `closure too small: ${files.join(", ")}`);
    const supervisor = files.filter((file) => file.startsWith("src/body/")).sort();
    assert.deepEqual(supervisor, [], "the bot host would load the supervisor's modules");
  });
});
