import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");

/**
 * The local modules a file loads at runtime. The source is stripped with node's own type
 * stripper first, so exactly what node erases (import type, export type) drops out and
 * everything node keeps — including `export * from` — stays.
 */
function staticImports(file: string): string[] {
  const source = stripTypeScriptTypes(readFileSync(file, "utf8"));
  const specifiers = [
    ...source.matchAll(/(?:^|[;\n])\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|[;\n])\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
  ].map((match) => match[1]!);
  return specifiers.filter((specifier) => specifier.startsWith(".") || specifier.startsWith("/"));
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
      queue.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return [...seen].map((file) => path.relative(ROOT, file)).sort();
}

/** The local modules a file imports dynamically (checked against an allowlist, not the closure). */
function dynamicImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/await\s+import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!).filter((s) => s.startsWith("."));
}

describe("package boundaries", () => {
  it("keeps the client entry inside the client modules", () => {
    const files = closure(path.join(ROOT, "src/cli.ts"));
    // The protocol index re-exports its parts; the closure must follow that into milestones.
    assert.ok(files.includes("src/protocol/schemas.ts") && files.includes("src/milestones/milestones.ts"), `closure too small: ${files.join(", ")}`);
    // The wire contract carries the milestone schema, which grades with the name matcher.
    const allowed = (file: string) =>
      file === "src/cli.ts" || file.startsWith("src/client/") || file.startsWith("src/protocol/") || file.startsWith("src/milestones/") || file === "src/mc/names.ts";
    const outside = files.filter((file) => !allowed(file));
    assert.deepEqual(outside, [], "the client would ship or crash on body-only modules");
    // Dynamic imports are runtime-optional: only the body entry and the MCP adapter may load late.
    assert.deepEqual(dynamicImports(path.join(ROOT, "src/cli.ts")), ["./body/main.ts", "./client/mcp.ts"]);
  });

  it("keeps the verifier entry inside the grading modules", () => {
    const files = closure(path.join(ROOT, "bench/verify/check.ts"));
    const allowed = (file: string) =>
      file.startsWith("bench/verify/") || file === "src/audit.ts" || file.startsWith("src/milestones/") || file === "src/mc/names.ts";
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
});
