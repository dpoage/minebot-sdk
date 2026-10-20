// `minebot-sdk/kit`: the one surface kits are written against, built-in and agent-saved alike.
// A kit file imports from here and from nowhere else; `minebot kits source <kit>` prints a
// built-in kit exactly as it imports. Nothing in this module reaches body internals.
import pathfinderPkg from "mineflayer-pathfinder";
import { biomeAt } from "../mc/biome.ts";
import { isHostile } from "../mc/hostile.ts";
import { NamePattern, nameMatcher } from "../mc/names.ts";
import { Point, Position, toVec3 } from "../mc/position.ts";
import { isAir, type SkyView, skyAbove } from "../mc/sky.ts";
import { burnTicks, pickFuel, SMELT_TICKS, smeltInputs, smeltOutput, withoutReserved } from "../mc/smelting.ts";
import { within, type Within } from "../mc/within.ts";

const { goals, Movements } = pathfinderPkg;

export { action, defineKit } from "./kit.ts";
export type { Kit, KitAction, KitApi, KitContext, KitsOf, UntypedKit } from "./kit.ts";
export type { KitRegistry } from "./registry.ts";
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
