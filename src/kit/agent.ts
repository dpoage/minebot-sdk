// Compiling agent kits: TypeScript source in the one shape every kit shares —
// `import { defineKit, action, z } from "minebot-sdk/kit";` then
// `export default defineKit({ ... }, { ... })` (or, as the built-in kits are written,
// `export const <name> = defineKit(...)` beside helper exports, which are ignored). The import is
// the whole authoring surface: the body binds the named imports to the real module's values and
// nothing else is injected. Types are stripped with node's own stripper, so positions survive and
// error messages point into the source the agent wrote.
import { stripTypeScriptTypes } from "node:module";
import { compileFunction } from "node:vm";
import { isKit, type Kit } from "./kit.ts";
import * as sdk from "./public.ts";

/** A kit's source failed validation. The message is safe to show the agent who wrote it. */
export class KitSourceError extends Error {}

const SDK_SPECIFIER = "minebot-sdk/kit";
const IMPORT_LINE = `import { defineKit, action, z } from "${SDK_SPECIFIER}";`;
const IMPORT_HELP = `kit source may import only named values from "${SDK_SPECIFIER}", for example: ${IMPORT_LINE}`;
const EXPORT_HELP =
  'kit source must export exactly one kit, as "export default defineKit({ ... }, { ... })" or "export const <name> = defineKit({ ... }, { ... })"; other "export const" and "export function" declarations are allowed and ignored';

const IMPORT_KEYWORD = /(?<![\w$.])import(?![\w$])/g;
const EXPORT_KEYWORD = /(?<![\w$.])export(?![\w$])/g;
const REQUIRE_CALL = /(?<![\w$.])require\s*\(/;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(["'])([^"'\n]*)\2[ \t]*;?/y;
const EXPORT_DEFAULT = /^\s*default(?![\w$])/;
const EXPORT_DECLARATION = /^\s+(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:async\s+)?function\b|class\s+[A-Za-z_$][\w$]*)/;
const NOT_DEFINED = /^(\w+) is not defined$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** The name a default export is bound to inside the compiled function. */
const DEFAULT_BINDING = "__kit";

/** The public surface's value exports, by name: what an import may bind. */
const SURFACE: Readonly<Record<string, unknown>> = sdk;

interface Binding {
  imported: string;
  local: string;
}

const REGEX_KEYWORDS: Record<string, true> = { return: true, typeof: true, case: true, in: true, of: true, delete: true, void: true, throw: true, new: true, else: true, do: true, instanceof: true, yield: true, await: true };
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

/**
 * The source with comments, string contents, template text, and regular-expression literals
 * blanked to spaces (line breaks kept, so indexes still line up), so that scans for keywords
 * see code only. Regex literals are told from division by the token before the slash, which is
 * a heuristic; `compileKit` backs these scans with a function that cannot `import()` at run time.
 */
export function maskNonCode(source: string): string {
  const out = source.split("");
  const n = source.length;
  /** Brace depth to return to for each `${` still open. */
  const interpolations: number[] = [];
  let depth = 0;
  let lastWord = "";
  let lastChar = "";
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** Blanks template text from `from`; returns where code resumes. */
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = source[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") {
        blank(from, j);
        return j + 1;
      }
      if (c === "$" && source[j + 1] === "{") {
        blank(from, j);
        interpolations.push(depth);
        return j + 2;
      }
      j++;
    }
    blank(from, n);
    return n;
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      lastChar = c;
      lastWord = "";
    } else if (c === "`") {
      i = templateText(i + 1);
      lastChar = "`";
      lastWord = "";
    } else if (c === "/") {
      const regex = lastWord === "" ? lastChar === "" || REGEX_PRECEDERS.includes(lastChar) : Object.hasOwn(REGEX_KEYWORDS, lastWord);
      if (regex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== "\n") {
          const ch = source[j];
          if (ch === "\\") j++;
          else if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          j++;
        }
        blank(i + 1, Math.min(j, n));
        i = j + 1;
        lastChar = ")";
      } else {
        i++;
        lastChar = "/";
      }
      lastWord = "";
    } else if (/[\w$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j]!)) j++;
      lastWord = source.slice(i, j);
      lastChar = source[j - 1]!;
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        if (interpolations.length > 0 && interpolations[interpolations.length - 1] === depth) {
          interpolations.pop();
          i = templateText(i + 1);
          lastChar = "`";
          lastWord = "";
          continue;
        }
        depth = Math.max(0, depth - 1);
      }
      lastChar = c;
      lastWord = "";
      i++;
    }
  }
  return out.join("");
}

/**
 * Takes the import statements out of stripped source, leaving their line breaks so error
 * positions still point into the source the agent wrote. Returns the remaining source and what
 * the imports bind. Any `import` left that is not a named import from the SDK (a dynamic
 * `import()`, `import.meta`, another specifier, a default or namespace import) is rejected.
 */
