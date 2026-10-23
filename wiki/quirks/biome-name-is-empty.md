---
title: Block biome names are empty on 26.1
tags: [biome, blockAt, explore, scan, registry]
mc_version: "26.1"
verified_by: check program
check: biome-name-is-empty.js
---

## Symptom

`bot.blockAt(pos).biome.name` is `""`.

## Cause

prismarine-block does not resolve biome names for this protocol version. The biome id is correct.

## Workaround

Look the id up in the registry:

```ts
import type { RoutineContext } from "minebot-sdk/routine";

export default ({ bot }: RoutineContext) => bot.registry.biomes[bot.world.getBiome(bot.entity.position.floored())]!.name; // e.g. "forest"
```

The `biome` field of the observation (`minebot observe`) is resolved this way, so read the biome there when you only need the name.

<!-- builtins:explorer -->
`minebot call explorer.scan` reports the biome this way.
<!-- /builtins:explorer -->
