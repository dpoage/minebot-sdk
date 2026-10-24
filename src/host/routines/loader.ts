// Loads routine modules from a library directory as real ES modules, through Node's resolve and
// load hooks, registered once per process (hooks cannot be unregistered, and one set serves every
// directory). Library modules are flat `<dir>/<name>.ts` files that may import each other, the
// body's packages, Node built-ins, and `data:` URLs.
//
// The hooks touch only library modules and runs: a `<dir>/<name>.ts` of a library directory, under a URL
// stamped with one of that library's generations (only this loader writes such URLs), a run under
// its own URL, and the imports such a module makes (a CommonJS package it imports is fronted by a
// facade, below); and the probes this module compiles itself, under URLs only it makes (see
// `withRequire`). Every other module — the body package, node_modules, any file in or under a
// library directory that was not loaded as a routine — resolves and loads as Node would.
//
// A library module's bare specifiers resolve as the body package's own would (the library
// usually sits outside the package, where `vec3` or `minebot-sdk/routine` cannot be found).
// The stamp names a generation, the hash of every library module's bytes, so a save anywhere in
// the library evaluates the whole graph again, and the bytes a URL loads are the bytes of its
// generation, not whatever the disk holds when the import happens. A module imported by a library
// module takes its importer's generation: one load is one generation, also for imports that run
// later. Modules of the body's packages have one instance per process.
//
// Node code written against the body packages' documentation works in a library module: a
// package that is CommonJS imports by name (`import { goals } from "mineflayer-pathfinder"`, which
// Node accepts only for the names it can read off the source), and `require` is bound to a
// `createRequire` anchored where the module's bare specifiers resolve, unless the module has a
// binding of that name of its own.
//
// The hook refuses a bare `minebot-sdk/routines/<module>` specifier (import or `require`), in a library module or a run, for a built-in routine
// module the body does not offer (the body sets the offer once, process-wide, with `setOfferGate`). The refusal is a courtesy
// to an agent, not a boundary: a %-encoded subpath (`minebot-sdk/routines/inv%65ntory`) or a `createRequire` anchored in the
// package reaches the module.
//
// A run (`RoutineLoader.run`) is a module of its own, evaluated once per run, whose imports resolve
// as a library module's do: `./<name>.ts` is the library's module of that name at the library's
// generation when the run starts, and any other path or URL (an absolute path or a `file:` URL
// too, whatever it names) is refused. A run never changes a generation: its text is kept apart
// from the library's, under a URL no library module has (`<dir>/.run.ts` with a query of its own;
// the hooks serve it, and its imports, like a library module's). A body without a library has runs
// too, which import packages, Node built-ins and `data:` URLs, and no file.
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, findPackageJSON, registerHooks, type ResolveFnOutput } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../package.ts";
import { moduleName, readModule } from "./library.ts";

export class RoutineNotFoundError extends Error {}

/** One library directory: the module texts of every generation loaded so far. */
interface Library {
  /** The directory's `file:` URL, ending in `/`: the key of `libraries`. */
  readonly url: string;
  /** Generation → module name → the text the load hook serves. Generations share the text of a module whose bytes they share. */
  readonly generations: Map<string, Map<string, string>>;
  /** The text the load hook serves for every module loaded so far (see `withRequire`), by the hash of its bytes. */
  readonly texts: Map<string, Promise<string>>;
}

/** Where a module the hooks serve imports its relative specifiers from: a library at one of its generations. A run on a body without a library has none. */
interface Home {
  library: Library;
  generation: string;
}

/** A module the hooks serve: its text, and the library its imports are modules of. */
interface Served {
  source: string;
  home: Home | undefined;
}

/** The file name every run has in its directory; no routine can be named so, and each run's URL has a query of its own. */
const RUN_FILE = ".run.ts";

/** The runs of this process by URL, each with the text the load hook serves for it. */
const runs = new Map<string, Served>();
let runCount = 0;

/** Library directories by the `file:` URL of their real path, ending in `/`. */
const libraries = new Map<string, Library>();

/** The body package's manifest: where bare specifiers of library modules are resolved from. */
const PACKAGE_MANIFEST = pathToFileURL(path.join(PACKAGE_ROOT, "package.json")).href;

/** The query parameter of a library module's URL that names its generation. */
const STAMP = "g";

