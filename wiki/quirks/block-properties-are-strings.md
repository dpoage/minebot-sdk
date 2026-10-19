---
title: block.getProperties() returns number states as strings, so age === 7 is never true
tags: [getProperties, properties, age, moisture, level, state, block, crop, comparison, string, number, boolean]
mc_version: "26.1"
verified_by: observed on the 26.1 dev server, 2026-10-19
---

## Symptom

A loop that waits for a crop to ripen never ends: `bot.blockAt(p).getProperties().age === 7` is false even when the crop is ripe. The same happens with `moisture`, `level`, and other number states.

## Cause

`block.getProperties()` returns integer and enum states as strings: `{ "age": "7" }`, `{ "moisture": "7" }`, `{ "facing": "east" }`. Boolean states are real booleans: a bed gave `{ "part": "foot", "occupied": false, "facing": "east" }`.

## Workaround

Convert number states before you compare:

```js
const age = Number(bot.blockAt(position).getProperties().age);
const wet = Number(bot.blockAt(position).getProperties().moisture) === 7;
const taken = bot.blockAt(bedPosition).getProperties().occupied; // a boolean already
```
