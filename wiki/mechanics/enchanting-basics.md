---
title: "Enchanting: table, bookshelves, lapis, and levels"
tags: [enchant, enchanting, enchanting_table, bookshelf, lapis, levels, xp, sharpness, efficiency, unbreaking, experience, openEnchantmentTable]
mc_version: "26.1"
verified_by: check program; two enchantments run on the 26.1 dev server, 2026-10-19
check: enchanting-basics.js
---

## What you need

- An enchanting table, with 15 bookshelves around it. The bookshelves stand in a ring two blocks from the table (one air block between), two high. Observed on the dev server with a diamond sword: 14 bookshelves gave offers of level 4, 7, and 28; 15 gave 4, 12, and 30; 30 gave the same as 15, so 15 is all that counts. Level 30 needs all 15. The offers also differ between items and tries (8, 13, 30 and 4, 15, 30 on an iron pickaxe).
- Lapis lazuli. Observed: the first offer used 1.
- Experience levels. Observed: the first offer cost 1 level (30 to 29), the second 2 levels (30 to 28), the third 3 levels (30 to 27). The offer's own number (8, 13, 30) is the level you must have, not what it costs.
- The item: tools, weapons, and armor can be enchanted. See `reference/enchantments` for every enchantment, its top level, and what it goes on.

## With Mineflayer

Pick the item and the lapis from the window's own items (`quirks/table-window-slots-differ-from-inventory-slots`):

```js
const table = await bot.openEnchantmentTable(bot.blockAt(position));
await table.putTargetItem(table.items().find((i) => i.name === "diamond_sword"));
await table.putLapis(table.items().find((i) => i.name === "lapis_lazuli"));
await sleep(1500);                       // the three offers arrive after a moment
for (const [i, o] of table.enchantments.entries()) {
  console.log(i, o.level, bot.registry.enchantments[o.expected.enchant]?.name, o.expected.level);
}
const item = await table.enchant(1);     // 0, 1, or 2
table.close();
```

`table.enchantments` has three entries. `level` is the level the offer needs. `expected` shows the first enchantment of the offer: observed `sharpness 2` on the middle offer, and the sword came back with exactly `sharpness 2`. Another try offered `unbreaking 2` and gave an iron pickaxe `efficiency 2` and `unbreaking 2`: an offer can add more than the one it shows.

Read what the item got from `item.enchants.enchantments`: a list of `{ id, level }`, where `bot.registry.enchantments[id].name` names it.

An enchantment that conflicts with another, such as `sharpness` and `smite`, never shares an item with it (`reference/enchantments`, column Excludes).

<!-- builtins -->
No kit action enchants yet; use the code above.
<!-- /builtins -->
