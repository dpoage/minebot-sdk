// Lesson provenance: which modules a lesson names, what those modules were when the lesson was written, and whether any
// has changed since. A lesson that names `move` and was written against another `move.ts` may teach a belief the module
// has since refuted; the mark tells the reader to check it before relying on it.
//
// A lesson names a module when
//   - one of its tags is the module's name (case-insensitive, the whole tag: `Move` names move, `movement` does not), or
//   - its title has the module's name as a whole word. Words are runs of letters and digits, so hyphens, dots and
//     underscores separate them: "move.to loops" names move, "movement" does not, "mineflayer-pathfinder stalls" names
//     mineflayer-pathfinder (a name of several words matches as consecutive words, and wins over the shorter names inside it).
// The modules a lesson can name are the built-in modules of the catalog and the packages the SDK depends on; the word
// `pathfinder` is an alias of mineflayer-pathfinder.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../package.ts";
import { BUILTIN_MODULES } from "../routines/index.ts";

/** The parts of the package manifest this module reads. */
const Manifest = z.object({
  version: z.string().min(1),
  dependencies: z.record(z.string(), z.string()).default({}),
});

/** A lesson's record: the package version, and the identity of each module the lesson names. */
type LessonProvenance = { sdk: string; modules: Record<string, string> };

/** A module a lesson can name. */
export interface ShippedModule {
  name: string;
  /** Other words that name the module. */
  aliases: readonly string[];
  /** The module's identity as this body ships it; undefined when it cannot be read (the module's file is gone, the package is not installed). */
  identity(): string | undefined;
}

/** What the running package ships: its version and the modules a lesson can name. */
export interface Shipped {
  sdk: string;
  modules: readonly ShippedModule[];
}

/** Words that name a package besides its own name. */
const PACKAGE_ALIASES: Readonly<Record<string, readonly string[]>> = { "mineflayer-pathfinder": ["pathfinder"] };

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The first 12 hex digits of the sha256 of the file; undefined when it cannot be read (the module's file is gone). Computed once. */
function sourceIdentity(file: string): () => string | undefined {
  let identity: string | undefined;
  let read = false;
  return () => {
    if (!read) {
      try {
        identity = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
      } catch {
        // Unreadable: nothing to compare, so no mark.
      }
      read = true;
    }
    return identity;
  };
}

/** The installed version of a package, found where Node would find it from the package root; undefined when it is not installed or unreadable. Computed once. */
function installedVersion(name: string): () => string | undefined {
  const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
  let version: string | undefined;
  let read = false;
  return () => {
    if (!read) {
      for (let dir = PACKAGE_ROOT; version === undefined; dir = path.dirname(dir)) {
        try {
          const manifest: unknown = JSON.parse(readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8"));
          if (manifest !== null && typeof manifest === "object" && "version" in manifest) {
            const installed = manifest.version;
            version = typeof installed === "string" && VERSION.test(installed) ? installed : undefined;
          }
        } catch {
          // Not in this node_modules; look in the parent's.
        }
        if (path.dirname(dir) === dir) break;
      }
      read = true;
    }
    return version;
  };
}

/** What this package ships. */
export function shippedModules(): Shipped {
  const manifest = Manifest.parse(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")));
  return {
    sdk: manifest.version,
    modules: [
      ...BUILTIN_MODULES.map((module): ShippedModule => ({ name: module.name, aliases: [], identity: sourceIdentity(module.file) })),
      ...Object.keys(manifest.dependencies).map((name): ShippedModule => ({ name, aliases: PACKAGE_ALIASES[name] ?? [], identity: installedVersion(name) })),
    ],
  };
}

/** The modules a lesson with this title and these tags names, in the order the shipped list has them. */
function namedModules(shipped: Shipped, title: string, tags: readonly string[]): ShippedModule[] {
  const spellings = shipped.modules.flatMap((module) => [module.name, ...module.aliases].map((spelling) => ({ module, words: words(spelling) })));
  const named = new Set<ShippedModule>();
  for (const tag of tags) {
    const tagWords = words(tag).join(" ");
    for (const { module, words: spelling } of spellings) if (tagWords === spelling.join(" ")) named.add(module);
  }
  const longestFirst = [...spellings].sort((a, b) => b.words.length - a.words.length);
  const titleWords = words(title);
  for (let i = 0; i < titleWords.length; ) {
    const hit = longestFirst.find(({ words: spelling }) => spelling.every((word, j) => titleWords[i + j] === word));
    if (hit) named.add(hit.module);
    i += hit ? hit.words.length : 1;
  }
  return shipped.modules.filter((module) => named.has(module));
}

/** The record a lesson with this title and these tags is written with: the package version, and the identity of each module it names that has one. */
export function provenanceFor(shipped: Shipped, title: string, tags: readonly string[]): LessonProvenance {
  const modules: Record<string, string> = {};
  for (const module of namedModules(shipped, title, tags)) {
    const identity = module.identity();
    if (identity !== undefined) modules[module.name] = identity;
  }
  return { sdk: shipped.sdk, modules };
}

function mark(module: ShippedModule): string {
  return `[stale: ${module.name} changed since this lesson was written; check it against builtins docs ${module.name} before relying on it]`;
}

/**
 * One mark per module the record names whose identity now differs from the recorded one, joined by a space; undefined when none
 * does. A module whose identity cannot be read now, or that this body does not ship, is not marked: there is nothing to compare with.
 * A lesson without a record (`undefined`) has nothing to compare, so it is never marked.
 */
export function staleMarks(shipped: Shipped, provenance: LessonProvenance | undefined): string | undefined {
  if (!provenance) return undefined;
  const marks = shipped.modules.flatMap((module) => {
    const recorded = provenance.modules[module.name];
    const now = recorded === undefined ? undefined : module.identity();
    return now !== undefined && now !== recorded ? [mark(module)] : [];
  });
  return marks.length > 0 ? marks.join(" ") : undefined;
}
