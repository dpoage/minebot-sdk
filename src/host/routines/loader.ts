// Loads routine modules from a library directory as real ES modules, through Node's resolve and
// load hooks, registered once per process (hooks cannot be unregistered, and one set serves every
// directory). Library modules are flat `<dir>/<name>.ts` files that may import each other, the
// body's packages, and Node built-ins.
//
// The hooks touch only library modules: a `<dir>/<name>.ts` of a library directory, under a URL
// stamped with one of that library's generations (only this loader writes such URLs), and the
// imports such a module makes. Every other module — the body package, node_modules, any file in or
// under a library directory that was not loaded as a routine — resolves and loads as Node would.
//
// A library module's bare specifiers resolve as the body package's own would (the library
// usually sits outside the package, where `vec3` or `minebot-sdk/routine` cannot be found).
// The stamp names a generation, the hash of every library module's bytes, so a save anywhere in
// the library evaluates the whole graph again, and the bytes a URL loads are the bytes of its
// generation, not whatever the disk holds when the import happens. A module imported by a library
// module takes its importer's generation: one load is one generation, also for imports that run
// later. Modules of the body's packages have one instance per process.
import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../package.ts";
import { moduleName, readModule } from "./library.ts";

export class RoutineNotFoundError extends Error {}

/** One library directory: the module sources of every generation loaded so far. */
interface Library {
  /** Generation → module name → source. Generations share the text of a module whose bytes they share. */
  readonly generations: Map<string, Map<string, string>>;
  /** Every module text loaded so far, by the hash of its bytes. */
  readonly texts: Map<string, string>;
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = moduleOf(context.parentURL);
    if (!parent) return nextResolve(specifier, context);
    if (!isFileSpecifier(specifier)) {
      // `node:os` and other URLs resolve alone; a package name (or a built-in without `node:`) resolves from the body package.
      return nextResolve(specifier, /^[a-z][a-z0-9+.-]*:/i.test(specifier) ? context : { ...context, parentURL: PACKAGE_MANIFEST });
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
    const sources = new Map<string, string>();
    const hash = createHash("sha256");
    for (const file of readdirSync(this.dir).sort()) {
      const module = moduleName(file);
      const source = module === undefined ? undefined : readModule(path.join(this.dir, file));
      if (module === undefined || source === undefined) continue;
      const digest = createHash("sha256").update(source).digest("hex");
      hash.update(`${file}\0${digest}\0`);
      // A generation holds the text every earlier generation with these bytes holds, so a save costs the changed modules only.
      let text = this.#library.texts.get(digest);
      if (text === undefined) this.#library.texts.set(digest, (text = source));
      sources.set(module, text);
    }
    if (!sources.has(name)) throw new RoutineNotFoundError(`no routine named "${name}"`);
    const generation = hash.digest("hex").slice(0, 16);
    if (!this.#library.generations.has(generation)) this.#library.generations.set(generation, sources);
    return import(stamped(pathToFileURL(path.join(this.dir, `${name}.ts`)), generation));
  }
}
