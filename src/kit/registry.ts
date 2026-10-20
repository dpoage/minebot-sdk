// The kits whose actions `ctx.kits` (and a program's `kit`) type. Every built-in kit is
// registered here by inference, so a kit's `uses` list is checked and its calls and results
// are typed without a cast. Kits a body offers beyond the built-ins join by declaration
// merging: `minebot types` writes
// `declare module "minebot-sdk/kit" { interface KitRegistry { mykit: { ... } } }`.
import type { KitApi } from "./kit.ts";
import type { bucket } from "./kits/bucket.ts";
import type { builder } from "./kits/builder.ts";
import type { combat } from "./kits/combat.ts";
import type { container } from "./kits/container.ts";
import type { craft } from "./kits/craft.ts";
import type { crafter } from "./kits/crafter.ts";
import type { dig } from "./kits/dig.ts";
import type { explorer } from "./kits/explorer.ts";
import type { farm } from "./kits/farm.ts";
import type { furnace } from "./kits/furnace.ts";
import type { gatherer } from "./kits/gatherer.ts";
import type { inventory } from "./kits/inventory.ts";
import type { items } from "./kits/items.ts";
import type { move } from "./kits/move.ts";
import type { place } from "./kits/place.ts";
import type { sense } from "./kits/sense.ts";
import type { social } from "./kits/social.ts";
import type { survival } from "./kits/survival.ts";

/** Kit name → that kit's actions as callers see them. Open for declaration merging. */
export interface KitRegistry {
  bucket: KitApi<typeof bucket>;
  builder: KitApi<typeof builder>;
  combat: KitApi<typeof combat>;
  container: KitApi<typeof container>;
  craft: KitApi<typeof craft>;
  crafter: KitApi<typeof crafter>;
  dig: KitApi<typeof dig>;
  explorer: KitApi<typeof explorer>;
  farm: KitApi<typeof farm>;
  furnace: KitApi<typeof furnace>;
  gatherer: KitApi<typeof gatherer>;
  inventory: KitApi<typeof inventory>;
  items: KitApi<typeof items>;
  move: KitApi<typeof move>;
  place: KitApi<typeof place>;
  sense: KitApi<typeof sense>;
  social: KitApi<typeof social>;
  survival: KitApi<typeof survival>;
}
