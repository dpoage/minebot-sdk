---
title: "Villagers trade items for emeralds: bot.openVillager and bot.trade"
tags: [villager, trade, trading, emerald, openVillager, merchant, farmer, librarian, wandering_trader, offers]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Trade

Walk to within 2 blocks of the villager, open it, read `villager.trades`, and call `bot.trade(villager, index, times)`:

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot, log }: RoutineContext) => {
  const entity = bot.nearestEntity((e) => e.name === "villager")!;
  await bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2));
  const villager = await bot.openVillager(entity);          // window type minecraft:merchant
  for (const [i, t] of villager.trades.entries()) {
    log(i, `${t.inputItem1.count} ${t.inputItem1.name}`, t.hasItem2 ? `+ ${t.inputItem2!.name}` : "", "->", `${t.outputItem.count} ${t.outputItem.name}`, `${t.nbTradeUses}/${t.maximumNbTradeUses} used`, t.tradeDisabled ? "disabled" : "");
  }
  await bot.trade(villager, 0, 2);    // the first trade, twice
  villager.close();
};
```

Observed with a farmer that sells 1 emerald for 20 wheat: `bot.trade(villager, 0, 2)` took 40 wheat and gave 2 emeralds.

Each trade has these fields: `inputItem1`, `inputItem2` (use it only when `hasItem2` is true), `outputItem`, `nbTradeUses`, `maximumNbTradeUses`, `tradeDisabled`, and `realPrice`. A trade has a use limit: asking for more than are left throws `assert.ok(Trade.maximumNbTradeUses - Trade.nbTradeUses >= count)`. Observed: after 2 trades of 16, the count read 2 of 16.

`bot.inventory` is out of date until you close the window (`quirks/inventory-lags-while-a-window-is-open`). Wait half a second after `villager.close()`.

## Find villagers

Villagers are `e.name === "villager"`, and the wandering trader is `wandering_trader`. Find the nearest with `bot.nearestEntity((e) => e.name === "villager")`.

<!-- builtins:trade -->
`trade.offers` and `trade.buy` do this for a villager or a wandering trader. Both walk to within 2 blocks of the nearest merchant within `radius` (default 8):

```sh
minebot call trade.offers
minebot call trade.buy --args '{"index":0,"times":2}'
```

`trade.offers` returns `[{ index, give, get, uses, maxUses, disabled }]`, where `give` is the price the merchant charges you now, with demand and reputation included. `trade.buy` makes offer `index` up to `times` times and returns `{ traded, gave, got, shortfall? }`, measured from the inventory. It trades only as often as the output fits in the inventory, so nothing drops. When it makes some trades but fewer than you asked for, `shortfall` says why. When it makes none, it throws and names the cause (for a full inventory: `did not trade: the inventory has no room ...`).
<!-- /builtins:trade -->