/** `url` stamped with `generation`, replacing any query it had. */
function stamped(url: URL, generation: string): string {
  url.search = `?${STAMP}=${generation}`;
  return url.href;
}

/** The module `url` names (a library module or a run), or undefined when it names any other module (see the top of this file). */
function moduleOf(url: string | undefined): Served | undefined {
  if (url === undefined) return undefined;
  const run = runs.get(url);
  if (run) return run;
  if (!url.startsWith("file:") || !url.includes("?")) return undefined;
  const parsed = new URL(url);
  const generation = parsed.searchParams.get(STAMP);
  if (generation === null) return undefined;
  const library = libraries.get(new URL(".", parsed).href);
  const name = moduleName(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
  const source = name === undefined ? undefined : library?.generations.get(generation)?.get(name);
  return library === undefined || source === undefined ? undefined : { source, home: { library, generation } };
}

/** The error for a relative specifier that names no module of the importer's library. */
function refusal(specifier: string): Error {
  return new Error(`routine modules may import only the library's own modules (<name>.ts next to them), packages, Node built-ins, and data: URLs; "${specifier}" is none of these`);
}

/** A specifier that names a file by path or URL, rather than a package, a built-in, or another kind of URL. */
function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
}

/** Whether a library module or a run may import a bare specifier; unset (before a body is built) allows every one. Process-wide: one body runs in a host process. */
let offerGate: ((specifier: string) => boolean) | undefined;

/** Sets which bare specifiers library modules and runs may import: the body's offer of built-in routine modules, which are `minebot-sdk/routines/<module>`. */
export function setOfferGate(gate: (specifier: string) => boolean): void {
  offerGate = gate;
}

/** Throws, naming `specifier`, when the offer gate refuses it. */
function checkOffered(specifier: string): void {
  if (offerGate !== undefined && !offerGate(specifier)) throw new Error(`routine modules may not import "${specifier}": this body does not offer that built-in routine module`);
}

/** The specifier of the import `withRequire` appends; the resolve hook answers it, for library modules and runs only, with this module. */
const REQUIRE_SPECIFIER = "minebot:require";

/**
 * The `require` of a library module: Node's, anchored where the module's bare specifiers resolve, so
 * `require("vec3")` is the instance `import "vec3"` gives, and a built-in is the one with or without `node:`.
 * A path is refused: the library's modules import one another, and a `require` anchored at the
 * package would take a path to a file of the body package.
 */
export const routineRequire: NodeJS.Require = (() => {
  const base = createRequire(PACKAGE_MANIFEST);
  const named = (id: string): string => {
    if (isFileSpecifier(id)) throw new Error(`routine modules may require only packages and Node built-ins (library modules import each other with import); "${id}" is neither`);
    checkOffered(id);
    return id;
  };
  const resolve = Object.assign((id: string, options?: { paths?: string[] }) => base.resolve(named(id), options), { paths: (request: string) => base.resolve.paths(request) });
  return Object.assign((id: string) => base(named(id)), base, { resolve });
})();

/** The line `withRequire` appends: it binds `require`, and moves no line or column of the module before it. An import is hoisted, so the binding is live from the module's first statement. */
const REQUIRE_IMPORT = `\nimport { routineRequire as require } from "${REQUIRE_SPECIFIER}";\n`;

/** The text of each probe `withRequire` is compiling, by its URL. */
const probes = new Map<string, string>();

/** What the resolve hook throws for every import a probe makes: the probe parsed, and it is never linked or evaluated. */
const PROBE_PARSED = new Error("the probe parsed");

/**
 * The text the load hook serves for a library module of source `source`: `source` with `REQUIRE_IMPORT`
 * after it when the module has no binding named `require` at module scope, else `source` alone. The
 * engine decides, on the text it will run: the probe is that text, typed as a routine is, and it
 * parses exactly when nothing at module scope collides with the import's binding (any declaration
 * form, after types are stripped). A probe that fails for any other reason fails as the module itself
 * would, which then gets its own text, so the import never changes whether a module loads.
 */
async function withRequire(source: string): Promise<string> {
  const text = `${source}${REQUIRE_IMPORT}`;
  const url = `minebot:require-probe/${randomUUID()}`;
  probes.set(url, text);
  try {
    return (await import(url).catch((error: unknown) => error)) === PROBE_PARSED ? text : source;
  } finally {
    probes.delete(url);
  }
}

