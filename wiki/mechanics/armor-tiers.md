---
title: Armor tiers, armor points, and how to wear them
tags: [armor, helmet, chestplate, leggings, boots, leather, chainmail, iron, diamond, netherite, copper, golden, protection, equip, durability]
mc_version: "26.1"
verified_by: check program; armor points read from the 26.1 dev server with the attribute command, 2026-10-19
check: armor-tiers.js
---

Each piece adds armor points, and 20 points is the full bar. Armor points come from the pieces you wear, added up.

| Tier | Helmet | Chestplate | Leggings | Boots | Total | Toughness per piece |
| - | - | - | - | - | - | - |
| leather | 1 | 3 | 2 | 1 | 7 | 0 |
| golden | 2 | 5 | 3 | 1 | 11 | 0 |
| copper | 2 | 4 | 3 | 1 | 10 | 0 |
| chainmail | 2 | 5 | 4 | 1 | 12 | 0 |
| iron | 2 | 6 | 5 | 2 | 15 | 0 |
| diamond | 3 | 8 | 6 | 3 | 20 | 2 |
| netherite | 3 | 8 | 6 | 3 | 20 | 3 |

Netherite also gives 0.1 knockback resistance per piece. A turtle shell helmet gives 2.

Durability of each piece (uses before it breaks), helmet, chestplate, leggings, boots:

| Tier | Durability | Repaired with |
| - | - | - |
| leather | 55, 80, 75, 65 | leather |
| golden | 77, 112, 105, 91 | gold_ingot |
| copper | 121, 176, 165, 143 | copper_ingot |
| chainmail, iron | 165, 240, 225, 195 | iron_ingot |
| diamond | 363, 528, 495, 429 | diamond |
| netherite | 407, 592, 555, 481 | netherite_ingot |

Iron is the best tier you can make early: a full set is 15 points. A helmet takes 5 of the material, a chestplate 8, leggings 7, and boots 4, so a set is 24 `iron_ingot`. Search `iron_chestplate recipe` for the grid.

## Wear armor

Equip a piece into its slot (`head`, `torso`, `legs`, `feet`). A better piece replaces the worn one, and the old one goes back to the inventory. `bot.inventory.items()` does not list worn armor, so compare against the worn slot (`bot.inventory.slots[5]` to `[8]`: head, chest, legs, feet), or you may swap a good piece for a worse one:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext) => {
  const slots = { helmet: ["head", 5], chestplate: ["torso", 6], leggings: ["legs", 7], boots: ["feet", 8] } as const;
  // Materials in order of the points of a full set. Diamond and netherite tie on points; netherite has more toughness.
  const tiers = ["leather", "copper", "golden", "turtle", "chainmail", "iron", "diamond", "netherite"];
  const rank = (item: { name: string } | null) => (item ? tiers.findIndex((t) => item.name.startsWith(`${t}_`)) : -1);
  for (const [piece, [slot, index]] of Object.entries(slots)) {
    const worn = bot.inventory.slots[index] ?? null;
    const best = bot.inventory.items().filter((i) => i.name.endsWith(`_${piece}`)).sort((a, b) => rank(b) - rank(a))[0];
    if (best && rank(best) > rank(worn)) await bot.equip(best, slot);
  }
};
```

Observed: with an iron helmet and copper boots worn and a diamond helmet and golden boots in the pack, this swapped both, and a second run kept everything. An iron set plus a diamond helmet added up to 16 points (3 + 6 + 5 + 2).

<!-- builtins:survival -->
`minebot call survival.armor` equips the best armor in the inventory.
<!-- /builtins:survival -->
