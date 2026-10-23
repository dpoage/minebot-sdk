---
title: Fighting mobs with Mineflayer, and how much damage each weapon does
tags: [combat, fight, attack, sword, axe, damage, weapon, cooldown, health, hostile, bot.attack, equip]
mc_version: "26.1"
verified_by: attack damage read from the 26.1 dev server with the attribute command, 2026-10-19
---

## Attack

Equip the weapon, then hit the entity. Each `bot.attack(entity)` is one swing:

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, sleep, signal }: RoutineContext) => {
  const target = bot.nearestEntity((e) => e.type === "hostile" && e.position.distanceTo(bot.entity.position) < 16);
  if (!target) return "no hostile mob within 16 blocks";
  const sword = bot.inventory.items().find((i) => i.name.endsWith("_sword"));
  if (sword) await bot.equip(sword, "hand");
  while (target.isValid && bot.health > 8 && !signal.aborted) {
    if (target.position.distanceTo(bot.entity.position) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
    }
    bot.attack(target);
    await sleep(650); // swords swing 1.6 times per second; a mob also ignores a second hit within about 0.5 s
  }
};
```

Look at `bot.health` in the loop and stop at a threshold. A fight you cannot win ends in a death, and the bot respawns with an empty inventory.

## Damage per swing

Attack damage and swing speed of the held item, read from the server. Enchantments add to it.

| Tier | Sword damage | Axe damage | Pickaxe damage | Shovel damage |
| - | - | - | - | - |
| wooden | 4 | 7 | 2 | 2.5 |
| golden | 4 | 7 | 2 | 2.5 |
| copper | 5 | 9 | 3 | 3.5 |
| stone | 5 | 9 | 3 | 3.5 |
| iron | 6 | 9 | 4 | 4.5 |
| diamond | 7 | 9 | 5 | 5.5 |
| netherite | 8 | 10 | 6 | 6.5 |

Swing speed is the attack speed attribute, in swings per second: swords 1.6 (one swing per 0.625 s), axes 0.8 to 1.0, pickaxes 1.2, shovels 1.0.

Test: a zombie took no damage from a second swing 0.1 s after the first, and full damage from a swing 1.5 s later.

Armor reduces the hits you take (`mechanics/armor-tiers`). Hostile mobs and their special rules: `mechanics/creeper-fuse`, `mechanics/daylight-burning`, `mechanics/hostile-mobs-and-night`.

<!-- builtins:combat -->
`minebot call combat.attack --args '{"target":"zombie"}'` fights one mob. `minebot call combat.fight --args '{"radius":12,"timeoutMs":30000}'` fights every hostile in range until none is left.
<!-- /builtins:combat -->
<!-- builtins:survival -->
`minebot call survival.eat` and `minebot call survival.armor` prepare for a fight.
<!-- /builtins:survival -->