/** The URL suffix of a facade (see `facadeSource`), which names no module of a library. */
const FACADE_QUERY = "?minebot-named-exports";

/** The facades the resolve hook has answered with, by URL, each with the URL of the CommonJS module it fronts. Only these URLs are served as facades. */
const facades = new Map<string, string>();

/** Whether `resolved`, the body's resolution of a package a library module imports, is a CommonJS file. Node resolves a type-less `.js` file's format only when it loads it, so the answer follows its rules. */
const commonJs = new Map<string, boolean>();
function isCommonJs(resolved: ResolveFnOutput): boolean {
  if (!resolved.url.startsWith("file:")) return false;
  if (resolved.format === "commonjs") return true;
  if (resolved.format) return false;
  let known = commonJs.get(resolved.url);
  if (known === undefined) {
    const file = fileURLToPath(resolved.url);
    const extension = path.extname(file);
    const manifest = findPackageJSON(resolved.url);
    const manifestType: unknown = manifest === undefined ? undefined : JSON.parse(readFileSync(manifest, "utf8")).type;
    const type = typeof manifestType === "string" ? manifestType : undefined;
    if (extension === ".cjs") known = true;
    else if (extension !== ".js" && extension !== "") known = false;
    else if (type !== undefined) known = type === "commonjs";
    else known = parsesAsCommonJs(readFileSync(file, "utf8"));
    commonJs.set(resolved.url, known);
  }
  return known;
}

/** Whether `source` parses as the body of a CommonJS module, which Node's detection of a type-less `.js` file asks of it before it takes it for ES. */
function parsesAsCommonJs(source: string): boolean {
  try {
    new Function("exports", "require", "module", "__filename", "__dirname", source.replace(/^#!.*/, ""));
    return true;
  } catch {
    return false;
  }
}

/**
 * The ES module that fronts the CommonJS module `real` for library modules. Node gives such a module
 * the named exports it can find in its source and no others (`goals` of `mineflayer-pathfinder` is
 * assigned in a way it cannot read); the facade also exports every own enumerable key the module has
 * once it is loaded, as the value that key has when the facade is evaluated. Its default export is
 * `module.exports`, as Node's is. The facade re-exports the module's own names first, so every name
 * Node would have found stays; the facade's own exports take precedence over them.
 */
function facadeSource(real: string): string {
  const exported: unknown = createRequire(PACKAGE_MANIFEST)(fileURLToPath(real));
  const keys = typeof exported === "object" && exported !== null || typeof exported === "function" ? Object.keys(exported) : [];
  const from = JSON.stringify(real);
  const lines = [`import cjs from ${from};`, `export * from ${from};`, "export default cjs;", 'export { cjs as "module.exports" };'];
  keys
    .filter((key) => key !== "default" && key !== "module.exports" && key.isWellFormed())
    .forEach((key, index) => lines.push(`const key${index} = cjs[${JSON.stringify(key)}]; export { key${index} as ${JSON.stringify(key)} };`));
  return lines.join("\n");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === import.meta.url && (probes.has(specifier) || runs.has(specifier))) return { url: specifier, format: "module-typescript", shortCircuit: true };
    if (context.parentURL !== undefined && probes.has(context.parentURL)) throw PROBE_PARSED;
    const parent = moduleOf(context.parentURL);
    if (!parent) return nextResolve(specifier, context);
    if (specifier === REQUIRE_SPECIFIER) return nextResolve(import.meta.url, context);
    if (!isFileSpecifier(specifier)) {
      checkOffered(specifier);
      // `node:os` and other URLs resolve alone; a package name (or a built-in without `node:`) resolves from the body package.
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return nextResolve(specifier, context);
      const resolved = nextResolve(specifier, { ...context, parentURL: PACKAGE_MANIFEST });
      if (!isCommonJs(resolved)) return resolved;
      const url = `${resolved.url}${FACADE_QUERY}`;
      facades.set(url, resolved.url);
      return { ...resolved, url, format: "module" };
    }
    const { home } = parent;
    if (!home) throw new Error(`"${specifier}" imports a file, and this body has no routine library: a run here imports no file by path or file: URL`);
    // A run names a library module as `./<name>.ts`; an absolute path or a URL, even into the library, is refused. Any path or URL that leaves the importer's directory is refused whether or not a file is there.
    if (!isInLibrary(specifier, context.parentURL!, home.library) || (runs.has(context.parentURL!) && !specifier.startsWith("."))) throw refusal(specifier);
    const resolved = nextResolve(specifier, context);
    // Only a file of the importer's library and generation is a module of it.
    const url = stamped(new URL(resolved.url), home.generation);
    if (moduleOf(url)?.home?.library !== home.library) throw refusal(specifier);
    return { ...resolved, url };
  },
  load(url, context, nextLoad) {
    const probe = probes.get(url);
    if (probe !== undefined) return { format: "module-typescript", source: probe, shortCircuit: true };
    const real = facades.get(url);
    if (real !== undefined) return { format: "module", source: facadeSource(real), shortCircuit: true };
    const module = moduleOf(url);
    if (!module) return nextLoad(url, context);
    // The package.json above the library may say commonjs; a routine is always an ES module.
    return { format: "module-typescript", source: module.source, shortCircuit: true };
  },
});

