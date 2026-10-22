// `minebot-sdk/routine`: what a routine module is written against. A routine is a module whose
// default export is `defineRoutine({ description, args, returns }, async (ctx, args) => result)`;
// `ctx` carries the bot, the run's log/sleep/signal, and the body's facilities. The runtime values
// below are the authoring helpers a routine composes with: pathfinder goals, positions and name
// patterns, block and world predicates, and the smelting tables.
import pathfinderPkg from "mineflayer-pathfinder";
import { biomeAt } from "../mc/biome.ts";
import { isHostile } from "../mc/hostile.ts";
import { NamePattern, nameMatcher } from "../mc/names.ts";
import { Point, Position, toVec3 } from "../mc/position.ts";
import { isAir, type SkyView, skyAbove } from "../mc/sky.ts";
import { burnTicks, pickFuel, SMELT_TICKS, smeltInputs, smeltOutput, withoutReserved } from "../mc/smelting.ts";
import { within, type Within } from "../mc/within.ts";

const { goals, Movements } = pathfinderPkg;

export { defineRoutine } from "./define.ts";
export type { Routine, RoutineMeta } from "./define.ts";
export type { RoutineContext } from "./context.ts";
export { z } from "zod";
export { goals, Movements };
export { NamePattern, nameMatcher };
export { Point, Position, toVec3 };
export { isAir, skyAbove, type SkyView };
export { biomeAt };
export { isHostile };
export { burnTicks, pickFuel, SMELT_TICKS, smeltInputs, smeltOutput, withoutReserved };
export { within, type Within };
export type { Bot, Chest, Furnace } from "mineflayer";
export type { Block } from "prismarine-block";
export type { Item } from "prismarine-item";
export type { Entity } from "prismarine-entity";
export { Vec3 } from "vec3";
