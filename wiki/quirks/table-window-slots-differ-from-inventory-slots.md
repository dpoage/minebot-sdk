---
title: "putTargetItem throws \"invalid operation\": take items from the window, not bot.inventory"
tags: [enchantment, enchanting_table, putTargetItem, putLapis, slot, window, invalid operation, assert, moveSlotItem]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

```
AssertionError: invalid operation
```

thrown by `table.putTargetItem(item)` or `table.putLapis(item)` after `bot.openEnchantmentTable(block)`.

## Cause

You passed an item from `bot.inventory.items()`. Its `slot` is a slot of the player inventory window: a sword in the first hotbar slot has `slot` 36. In the table window the same stack is slot 29. The call moves the stack by `slot`, so it moved the wrong one.

## Workaround

Take the item from the open window:

```js
const table = await bot.openEnchantmentTable(block);
const sword = table.items().find((i) => i.name === "diamond_sword"); // slot 29 here
await table.putTargetItem(sword);
await table.putLapis(table.items().find((i) => i.name === "lapis_lazuli"));
```

The same holds for any window you open: use that window's `items()` when a call takes an item by slot. `chest.withdraw` and `chest.deposit` take item ids and do not need it. See `mechanics/enchanting-basics`.
