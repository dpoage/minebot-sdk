// `minebot-sdk/routine`: what a routine module is written against. A routine is a module whose
// default export is `defineRoutine({ description, args, returns }, async (ctx, args) => result)`;
// `ctx` carries the bot, the run's log/sleep/signal, and the body's facilities.
export { defineRoutine } from "./define.ts";
export type { Routine, RoutineMeta } from "./define.ts";
export type { RoutineContext } from "./context.ts";
export { z } from "zod";
