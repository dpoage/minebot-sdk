// The bot host must load no built-in routine module: the bench's tier deletes the withheld modules' source
// files before the body starts (bench/tier/remove.ts), so the host's module graph has to load without them.
// The catalog loads module files lazily for this reason; the host itself never imports one, statically or
// dynamically. src/host/routines/ is the host's own loader, not src/routines/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_ROOT } from "../src/package.ts";

const HOST = path.join(PACKAGE_ROOT, "src/host");
const ROUTINES = path.join(PACKAGE_ROOT, "src/routines");
/** The catalog index names every module without evaluating one; the host reads its metadata (src/host/routines/builtins.ts). */
const CATALOG = path.join(ROUTINES, "index.ts");

/** The specifiers a file loads: static imports and re-exports, and dynamic `import()`/`require()`. */
function loaded(from: string): string[] {
  // Node's own type stripper drops exactly what node erases (`import type`), and template literals are
  // blanked: the imports in text a host module writes out are not the module's own.
  const source = stripTypeScriptTypes(readFileSync(from, "utf8")).replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``");
  return [
    ...source.matchAll(/(?:^|[;\n])\s*import\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|[;\n])\s*export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g),
    ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
}

/** True for a specifier that loads a built-in routine module: the package subpath, or a relative path to a module file. */
function routineModule(from: string, specifier: string): boolean {
  if (specifier.startsWith("minebot-sdk/routines/")) return true;
  if (!specifier.startsWith(".")) return false;
  const target = path.resolve(path.dirname(from), specifier);
  if (target === CATALOG) return false;
  return !path.relative(ROUTINES, target).startsWith("..");
}

describe("the bot host loads no built-in routine module", () => {
  it("src/host imports no module file of src/routines, statically or dynamically", () => {
    const files = readdirSync(HOST, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.join(HOST, file));
    const offenses = files.flatMap((file) =>
      loaded(file)
        .filter((specifier) => routineModule(file, specifier))
        .map((specifier) => `${path.relative(PACKAGE_ROOT, file)} imports ${specifier}`),
    );
    assert.deepEqual(offenses, [], "a withheld module's file would be missing when the body starts");
  });
});
