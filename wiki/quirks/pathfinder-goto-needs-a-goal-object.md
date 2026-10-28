---
title: A pathfinder goal must be a goal object, not a plain position
tags: [pathfinder, goto, setGoal, goal, goals, error, refused, heuristic, isEnd, path]
mc_version: "26.1"
verified_by: "goal validation and its error text by test/pathfinding-goal.test.ts"
---

## Symptom

A call passes a plain value where a goal belongs, such as `bot.pathfinder.goto({ x: 10, y: 64, z: 0 })` or `bot.pathfinder.goto({ goal })`, and the body refuses it at once:

```
bot.pathfinder.goto needs a goal object, e.g. await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)) with goals from "minebot-sdk/routine"; it got an object without heuristic and isEnd ({"goal":{"x":1,"y":64,"z":0}})
```

`bot.pathfinder.setGoal` refuses the same values with the same message, and its name instead of `goto`.

## Cause

The pathfinder reads a goal only inside its physics tick. Without the refusal, a plain value throws after the run that passed it has ended, and the error names neither the call nor the value. A goal object is any object with a `heuristic(node)` function and an `isEnd(node)` function; every `goals.*` class has both.

## Workaround

Make the goal from the classes in `minebot-sdk/routine`:

```ts
import { goals } from "minebot-sdk/routine";
import type { RoutineContext } from "minebot-sdk/routine";

export default async ({ bot }: RoutineContext) => {
  await bot.pathfinder.goto(new goals.GoalNear(10, 64, 0, 1));
};
```

`GoalNear(x, y, z, range)` walks within `range` blocks of the point. `GoalBlock(x, y, z)` wants the block itself, and `GoalLookAtBlock(block.position, bot.world)` walks close enough to reach a block. `setGoal(null)` clears a goal, which is the one value that needs no goal object.
