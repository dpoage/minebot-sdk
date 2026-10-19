---
title: "Water and lava: sources, flow, infinite water, obsidian, and cobblestone"
tags: [water, lava, fluid, source, flow, level, obsidian, cobblestone, infinite water, bucket, danger]
mc_version: "26.1"
verified_by: check program; reactions observed on the 26.1 dev server, 2026-10-19
check: water-and-lava.js
---

## Levels

Water and lava have a `level` state of 0 to 15. Level 0 is a **source**. A higher level is a block that flows away from a source, and the level grows by one with each block it spreads. Observed with water: the source was `level` 0, the block next to it 1, the next 2. Read it with `Number(block.getProperties().level)` (`quirks/block-properties-are-strings`).

Only a source can be picked up with a bucket (`mechanics/buckets`).

## Infinite water

Two water sources with one empty block between them, on a solid floor, make the block between them a source too. Observed: the middle block became `level` 0. So with 2 sources you can refill a bucket forever.

## Water meets lava

Observed on the dev server:

| Setup | Result |
| - | - |
| lava source, water source directly above | the lava source became `obsidian` |
| flowing lava reaches water | the contact block became `cobblestone` |

Obsidian takes a diamond pickaxe to mine (`mechanics/tool-tiers`). It has hardness 50.

## Danger

Do not stand in lava. To make a lava source safe, pour water on it from above: it becomes obsidian (table above).

<!-- kits -->
`kit.bucket.fill({ fluid: "water" })` and `kit.bucket.empty({ at })` handle the buckets.
<!-- /kits -->
