// The catalog of built-in routine modules, primitives first: what the body offers, documents, and searches.
// It is internal (package.json exports `./routines/index` as null); a module is imported by its own name,
// `minebot-sdk/routines/<module>`. A module's routines are listed here in the order the module declares them,
// because a module namespace enumerates alphabetically and search ranks ties by this order.
import path from "node:path";
import { PACKAGE_ROOT } from "../package.ts";
import type { Routine } from "../routine/define.ts";
import * as move from "./move.ts";
import * as sense from "./sense.ts";
import * as dig from "./dig.ts";
import * as place from "./place.ts";
import * as inventory from "./inventory.ts";
import * as craft from "./craft.ts";
import * as items from "./items.ts";
import * as furnace from "./furnace.ts";
import * as container from "./container.ts";
import * as survival from "./survival.ts";
import * as combat from "./combat.ts";
import * as farm from "./farm.ts";
import * as bucket from "./bucket.ts";
import * as gatherer from "./gatherer.ts";
import * as crafter from "./crafter.ts";
import * as builder from "./builder.ts";
import * as explorer from "./explorer.ts";
import * as social from "./social.ts";

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
const BUILTIN_ROUTINE_DIR = path.join(PACKAGE_ROOT, "src/routines");

function builtin(name: string, module: { description: string; uses: readonly string[] }, routines: Readonly<Record<string, Routine>>): BuiltinModule {
  return { name, description: module.description, uses: module.uses, routines, file: path.join(BUILTIN_ROUTINE_DIR, `${name}.ts`) };
}

/** Every built-in module a body can offer, primitives first. */
export const BUILTIN_MODULES: readonly BuiltinModule[] = [
  builtin("move", move, { to: move.to, stop: move.stop }),
  builtin("sense", sense, { find: sense.find, look: sense.look }),
  builtin("dig", dig, { dig: dig.dig }),
  builtin("place", place, { place: place.place }),
  builtin("inventory", inventory, { list: inventory.list, count: inventory.count, equip: inventory.equip, toss: inventory.toss }),
  builtin("craft", craft, { craft: craft.craft, table: craft.table }),
  builtin("items", items, { recipes: items.recipes, drops: items.drops }),
  builtin("furnace", furnace, { smelt: furnace.smelt, take: furnace.take }),
  builtin("container", container, { list: container.list, deposit: container.deposit, withdraw: container.withdraw }),
  builtin("survival", survival, { eat: survival.eat, sleep: survival.sleep, wake: survival.wake, armor: survival.armor }),
  builtin("combat", combat, { attack: combat.attack, fight: combat.fight, retreat: combat.retreat }),
  builtin("farm", farm, { till: farm.till, plant: farm.plant, harvest: farm.harvest, breed: farm.breed }),
  builtin("bucket", bucket, { fill: bucket.fill, empty: bucket.empty }),
  builtin("gatherer", gatherer, { gather: gatherer.gather, collectDrops: gatherer.collectDrops }),
  builtin("crafter", crafter, { make: crafter.make }),
  builtin("builder", builder, { materials: builder.materials, build: builder.build, check: builder.check }),
  builtin("explorer", explorer, { scan: explorer.scan, explore: explorer.explore, remember: explorer.remember, places: explorer.places, waypoints: explorer.waypoints, travel: explorer.travel, surface: explorer.surface }),
  builtin("social", social, { say: social.say, waitForChat: social.waitForChat, players: social.players, follow: social.follow, give: social.give }),
];
