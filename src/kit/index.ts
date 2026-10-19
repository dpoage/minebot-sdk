// Every built-in kit. One file per kit in kits/, all written with the same defineKit/action
// API an agent uses; `minebot kits source <kit>` prints the file unchanged.
import type { Kit } from "./kit.ts";
import { bucket } from "./kits/bucket.ts";
import { builder } from "./kits/builder.ts";
import { combat } from "./kits/combat.ts";
import { container } from "./kits/container.ts";
import { craft } from "./kits/craft.ts";
import { crafter } from "./kits/crafter.ts";
import { dig } from "./kits/dig.ts";
import { explorer } from "./kits/explorer.ts";
import { farm } from "./kits/farm.ts";
import { furnace } from "./kits/furnace.ts";
import { gatherer } from "./kits/gatherer.ts";
import { inventory } from "./kits/inventory.ts";
import { items } from "./kits/items.ts";
import { move } from "./kits/move.ts";
import { place } from "./kits/place.ts";
import { sense } from "./kits/sense.ts";
import { social } from "./kits/social.ts";
import { survival } from "./kits/survival.ts";

/** Every built-in kit a body can offer, primitives first. */
export const BUILTIN_KITS: readonly Kit[] = [move, sense, dig, place, inventory, craft, items, furnace, container, survival, combat, farm, bucket, gatherer, crafter, builder, explorer, social];

/** Where the built-in kits' sources live, for `kits source`. */
export const BUILTIN_KIT_DIR = new URL("./kits", import.meta.url).pathname;
