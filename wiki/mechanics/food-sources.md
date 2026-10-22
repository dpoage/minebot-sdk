---
title: Food sources and how much each food restores
tags: [food, hunger, eat, beef, porkchop, bread, apple, carrot, potato, cooked, meat, saturation, restore, consume]
mc_version: "26.1"
verified_by: check program; cooked_beef eaten on the 26.1 dev server, 2026-10-19
check: food-sources.js
---

Food points are what `bot.food` gains when you eat: 2 points fill one drumstick, and the bar holds 20. Saturation is a hidden buffer that decides how long the bar stays full, so a food with high saturation keeps you fed longer.

| Food | Food points | Saturation | Where it comes from |
| - | - | - | - |
| cooked_beef, cooked_porkchop | 8 | 12.8 | cook raw meat from cows or pigs |
| pumpkin_pie | 8 | 4.8 | craft from pumpkin, sugar, egg |
| cooked_mutton, cooked_salmon | 6 | 9.6 | cook raw mutton from sheep, or salmon |
| cooked_chicken | 6 | 7.2 | cook chicken |
| golden_carrot | 6 | 14.4 | craft from carrot and gold nuggets |
| cooked_cod, baked_potato, bread | 5 | 6 | cook cod or a potato; craft 3 wheat in a row |
| rotten_flesh | 4 | 0.8 | zombie drop |
| beef, porkchop | 3 | 1.8 | cows, pigs |
| carrot | 3 | 3.6 | a farm (`mechanics/crop-growth`); a zombie sometimes drops one |
| mutton, chicken | 2 | 1.2 | sheep, chickens |
| melon_slice | 2 | 1.2 | the melon block |
| cookie | 2 | 0.4 | craft: 2 wheat and cocoa beans |

The full list of 44 foods is in `reference/foods`. Which mob drops what: `reference/mobs-passive`.

Raw meat needs only a fire to become the best early food. Smelt it (`mechanics/smelting`): a furnace cooks it in 10 seconds, and a smoker in 5. Cows give beef and leather, so one cow is about 1 to 3 beef.

## Eat

Hold the food and consume it. `bot.consume()` ends when the bite is done, so check `bot.food` before and after:

```js
const foods = bot.registry.foodsByName;
const best = bot.inventory.items().filter((i) => foods[i.name]).sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
if (best && bot.food < 20) {
  await bot.equip(best, "hand");
  await bot.consume();
}
```

Observed: with food 19, eating `cooked_beef` brought `bot.food` to 20 (the bar caps at 20). Points above 20 are lost, so eat an 8-point meal at food 12 or lower.

<!-- builtins -->
`kit.survival.eat()` eats the best food in the inventory. `kit.survival.eat({ item: "bread" })` eats that item.
<!-- /builtins -->
