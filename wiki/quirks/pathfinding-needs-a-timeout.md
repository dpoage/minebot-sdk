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

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

async function within<T>(ms: number, label: string, work: Promise<T>, cancel: () => void): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => { cancel(); expired.reject(new Error(`${label} took longer than ${ms} ms`)); }, ms);
  try { return await Promise.race([work, expired.promise]); } finally { clearTimeout(timer); }
}

export default async ({ bot }: RoutineContext, { x, y, z }: { x: number; y: number; z: number }) => {
  const goal = new goals.GoalNear(x, y, z, 1);
  await within(45000, "goto", bot.pathfinder.goto(goal), () => bot.pathfinder.stop());
};
```

When a target times out, skip it and choose another one.

<!-- builtins:move -->
Built-in routines that walk take time limits: `minebot call move.to --args '{"position":[10,64,5],"timeoutMs":30000}'` gives up after `timeoutMs`. `move.to` also fails fast. After 12 seconds with no progress (no movement, no digging, no block change near the bot), it throws `stuck at ...`. When the pathfinder ends without a way within `range`, it throws `could not reach ...` and names the cause (no path, or the search ran out of time).
<!-- /builtins:move -->
