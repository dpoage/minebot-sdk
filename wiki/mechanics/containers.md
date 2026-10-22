---
title: Open chests and barrels with bot.openContainer, then move items with withdraw and deposit
tags: [chest, barrel, container, openContainer, withdraw, deposit, storage, window, shulker, inventory, double chest]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Open, move, close

Stand within reach of the block, open it, and move items by item id:

```js
const chest = await bot.openContainer(bot.blockAt(position));
const iron = bot.registry.itemsByName.iron_ingot.id;
await chest.withdraw(iron, null, 3);        // chest to bot: type, metadata, count
await chest.deposit(bot.registry.itemsByName.cobblestone.id, null, 40); // bot to chest
const inside = chest.containerItems();     // only the chest's own slots
chest.close();
```

Observed: a chest and a barrel both open as `minecraft:generic_9x3`, with 27 container slots and 63 slots in all (the rest are your inventory). A double chest opens as `minecraft:generic_9x6` with 90 slots. `chest.containerItems()` lists what is in the container. `chest.items()` lists your own items as the window shows them, and `chest.count(itemId)` counts those.

Close the window when you are done.

## Read this before you rely on counts

- While the window is open, `bot.inventory` is out of date. Use `chest.count(itemId)` or `chest.items()` for your own items, or close the window and wait half a second. See `quirks/inventory-lags-while-a-window-is-open`.
- `withdraw` with a count above what the chest holds moves what exists, then throws. See `quirks/withdraw-moves-then-throws`.

## Other containers

Furnaces use `bot.openFurnace` (`mechanics/smelting`), enchanting tables `bot.openEnchantmentTable` (`mechanics/enchanting-basics`), villagers `bot.openVillager` (`mechanics/villagers-and-trading`).

<!-- builtins -->
`kit.container.list({ at })` lists a container. `kit.container.deposit({ at, items: "cobblestone", count: 40 })` and `kit.container.withdraw({ at, items: "iron_ingot", count: 3 })` move items.
<!-- /builtins -->
