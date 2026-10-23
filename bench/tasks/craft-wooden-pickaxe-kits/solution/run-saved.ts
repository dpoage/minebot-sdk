// Runs the saved oracle routine from a run, the way an agent runs the routines it saved. solve.sh of craft-wooden-pickaxe
// saves progression.ts into the body's library, binds it as the action `oracle`, and sends this file:
//   minebot run run-saved.ts --args '{"target":"wooden_pickaxe","builtins":false}' --timeout 900000
// `./progression.ts` is the library's module of that name once it is saved (the file next to this one when tsc reads it).
import type { RoutineContext } from "minebot-sdk/routine";
import type * as util from "node:util";
import { z } from "zod";
import progression from "./progression.ts";

const { inspect } = require("node:util") as typeof util;

const Args = z.object({
  target: z.enum(["logs", "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "shelter", "stock_chest", "stash_chest", "retrieve_logs", "dawn"]),
  builtins: z.boolean(),
});

export default async function runSaved(ctx: RoutineContext, args: unknown): Promise<string[] | number> {
  const result = await progression(ctx, Args.parse(args));
  ctx.log(inspect(result, { breakLength: Infinity }));
  return result;
}
