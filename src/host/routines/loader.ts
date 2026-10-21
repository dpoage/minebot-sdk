// Loads routine modules from a library directory as real ES modules, through Node's resolve and
// load hooks, registered once per process (hooks cannot be unregistered, and one set serves every
// directory). Library modules are flat `<dir>/<name>.ts` files that may import each other, the
// body's packages, and Node built-ins.
//
// A library module's bare specifiers resolve as the body package's own would (the library
// usually sits outside the package, where `vec3` or `minebot-sdk/routine` cannot be found).
// A library module's URL carries `?g=<generation>`, the hash of every library module's bytes, so
// a save anywhere in the library evaluates the whole graph again, and the bytes a URL loads are the
// bytes of its generation, not whatever the disk holds when the import happens. A module
// imported by a library module takes its importer's generation: one load is one generation,
// also for imports that run later. Modules of the body's packages have one instance per process.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PACKAGE_ROOT } from "../../package.ts";

export class RoutineNotFoundError extends Error {}

/** A routine's name, as the library names its files. */
const MODULE_FILE = /^([a-z][a-z0-9_-]{0,47})\.ts$/;

/** One library directory: the module sources of every generation loaded so far. */
interface Library {
  /** `file:` URL of the directory, ending in `/`. */
  readonly url: string;
  /** Generation → module name → source. */
  readonly generations: Map<string, Map<string, string>>;
}

/** Library directories by real path. */
const libraries = new Map<string, Library>();

/** The body package's manifest: where bare specifiers of library modules are resolved from. */
const PACKAGE_MANIFEST = pathToFileURL(path.join(PACKAGE_ROOT, "package.json")).href;

/** The library a module URL belongs to, with its generation: the innermost directory that holds it. */
function libraryOf(url: string | undefined): { library: Library; generation: string | undefined } | undefined {
  if (url === undefined) return undefined;
  let found: Library | undefined;
  for (const library of libraries.values()) {
    if (url.startsWith(library.url) && (found === undefined || library.url.length > found.url.length)) found = library;
  }
  if (!found) return undefined;
  const generation = /\?g=([0-9a-f]+)$/.exec(url)?.[1];
  return { library: found, generation };
}

/** A specifier that names a file by path or URL, rather than a package, a built-in, or another kind of URL. */
function isFileSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = libraryOf(context.parentURL);
    if (!parent) return nextResolve(specifier, context);
    if (!isFileSpecifier(specifier)) {
      // `node:os` and other URLs resolve alone; a package name (or a built-in without `node:`) resolves from the body package.
      return nextResolve(specifier, /^[a-z][a-z0-9+.-]*:/i.test(specifier) ? context : { ...context, parentURL: PACKAGE_MANIFEST });
    }
    const resolved = nextResolve(specifier, context);
    const modules = parent.generation === undefined ? undefined : parent.library.generations.get(parent.generation);
    const target = new URL(resolved.url);
    const file = target.protocol === "file:" ? path.relative(fileURLToPath(parent.library.url), fileURLToPath(target)) : "";
    const match = MODULE_FILE.exec(file);
    if (!modules || !match || !modules.has(match[1]!)) {
      throw new Error(`routine modules may import only the library's own modules (<name>.ts next to them), packages, and Node built-ins; "${specifier}" is none of these`);
    }
    target.search = `?g=${parent.generation}`;
    return { ...resolved, url: target.href };
  },
  load(url, context, nextLoad) {
    const owner = libraryOf(url);
    if (!owner?.generation) return nextLoad(url, context);
    const name = MODULE_FILE.exec(path.relative(fileURLToPath(owner.library.url), fileURLToPath(url.replace(/\?.*$/, ""))))?.[1];
    const source = name === undefined ? undefined : owner.library.generations.get(owner.generation)?.get(name);
    if (source === undefined) throw new Error(`"${url}" is not a module of the routine library`);
    // The package.json above the library may say commonjs; a routine is always an ES module.
    return { format: "module-typescript", source, shortCircuit: true };
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
    const existing = libraries.get(this.dir);
    if (existing) {
      this.#library = existing;
    } else {
      this.#library = { url: pathToFileURL(path.join(this.dir, path.sep)).href, generations: new Map() };
      libraries.set(this.dir, this.#library);
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
    const files = readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isFile() && MODULE_FILE.test(entry.name));
    for (const entry of files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const bytes = readFileSync(path.join(this.dir, entry.name));
      hash.update(`${entry.name}\0${bytes.length}\0`).update(bytes);
      sources.set(entry.name.slice(0, -".ts".length), bytes.toString("utf8"));
    }
    if (!sources.has(name)) throw new RoutineNotFoundError(`no routine named "${name}"`);
    const generation = hash.digest("hex").slice(0, 16);
    if (!this.#library.generations.has(generation)) this.#library.generations.set(generation, sources);
    return import(`${new URL(`${name}.ts`, this.#library.url).href}?g=${generation}`);
  }
}
