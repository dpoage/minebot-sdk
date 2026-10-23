---
title: Which pickaxe each block needs
tags: [tools, pickaxe, harvest, mining, ore, stone, copper, iron, diamond, obsidian, tiers, drops]
mc_version: "26.1"
verified_by: check program; drops of six block and tool pairs observed on the 26.1 dev server, 2026-10-19
check: tool-tiers.js
---

Breaking a block without the right tool gives no drop. For stone and ores, the right tool is a pickaxe of a high enough tier.

| Block | Lowest pickaxe that drops it |
| - | - |
| stone (drops cobblestone), cobblestone, coal ore | wooden |
| iron ore, copper ore, lapis ore | stone or copper |
| gold ore, diamond ore, emerald ore, redstone ore | iron |
| obsidian, ancient debris | diamond |

Observed: a wooden pickaxe dug iron ore and dropped nothing. A copper pickaxe and a stone pickaxe on iron ore dropped `raw_iron`. A stone pickaxe on diamond ore dropped nothing, and an iron pickaxe dropped a `diamond`.

Deepslate variants of ores need the same tier. Iron, copper, and gold ores drop raw metal (`raw_iron`, `raw_copper`, `raw_gold`), which you smelt into ingots (`mechanics/smelting`). The full list of blocks, tools, and drops is in the `reference/blocks-*` pages.

Logs, dirt, sand, gravel, and leaves need no tool. An axe or shovel only makes them faster.

Tier order: wooden, stone, iron, diamond, netherite. Copper pickaxes have the stone tier, and gold pickaxes have the wooden tier: they are fast but not strong.

In code, `block.canHarvest(bot.heldItem?.type ?? null)` tells you whether the held item gets a drop, and `bot.pathfinder.bestHarvestTool(block)` picks the best tool you hold.

<!-- builtins -->
`minebot call gatherer.gather --args '{"blocks":"stone","count":3}'` equips the best tool and fails if a required tool is missing.
<!-- /builtins -->
