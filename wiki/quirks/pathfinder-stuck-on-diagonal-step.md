---
title: The pathfinder can loop forever on a diagonal step out of a pit
tags: [pathfinder, goto, stuck, path_reset, pit, hole, diagonal, timeout]
mc_version: "26.1"
verified_by: observed on the dev server, 2026-10-18 (path_reset reason "stuck" repeated; fixed by disabling diagonal moves)
---

## Symptom

`bot.pathfinder.goto(goal)` never resolves. The bot does not move. The `path_reset` event fires again and again with reason `stuck`.

## Cause

The planner allows a diagonal jump up by one block when one side of the corner is clear. If a tall block (for example a crafting table) stands at the other corner, the player's hitbox clips it. The executor detects no progress, replans the same path, and repeats. This happens most when the bot stands in a one-block pit it dug.

## Workaround

After two `stuck` resets, retry without diagonal moves:

```js
const straight = new Movements(bot);
straight.getMoveDiagonal = () => {};
bot.pathfinder.setMovements(straight);
// ...goto again, then restore: bot.pathfinder.setMovements(new Movements(bot))
```

<!-- builtins -->
`kit.move.to` does this automatically, and so does every kit action built on it.
<!-- /builtins -->
