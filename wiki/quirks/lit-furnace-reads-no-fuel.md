---
title: A lit furnace opened with bot.openFurnace reports no fuel left
tags: [furnace, fuel, fuelSeconds, totalFuel, craft_progress_bar, smelting, burning]
mc_version: "26.1"
verified_by: observed on the dev server, 2026-10-19 (a furnace with a block state of lit=true read fuel 0, fuelSeconds 0, totalFuel null 500 ms after openFurnace; the craft_progress_bar listener below read the burn time)
---

## Symptom

You smelt, close the furnace, and open it again while it still burns. `furnace.fuel` and `furnace.fuelSeconds` are `0` and `furnace.totalFuel` is `null`, although the block is lit and fuel remains. Code that adds fuel when `fuelSeconds` is low then wastes a fuel item.

## Cause

Mineflayer fills these fields from `craft_progress_bar` packets, and it listens only after `openFurnace` resolves. The total burn time (`totalFuel`) never reaches it when the furnace is already burning, and `fuelSeconds` is computed from it.

## Workaround

Listen for the packets yourself. Property `0` is the ticks of burning left (20 per second), and a burning furnace keeps sending it:

```js
const furnace = await bot.openFurnace(block);
let burnLeft = null;
bot._client.on("craft_progress_bar", (p) => {
  if (p.windowId === furnace.id && p.property === 0) burnLeft = p.value;
});
if (block.getProperties().lit) while (burnLeft === null) await sleep(50);
else burnLeft = 0;
// burnLeft ticks cover burnLeft / 200 items.
```

Remove the listener when you close the furnace. The `lit` block property is `false` when the furnace is cold, and then no packet comes.

<!-- builtins -->
`kit.furnace.smelt` counts the burning fuel left before it adds any, so a second `smelt` right after the first needs no new fuel item.
<!-- /builtins -->
