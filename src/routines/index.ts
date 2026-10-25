// The catalog of built-in routine modules, primitives first: what the body offers, documents, and searches.
// It is internal (package.json exports `./routines/index` as null); a module is imported by its own name,
// `minebot-sdk/routines/<module>`. A module's routines are listed here in the order the module declares them,
// because a module namespace enumerates alphabetically and search ranks ties by this order.
// A module whose source file is absent is not in the catalog: a benchmark body removes the files of the modules
// its tier withholds before it starts (bench/tier/remove.ts), and the catalog is then what is left.
import { existsSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../package.ts";
import type { Routine } from "../routine/define.ts";

export interface BuiltinModule {
  /** The module's name, as in `minebot-sdk/routines/<name>` and the `<name>.<routine>` call name. */
  name: string;
  description: string;
  /** The built-in modules offered together with this one (the offer is the closure of `uses`); the module imports only modules listed here. */
  uses: readonly string[];
  /** The module's routines by export name, in declaration order. */
  routines: Readonly<Record<string, Routine>>;
  /** Absolute path of the module's source file. */
  file: string;
}

/** Where the built-in modules' sources live. */
export const BUILTIN_ROUTINE_DIR = path.join(PACKAGE_ROOT, "src/routines");

interface CatalogEntry {
  name: string;
  /** Imports the module and reads its routines, in the order the entry lists them. */
  load: () => Promise<BuiltinModule>;
}

/** One catalog row: the module's name, its import, and the names of its routines in declaration order. A routine the module does not export is a type error. */
function entry<R extends string, M extends { description: string; uses: readonly string[] } & Record<R, Routine>>(name: string, load: () => Promise<M>, routines: readonly R[]): CatalogEntry {
  return {
    name,
    load: async () => {
      const module = await load();
      return { name, description: module.description, uses: module.uses, routines: Object.fromEntries(routines.map((routine) => [routine, module[routine]])), file: path.join(BUILTIN_ROUTINE_DIR, `${name}.ts`) };
    },
  };
}

/** Every built-in module, primitives first. */
const CATALOG: readonly CatalogEntry[] = [
  entry("move", () => import("./move.ts"), ["to", "stop"]),
  entry("sense", () => import("./sense.ts"), ["find", "look"]),
  entry("dig", () => import("./dig.ts"), ["dig"]),
  entry("place", () => import("./place.ts"), ["place"]),
  entry("inventory", () => import("./inventory.ts"), ["list", "count", "equip", "toss"]),
  entry("craft", () => import("./craft.ts"), ["craft", "table"]),
  entry("items", () => import("./items.ts"), ["recipes", "drops", "rename"]),
  entry("furnace", () => import("./furnace.ts"), ["smelt", "take"]),
  entry("container", () => import("./container.ts"), ["list", "deposit", "withdraw"]),
  entry("survival", () => import("./survival.ts"), ["eat", "sleep", "wake", "armor"]),
  entry("combat", () => import("./combat.ts"), ["attack", "fight", "retreat"]),
  entry("farm", () => import("./farm.ts"), ["till", "plant", "harvest", "breed"]),
  entry("bucket", () => import("./bucket.ts"), ["fill", "empty"]),
  entry("gatherer", () => import("./gatherer.ts"), ["gather", "collectDrops"]),
  entry("crafter", () => import("./crafter.ts"), ["make"]),
  entry("builder", () => import("./builder.ts"), ["materials", "build", "check"]),
  entry("explorer", () => import("./explorer.ts"), ["scan", "explore", "remember", "places", "waypoints", "travel", "surface"]),
  entry("social", () => import("./social.ts"), ["say", "waitForChat", "players", "follow", "give", "gesture", "sign", "book"]),
];

// Imported one after the other, in catalog order, so that a module's own imports of the modules it uses evaluate first.
const present: BuiltinModule[] = [];
for (const { name, load } of CATALOG) if (existsSync(path.join(BUILTIN_ROUTINE_DIR, `${name}.ts`))) present.push(await load());

/** The built-in modules a body can offer, primitives first: those of the catalog whose source file exists. */
export const BUILTIN_MODULES: readonly BuiltinModule[] = present;
