// The runtime members of the bot and its world values that the packages' typings do not declare. The body
// loads plugins that attach these at run time, so a routine (and the run check, which types a run against
// this module) must see them; mb-znn.18 lists the ones agents used on a live 26.1 bot. The members and
// their meanings below mirror the plugins' implementations (mineflayer lib/plugins, prismarine-block,
// prismarine-windows); a member a plugin sets only for some entities is declared optional.
//
// This module only augments declarations: it has no run-time behavior, and importing it for the side
// effect of its types is how `minebot-sdk/routine` carries them to every check.
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Click } from "prismarine-windows";
import type { Vec3 } from "vec3";

declare module "mineflayer" {
  interface Bot {
    /** False while the bot is dead (`health` is 0 and it has not respawned yet). */
    isAlive: boolean;
    /** The rain level, 0 (dry) to 1 (full rain); `thunderState` is the thunder level. */
    rainState: number;
    /** The player entities a filter matches: with a string, null when there is none and the entity when there is one. */
    findPlayer(filter: string): Entity | Entity[] | null;
    findPlayer(filter?: RegExp | ((entity: Entity) => boolean)): Entity[];
    findPlayers(filter: string): Entity | Entity[] | null;
    findPlayers(filter?: RegExp | ((entity: Entity) => boolean)): Entity[];
    /** Signs the writable book in the inventory slot with the pages, author and title. */
    signBook(slot: number, pages: string[], author: string, title: string): Promise<void>;
    /** How a bed block is placed: which half it is, whether someone sleeps in it, its facing and where its head is. */
    parseBedMetadata(bed: Block): { part: boolean; occupied: boolean; facing: number; headOffset: Vec3 };
  }
}

declare module "prismarine-block" {
  interface Block {
    /** The block state's properties as the registry declares them (the same keys `properties` adds). */
    _properties: { [key: string]: string | number | boolean };
    /** The properties a plugin computed for this block; `getProperties()` merges them into `_properties`. */
    computedStates: { [key: string]: string | number | boolean };
  }
}

declare module "prismarine-entity" {
  interface Entity {
    /** Whether the entity is in water; the physics plugin sets it, so it is absent until the first tick. */
    isInWater?: boolean;
    /** Whether the entity is in lava; the physics plugin sets it, so it is absent until the first tick. */
    isInLava?: boolean;
    /** The height of the entity's eyes above its position; the entities plugin sets it for spawned entities. */
    eyeHeight?: number;
    /** The attributes the server sent for this entity (`generic.armor`, …); absent until it has any. */
    attributes?: { [key: string]: { value: number; modifiers?: unknown[] } };
  }
}

declare module "prismarine-windows" {
  interface Window<T = unknown> {
    /** Not implemented by prismarine-windows: it asserts. */
    dragClick(click: Click, gamemode: number): void;
    /** Not implemented by prismarine-windows: it asserts. */
    doubleClick(click: Click): void;
    /** The last empty slot in `[start, end]`, or null when all are full. */
    lastEmptySlotRange(start: number, end: number): number | null;
  }
}

export {};
