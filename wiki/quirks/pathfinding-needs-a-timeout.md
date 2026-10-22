---
title: Pathfinding and digging can wait forever without a timeout
tags: [pathfinder, goto, dig, hang, timeout, stuck, program timeout]
mc_version: "26.1"
verified_by: observed in the craft-stone-pickaxe oracle, 2026-10-18 (one goto waited 15 minutes until the program timed out)
---

## Symptom

A program stops with status `timeout` and no useful logs. The last call was `bot.pathfinder.goto` or `bot.dig`.

## Cause

Neither call has a built-in time limit. Some goals are unreachable in a way the planner does not detect.

## Workaround

Race every move and dig against a timer, and stop the action when the timer wins:

```js
async function within(ms, label, work, cancel) {
  const expired = Promise.withResolvers();
  const timer = setTimeout(() => { cancel(); expired.reject(new Error(`${label} took longer than ${ms} ms`)); }, ms);
  try { return await Promise.race([work, expired.promise]); } finally { clearTimeout(timer); }
}
await within(45000, "goto", bot.pathfinder.goto(goal), () => bot.pathfinder.stop());
```

When a target times out, skip it and choose another one.

<!-- builtins -->
Kit actions use time limits everywhere: `kit.move.to({ position, timeoutMs })` gives up after `timeoutMs`.
<!-- /builtins -->
