---
title: Hunger, healing, and eating
tags: [food, hunger, health, eat, consume, regen, starvation, saturation]
verified_by: general knowledge of vanilla Java Edition; not yet checked on 26.1
---

Health and food both run from 0 to 20 (`bot.health`, `bot.food`). Health heals over time only while food is 18 or more. Sprinting needs food above 6. Actions drain food over time.

At food 0 the player takes starvation damage. On Easy, starvation stops at 10 health; on Normal at 1 health; on Hard it can kill.

To eat, hold the food and consume it:

```js
const food = bot.inventory.items().find((i) => bot.registry.foodsByName?.[i.name]);
if (food) {
  await bot.equip(food, "hand");
  await bot.consume();
}
```

Cooked meat restores the most. Cows, pigs, sheep, and chickens drop raw meat; cook it in a furnace. Bread needs 3 wheat in a row.

How much each food restores: `mechanics/food-sources` and `reference/foods`.