/** Whether `specifier`, imported from `parentURL`, names a file in the directory of `library`. */
function isInLibrary(specifier: string, parentURL: string, library: Library): boolean {
  try {
    return new URL(".", new URL(specifier, parentURL)).href === library.url;
  } catch {
    return false;
  }
}

/**
 * What `RoutineLoader.run` says of a source with a top-level `return`, which only a function body may have. Only the run's own
 * parse error is explained: Node opens the stack of a module's parse error with that module's URL (`<url>:<line>`), so a
 * library module's parse error, and a SyntaxError the run's code throws or causes (`JSON.parse`), are left as they are.
 */
function explainReturn(err: unknown, url: string): unknown {
  if (err instanceof SyntaxError && err.stack?.startsWith(`${url}:`) && /return statement/i.test(err.message)) {
    err.message = `a run is a module, so its source cannot return: write the result as \`export default <value>\`, or \`export default async (ctx, args) => <value>\` (${err.message})`;
  }
  return err;
}

/**
 * What `RoutineLoader.run` says of a source with a static `import` declaration inside a function or
 * block, which only the module's top level may hold. The same scope rule as `explainReturn`: only the
 * run's own parse error, whose stack Node opens with the run's URL. The parser blames an `export`
 * inside a function with the same message, so the statement the frame points at is read before
 * anything is explained, and the hint is a drop-in: written where the declaration is, the source
 * parses and binds every name the declaration bound, the declaration's import attributes carried
 * into the dynamic form. What is not an import declaration, or does not so rewrite, is left as the
 * parser said it, rather than given a hint that may be wrong.
 */
