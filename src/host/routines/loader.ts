// Loads routine modules from a library directory as real ES modules, through Node's resolve and
// load hooks, registered once per process (hooks cannot be unregistered, and one set serves every
// directory). Library modules are flat `<dir>/<name>.ts` files that may import each other, the
// body's packages, and Node built-ins.
//
// The hooks touch only library modules: a `<dir>/<name>.ts` of a library directory, under a URL
// stamped with one of that library's generations (only this loader writes such URLs), and the
// imports such a module makes (a CommonJS package it imports is fronted by a facade, below); and
// the probes this module compiles itself, under URLs only it makes (see `withRequire`). Every other
// module — the body package, node_modules, any file in or under a library directory that was not
// loaded as a routine — resolves and loads as Node would.
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
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, findPackageJSON, registerHooks, type ResolveFnOutput } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";
import { PACKAGE_ROOT } from "../../package.ts";
import { moduleName, readModule } from "./library.ts";

export class RoutineNotFoundError extends Error {}

/** One library directory: the module texts of every generation loaded so far. */
interface Library {
  /** Generation → module name → the text the load hook serves. Generations share the text of a module whose bytes they share. */
  readonly generations: Map<string, Map<string, string>>;
  /** The text the load hook serves for every module loaded so far (see `withRequire`), by the hash of its bytes. */
  readonly texts: Map<string, Promise<string>>;
}

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

/** The library module `url` names, or undefined when it names any other module (see the top of this file). */
function moduleOf(url: string | undefined): { library: Library; generation: string; source: string } | undefined {
  if (url === undefined || !url.startsWith("file:") || !url.includes("?")) return undefined;
  const parsed = new URL(url);
  const generation = parsed.searchParams.get(STAMP);
  if (generation === null) return undefined;
  const library = libraries.get(new URL(".", parsed).href);
  const name = moduleName(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
  const source = name === undefined ? undefined : library?.generations.get(generation)?.get(name);
  return library === undefined || source === undefined ? undefined : { library, generation, source };
}

/** A specifier that names a file by path or URL, rather than a package, a built-in, or another kind of URL. */
function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
}

/** The specifier of the import `withRequire` appends; the resolve hook answers it, for library modules only, with this module. */
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
    compileFunction(source.replace(/^#!.*/, ""), ["exports", "require", "module", "__filename", "__dirname"]);
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
    if (context.parentURL === import.meta.url && probes.has(specifier)) return { url: specifier, format: "module-typescript", shortCircuit: true };
    if (context.parentURL !== undefined && probes.has(context.parentURL)) throw PROBE_PARSED;
    const parent = moduleOf(context.parentURL);
    if (!parent) return nextResolve(specifier, context);
    if (specifier === REQUIRE_SPECIFIER) return nextResolve(import.meta.url, context);
    if (!isFileSpecifier(specifier)) {
      // `node:os` and other URLs resolve alone; a package name (or a built-in without `node:`) resolves from the body package.
      if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return nextResolve(specifier, context);
      const resolved = nextResolve(specifier, { ...context, parentURL: PACKAGE_MANIFEST });
      if (!isCommonJs(resolved)) return resolved;
      const url = `${resolved.url}${FACADE_QUERY}`;
      facades.set(url, resolved.url);
      return { ...resolved, url, format: "module" };
    }
    const resolved = nextResolve(specifier, context);
    // Only a file of the importer's library and generation is a module of it; any other URL is refused below.
    const url = stamped(new URL(resolved.url), parent.generation);
    if (moduleOf(url)?.library !== parent.library) {
      throw new Error(`routine modules may import only the library's own modules (<name>.ts next to them), packages, and Node built-ins; "${specifier}" is none of these`);
    }
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

/** Loads routines from the library in `dir`. */
export class RoutineLoader {
  /** The library directory's real path; every module URL and every error frame uses it. */
  readonly dir: string;
  readonly #library: Library;

  /** `dir` must exist. */
  constructor(dir: string) {
    this.dir = realpathSync(dir);
    const url = pathToFileURL(path.join(this.dir, path.sep)).href;
    const existing = libraries.get(url);
    if (existing) {
      this.#library = existing;
    } else {
      this.#library = { generations: new Map(), texts: new Map() };
      libraries.set(url, this.#library);
    }
  }

  /**
   * The module `<dir>/<name>.ts` as of the library's bytes now. Two loads with no byte change in
   * any library module return the same namespace; after a change, every library module the graph
   * reaches is evaluated again. A module's own evaluation errors reject the load.
   * Throws `RoutineNotFoundError` when no such module exists.
   */
  async load(name: string): Promise<unknown> {
    const texts = new Map<string, Promise<string>>();
    const hash = createHash("sha256");
    for (const file of readdirSync(this.dir).sort()) {
      const module = moduleName(file);
      const source = module === undefined ? undefined : readModule(path.join(this.dir, file));
      if (module === undefined || source === undefined) continue;
      const digest = createHash("sha256").update(source).digest("hex");
      hash.update(`${file}\0${digest}\0`);
      // A generation holds the text every earlier generation with these bytes holds, so a save costs the changed modules only.
      let text = this.#library.texts.get(digest);
      if (text === undefined) this.#library.texts.set(digest, (text = withRequire(source)));
      texts.set(module, text);
    }
    if (!texts.has(name)) throw new RoutineNotFoundError(`no routine named "${name}"`);
    const generation = hash.digest("hex").slice(0, 16);
    const sources = new Map(await Promise.all(Array.from(texts, async ([module, text]) => [module, await text] as const)));
    if (!this.#library.generations.has(generation)) this.#library.generations.set(generation, sources);
    return import(stamped(pathToFileURL(path.join(this.dir, `${name}.ts`)), generation));
  }
}
