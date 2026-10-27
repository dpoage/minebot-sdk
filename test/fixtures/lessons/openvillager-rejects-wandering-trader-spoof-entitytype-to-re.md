---
title: openVillager rejects wandering_trader; spoof entityType to read or trade it
tags:
  - wandering_trader
  - openVillager
  - trade
  - merchant
  - assert
  - entityType
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T06:31:33.227Z
---

`bot.openVillager(entity)` asserts `entity.entityType === entitiesByName.villager.id` (139), so passing a `wandering_trader` (id 141) throws `AssertionError: 141 !== 139`. The window it opens is type `minecraft:merchant`, which the rest of the code already accepts (it checks `villager.type !== 'minecraft:villager' && !== 'minecraft:merchant'`).

Workaround: save the entity's `entityType`, set it to the villager id, `await bot.openVillager(entity)`, restore it in a `finally`. The `trades` list then populates from the `minecraft:trader_list` packet as usual. Verified on the 26.1 world of minecraft.wilsonfabrication.com (2026-10-24): read a full 9-offer wandering-trader table this way.

Notes:
- Wandering traders despawn in daylight and spawn near players at night; the offer set is random per spawn.
- They only pay emeralds for fermented_spider_eye (3) and milk_bucket (2) in my observation; they buy logs/dye/pumpkin/kelp/coral for emeralds.

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

Use the built-in `trade` module instead of the entityType spoof. `trade.offers({ radius? })` walks to the nearest villager or wandering trader and lists its offers, with current prices and sold-out flags. `trade.buy({ index, times? })` makes the trades. It measures gave and got from the inventory, skips trades whose output would not fit, and reports any `shortfall`. Keep the spoof only for raw `bot.openVillager` code.