function explainImport(err: unknown, url: string, source: string): unknown {
  if (!(err instanceof SyntaxError) || !err.stack?.startsWith(`${url}:`) || !/cannot be used outside of module code/i.test(err.message)) return err;
  const line = Number(/^:(\d+)/.exec(err.stack.slice(url.length))?.[1]);
  const lines = source.split("\n");
  const frames = err.stack.split("\n");
  const caret = frames.findIndex((frame) => /^\s*\^/.test(frame));
  const column = caret === -1 ? 0 : sourceColumn(lines[line - 1] ?? "", frames[caret] ?? "");
  if (column === -1) return err;
  // The declaration may run over lines; this is its text, from where the parser points, with comments
  // blanked (strings respected) so text the parser never saw cannot be read for a clause, a specifier, or an attribute.
  const statement = withoutComments(lines.slice(line - 1).join("\n").slice(column));
  if (/^import\s+type\b/.test(statement)) {
    err.message = `a run's import declarations go at the top of its module, above \`export default\`: line ${line} has \`import type\` inside a function; a type-only import runs no code, so delete it or move it above \`export default\` (${err.message})`;
    return err;
  }
  const from = /^import\s+([\s\S]*?)\s*\bfrom\s*(['"])([^'"\n]*)\2([\s\S]*)/.exec(statement);
  const bare = from === null ? /^import\s*(['"])([^'"\n]*)\1([\s\S]*)/.exec(statement) : undefined;
  if (from === null && bare === null) return err;
  const binding = from === null ? "" : dynamicBinding(from[1] ?? "");
  if (binding === undefined) return err;
  const attributes = importAttributes((from?.[4] ?? bare?.[3]) ?? "");
  if (attributes === undefined) return err;
  const call = `await import(${JSON.stringify(from?.[3] ?? bare![2])}${attributes === "" ? "" : `, ${attributes}`})`;
  const dynamic = binding === "" ? call : `const ${binding} = ${call}`;
  err.message = `a run's import declarations go at the top of its module, above \`export default\`: line ${line} has one inside a function; inside the function write \`${dynamic}\` instead (${err.message})`;
  return err;
}

/**
 * The column the parser's caret points at on the line it names. Its index in the code frame's caret
 * line is a display column — the frame draws a tab as spaces up to the next fourth column, and an
 * East Asian wide code point two columns wide — so the line is walked with those widths back onto
 * its own columns. -1 when the caret points where the line does not reach: the frame was drawn
 * crooked, and nothing is explained from it.
 */
function sourceColumn(line: string, caret: string): number {
  const target = caret.indexOf("^");
  let index = 0;
  let width = 0;
  while (width < target && index < line.length) {
    const code = line.codePointAt(index) ?? 0;
    if (line[index] === "\t") width = Math.ceil((width + 1) / 4) * 4;
    else width += isWide(code) ? 2 : 1;
    index += code > 0xffff ? 2 : 1;
  }
  return width === target ? index : -1;
}

/** Whether the code frame draws `code`, a code point, two columns wide: the East Asian wide and fullwidth blocks, emoji, and the CJK extension planes. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6b) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * `statement` with every comment outside a string replaced by a space: the declaration's own syntax
 * is untouched (an import's strings hold names and specifiers, never comments, so quotes alone are
 * tracked), while a comment can no longer be read for a clause, a specifier, or an attribute, nor
 * cut the declaration short of its `from`.
 */
function withoutComments(statement: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < statement.length; index++) {
    const ch = statement[index]!;
    if (quote !== "") {
      out += ch;
      if (ch === "\\") out += statement[++index] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "/" && statement[index + 1] === "*") {
      const end = statement.indexOf("*/", index + 2);
      index = (end === -1 ? statement.length : end + 2) - 1;
      out += " ";
    } else if (ch === "/" && statement[index + 1] === "/") {
      const end = statement.indexOf("\n", index + 2);
      index = (end === -1 ? statement.length : end) - 1;
      out += " ";
    } else out += ch;
  }
  return out;
}

/**
 * The second argument that carries the declaration's import attributes into its dynamic form: the
 * `with` clause's entries, verbatim — `with { type: "json" }` becomes `{ with: { type: "json" } }`.
 * "" when the declaration has none. undefined when it cannot be carried: an `assert` clause (a
 * dynamic import takes none), entries that are not a plain `name: "value"` list, or a `__proto__`
 * key (an object literal writes it to the prototype, not a property, so nothing would be carried).
 */
function importAttributes(rest: string): string | undefined {
  const head = /^\s*(with|assert)\s*/.exec(rest);
  if (head === null) return "";
  const tail = rest.slice(head[0].length);
  if (!tail.startsWith("{")) return head[1] === "assert" ? "" : undefined;
  if (head[1] === "assert") return undefined;
  const block = bracedBlock(tail);
  if (block === undefined) return undefined;
  const entries: string[] = [];
  for (const entry of splitCommas(block.slice(1, -1))) {
    const each = attributeEntry.exec(entry.trim());
    if (each === null) return undefined;
    if (each[1] === "__proto__" || each[1] === '"__proto__"' || each[1] === "'__proto__'") return undefined;
    entries.push(`${each[1]}: ${each[2]}`);
  }
  return entries.length === 0 ? undefined : `{ with: { ${entries.join(", ")} } }`;
}

/** The brace block from its `{` to the `}` that closes it, strings respected; undefined when it never closes. */
function bracedBlock(fromOpen: string): string | undefined {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < fromOpen.length; index++) {
    const ch = fromOpen[index]!;
    if (quote !== "") {
      if (ch === "\\") index++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return fromOpen.slice(0, index + 1);
  }
  return undefined;
}

/** One entry of import attributes as the grammar allows — a name or string key, a string value — whose text the dynamic form carries verbatim. */
const attributeEntry = /^([_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')$/u;

/**
 * `list` split on the commas outside its strings and braces: the entries of an import clause (a
 * comma inside braces belongs to the named list) and of an attributes block (one inside a quoted
 * key or value belongs to the string).
 */
function splitCommas(list: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  let quote = "";
  let depth = 0;
  for (let index = 0; index < list.length; index++) {
    const ch = list[index]!;
    if (quote !== "") {
      piece += ch;
      if (ch === "\\") piece += list[++index] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      pieces.push(piece);
      piece = "";
      continue;
    }
    piece += ch;
  }
  pieces.push(piece);
  return pieces;
}

/** A binding name as the grammar allows it (a unicode letter, `$` or `_` first): text a static clause binds that the dynamic form can declare verbatim. */
const bindableName = /^[_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*$/u;
/** One element of a named list that renames: `a as b`, or a string name, which the grammar only lets rename (`"a-b" as b`). */
const aliasedName = /^([_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s+as\s+([_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*)$/u;
/** One element of a named list that TypeScript drops at runtime: `type a`, renamed or not (`type a as b`). */
const elidedName = /^type\s+[_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*(?:\s+as\s+[_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*)?$/u;
/** A namespace clause: `* as m`. */
const namespaceName = /^\* as ([_$\p{ID_Start}][_$\p{ID_Continue}\u200C\u200D]*)$/u;
/** The words no binding may take (the reserved words, and those a module's strictness reserves): a clause that names one is left unexplained rather than hinted into a broken declaration. */
const noBinding: Record<string, true> = {
  await: true, break: true, case: true, catch: true, class: true, const: true, continue: true, debugger: true, default: true,
  delete: true, do: true, else: true, enum: true, export: true, extends: true, false: true, finally: true, for: true,
  function: true, if: true, import: true, in: true, instanceof: true, new: true, null: true, return: true, super: true,
  switch: true, this: true, throw: true, true: true, try: true, typeof: true, var: true, void: true, while: true, with: true,
  yield: true, let: true, static: true, implements: true, interface: true, package: true, private: true, protected: true, public: true,
};

/** Whether `name` is a binding the dynamic form may declare: an identifier the grammar allows that no reserved word spells. */
const isBindable = (name: string): boolean => bindableName.test(name) && !Object.hasOwn(noBinding, name);

/**
 * The left side of the dynamic import that binds what a static clause binds: `* as m` is `m`, a
 * default binding is `{ default: d }`, a named list rewrites `a as b` to `a: b` and `"a-b" as b` to
 * `"a-b": b`, and a default binding with a named list or a namespace joins them (`{ default: d, a: b }`,
 * `{ default: d, ...m }`). `""` means the clause binds nothing at runtime (a bare `type` element);
 * undefined means some name does not rewrite, so no hint is printed rather than one that binds fewer
 * names than the declaration did. Comments are already blanked; a list's trailing comma binds nothing.
 */
function dynamicBinding(clause: string): string | undefined {
  const pieces = splitCommas(clause).map((piece) => piece.trim());
  if (pieces.some((piece) => piece === "")) return undefined;
  // The names a named list binds, without its braces; `""` when it binds nothing.
  const named = (braces: string): string | "" | undefined => {
    const elements = splitCommas(braces.slice(1, -1)).map((element) => element.trim());
    if (elements.length > 1 && elements[elements.length - 1] === "") elements.pop();
    const bound: string[] = [];
    for (const element of elements) {
      const renaming = aliasedName.exec(element);
      if (elidedName.test(element)) continue;
      if (renaming !== null && isBindable(renaming[2] ?? "")) bound.push(`${renaming[1]}: ${renaming[2]}`);
      else if (isBindable(element)) bound.push(element);
      else return undefined;
    }
    return bound.length > 0 ? bound.join(", ") : "";
  };
  const namespace = namespaceName.exec(pieces[0] ?? "");
  if (pieces.length === 1) {
    if (namespace !== null && isBindable(namespace[1] ?? "")) return namespace[1];
    if (isBindable(pieces[0] ?? "")) return `{ default: ${pieces[0]} }`;
    const inner = pieces[0]?.startsWith("{") ? named(pieces[0]) : undefined;
    return inner === undefined ? undefined : inner === "" ? "" : `{ ${inner} }`;
  }
  const secondNamespace = pieces.length === 2 && isBindable(pieces[0] ?? "") ? namespaceName.exec(pieces[1] ?? "") : null;
  if (secondNamespace !== null && isBindable(secondNamespace[1] ?? "")) return `{ default: ${pieces[0]}, ...${secondNamespace[1]} }`;
  const inner = pieces.length === 2 && isBindable(pieces[0] ?? "") && pieces[1]?.startsWith("{") ? named(pieces[1] ?? "") : undefined;
  return inner === undefined ? undefined : inner === "" ? `{ default: ${pieces[0]} }` : `{ default: ${pieces[0]}, ${inner} }`;
}

/** A scan of the library's bytes: the generation they make and the text each module has in it. */
interface Scan {
  generation: string;
  texts: Map<string, Promise<string>>;
}

/** Loads routines from the library in `dir`, and evaluates runs whose relative imports are the library's modules. */
export class RoutineLoader {
  /** The directory's real path; every module URL and every error frame uses it. */
  readonly dir: string;
  /** Whether `dir` is a routine library; a loader that is not has no routines to load, and its runs import packages, Node built-ins and `data:` URLs, and no file. */
  readonly library: boolean;
  readonly #library: Library | undefined;

  /** `dir` must exist. */
  constructor(dir: string, options: { library?: boolean } = {}) {
    this.dir = realpathSync(dir);
    this.library = options.library ?? true;
    if (!this.library) return;
    const url = pathToFileURL(path.join(this.dir, path.sep)).href;
    let library = libraries.get(url);
    if (!library) {
      library = { url, generations: new Map(), texts: new Map() };
      libraries.set(url, library);
    }
    this.#library = library;
  }

  /**
   * The module `<dir>/<name>.ts` as of the library's bytes now. Two loads with no byte change in
   * any library module return the same namespace; after a change, every library module the graph
   * reaches is evaluated again. A module's own evaluation errors reject the load.
   * Throws `RoutineNotFoundError` when no such module exists.
   */
  async load(name: string): Promise<unknown> {
    const library = this.#library;
    if (!library) throw new RoutineNotFoundError(`no routine named "${name}"`);
    const scan = this.#scan(library);
    if (!scan.texts.has(name)) throw new RoutineNotFoundError(`no routine named "${name}"`);
    await register(library, scan);
    return import(stamped(pathToFileURL(path.join(this.dir, `${name}.ts`)), scan.generation));
  }

  /**
   * Evaluates `source` as a module of its own, once, and resolves with its namespace: a module record
   * made for this call alone, whatever bytes it has. Its imports resolve as a library module's do, with
   * `./<name>.ts` the library's module of that name as of the library's bytes now (the generation
   * `load` would use); this changes no generation, so a later `load` returns what an earlier one did.
   * A source with a top-level `return`, or a static `import` inside a function, rejects with an error that names `export default`.
   */
  async run(source: string): Promise<unknown> {
    const library = this.#library;
    let home: Home | undefined;
    if (library) {
      const scan = this.#scan(library);
      await register(library, scan);
      home = { library, generation: scan.generation };
    }
    const url = pathToFileURL(path.join(this.dir, RUN_FILE));
    url.search = `?run=${++runCount}`;
    runs.set(url.href, { source: await withRequire(source), home });
    try {
      return await import(url.href);
    } catch (err) {
      throw explainReturn(explainImport(err, url.href, source), url.href);
    }
  }

  /** The generation the library's bytes make now, with the text of each module in it. */
  #scan(library: Library): Scan {
    const texts = new Map<string, Promise<string>>();
    const hash = createHash("sha256");
    for (const file of readdirSync(this.dir).sort()) {
      const module = moduleName(file);
      const source = module === undefined ? undefined : readModule(path.join(this.dir, file));
      if (module === undefined || source === undefined) continue;
      const digest = createHash("sha256").update(source).digest("hex");
      hash.update(`${file}\0${digest}\0`);
      // A generation holds the text every earlier generation with these bytes holds, so a save costs the changed modules only.
      let text = library.texts.get(digest);
      if (text === undefined) library.texts.set(digest, (text = withRequire(source)));
      texts.set(module, text);
    }
    return { generation: hash.digest("hex").slice(0, 16), texts };
  }
}

/** Makes the generation of `scan` known to the load hook, which serves the texts it holds. */
async function register(library: Library, { generation, texts }: Scan): Promise<void> {
  const sources = new Map(await Promise.all(Array.from(texts, async ([module, text]) => [module, await text] as const)));
  if (!library.generations.has(generation)) library.generations.set(generation, sources);
}