function extractImports(stripped: string): { body: string; bindings: Binding[] } {
  const masked = maskNonCode(stripped);
  const bindings: Binding[] = [];
  let body = "";
  let cursor = 0;
  for (const keyword of masked.matchAll(IMPORT_KEYWORD)) {
    if (keyword.index < cursor) continue;
    const after = masked.slice(keyword.index + "import".length).trimStart();
    if (after.startsWith("(") || after.startsWith(".")) {
      throw new KitSourceError(`kit source cannot use dynamic import(), import.meta, or require(); ${IMPORT_HELP}`);
    }
    NAMED_IMPORT.lastIndex = keyword.index;
    const statement = NAMED_IMPORT.exec(stripped);
    if (!statement) {
      const from = /\bfrom\s*["']([^"'\n]*)["']/.exec(stripped.slice(keyword.index, keyword.index + 400))?.[1];
      throw new KitSourceError(`kit source cannot ${from === undefined ? "use this import" : `import "${from}" this way`}: ${IMPORT_HELP}`);
    }
    if (statement[3] !== SDK_SPECIFIER) {
      throw new KitSourceError(`kit source cannot import "${statement[3]}": ${IMPORT_HELP}`);
    }
    for (const part of statement[1]!.split(",").map((p) => p.trim()).filter(Boolean)) {
      const [imported = "", local = imported] = part.split(/\s+as\s+/);
      if (!IDENTIFIER.test(imported) || !IDENTIFIER.test(local)) throw new KitSourceError(`unreadable import "${part}"; ${IMPORT_HELP}`);
      if (!Object.hasOwn(SURFACE, imported)) {
        throw new KitSourceError(`"${SDK_SPECIFIER}" has no export "${imported}"; it exports: ${Object.keys(SURFACE).sort().join(", ")}`);
      }
      bindings.push({ imported, local });
    }
    // The statement's line breaks stay, so error positions still point into the source the agent wrote.
    body += stripped.slice(cursor, keyword.index) + "\n".repeat(statement[0].split("\n").length - 1);
    cursor = keyword.index + statement[0].length;
  }
  return { body: body + stripped.slice(cursor), bindings };
}

/**
 * Turns the exports of a kit source into plain declarations, keeping every column: `export
 * default <expr>` binds the expression, `export const|let|var|function|class` just loses the
 * keyword. Returns the code and the names whose values the compiled function hands back.
 */
function liftExports(body: string): { code: string; returned: string[] } {
  const masked = maskNonCode(body);
  const returned: string[] = [];
  let code = "";
  let cursor = 0;
  let defaults = 0;
  for (const keyword of masked.matchAll(EXPORT_KEYWORD)) {
    const end = keyword.index + "export".length;
    const rest = masked.slice(end);
    const isDefault = EXPORT_DEFAULT.exec(rest);
    if (isDefault) {
      if (++defaults > 1) throw new KitSourceError(EXPORT_HELP);
      const span = "export".length + isDefault[0].length;
      const declaration = `const ${DEFAULT_BINDING}=`;
      code += body.slice(cursor, keyword.index) + declaration.padEnd(span, " ");
      cursor = end + isDefault[0].length;
      returned.push(`default: ${DEFAULT_BINDING}`);
      continue;
    }
    const declaration = EXPORT_DECLARATION.exec(rest);
    if (!declaration) throw new KitSourceError(EXPORT_HELP);
    if (declaration[1]) returned.push(declaration[1]);
    code += body.slice(cursor, keyword.index) + " ".repeat("export".length);
    cursor = end;
  }
  return { code: code + body.slice(cursor), returned };
}

/** Compiles kit source into a Kit, or throws KitSourceError with the reason. */
export function compileKit(source: string): Kit {
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(source);
  } catch (err) {
    throw new KitSourceError(`kit source is not valid TypeScript: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { body, bindings } = extractImports(stripped);
  if (REQUIRE_CALL.test(maskNonCode(body))) {
    throw new KitSourceError(`kit source cannot use dynamic import(), import.meta, or require(); ${IMPORT_HELP}`);
  }
  if (!bindings.some((b) => b.imported === "defineKit")) {
    throw new KitSourceError(`kit source must import defineKit from "${SDK_SPECIFIER}" (defineKit, action, and z are no longer globals): ${IMPORT_LINE}`);
  }
  const { code, returned } = liftExports(body);
  if (returned.length === 0) throw new KitSourceError(EXPORT_HELP);
  let exported: Record<string, unknown>;
  try {
    // compileFunction without importModuleDynamically: any import() that got past the scans above rejects at run time.
    const factory = compileFunction(`"use strict";${code}\nreturn { ${returned.join(", ")} };`, bindings.map((b) => b.local));
    exported = factory(...bindings.map((b) => SURFACE[b.imported])) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = NOT_DEFINED.exec(message)?.[1];
    const hint = missing !== undefined && Object.hasOwn(SURFACE, missing) ? `; import it: import { ${missing} } from "${SDK_SPECIFIER}"` : "";
    throw new KitSourceError(`kit source failed to run: ${message}${hint}`);
  }
  // The values the function returns come from the source's own exports: a kit is the one that defineKit made.
  const kits = Object.entries(exported).filter(([, value]) => isKit(value));
  if (kits.length === 0) throw new KitSourceError(EXPORT_HELP);
  if (kits.length > 1) throw new KitSourceError(`kit source exports ${kits.length} kits (${kits.map(([name]) => name).join(", ")}); ${EXPORT_HELP}`);
  return kits[0]![1] as Kit;
}
