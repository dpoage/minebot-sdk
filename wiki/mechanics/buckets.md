---
title: Fill and empty buckets with bot.activateItem
tags: [bucket, water_bucket, lava_bucket, fill, empty, place water, activateItem, fluid, source, flowing, blockAtCursor]
mc_version: "26.1"
verified_by: check program; every call ran on the 26.1 dev server, 2026-10-19
check: water-and-lava.js
---

## Fill

Hold an empty `bucket`, look at a water or lava **source** block, and use the item:

```js
await bot.equip(bot.inventory.items().find((i) => i.name === "bucket"), "hand");
await bot.lookAt(sourceBlock.position.offset(0.5, 0.5, 0.5), true);
bot.activateItem();
await sleep(600);
```

Observed: the empty bucket turned into `water_bucket` (or `lava_bucket` from lava), and the source block became air. The range is the normal block reach: from 7 blocks away the first try did nothing, from 2 blocks it worked.

Three details:

- `bot.blockAtCursor()` does not report fluids: it returned the stone behind the water. The server's ray does hit them, so `activateItem` works anyway. Aim with `lookAt`.
- A **flowing** block (water with `level` above 0) cannot be picked up. Observed: using an empty bucket on a flowing block did nothing. Look at the source.
- Buckets stack to 16 when empty. A full one (`water_bucket`, `lava_bucket`, `milk_bucket`) does not stack.

## Empty

Hold the full bucket, look at a solid block, and use the item. The fluid appears in front of the face you look at:

```js
await bot.equip(bot.inventory.items().find((i) => i.name === "water_bucket"), "hand");
await bot.lookAt(new Vec3(x + 0.5, y + 0.9, z + 0.5), true); // the top of a block
bot.activateItem();
await sleep(600);
```

Observed: water appeared in the air cell in front of the wall that the bot looked at, and the bot held an empty `bucket` again.

Water and lava interact: see `mechanics/water-and-lava`.

<!-- builtins -->
`kit.bucket.fill({ fluid: "water" })` fills a bucket from the nearest source. `kit.bucket.empty({ at })` places the fluid at a position.
<!-- /builtins -->
