// The real Minecraft data the harness runs on: the registry, block, item, entity, and recipe
// classes for the version the body targets. Built once; none of it is mutated.
import { createRequire } from "node:module";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Recipe } from "prismarine-recipe";
import { MC_VERSION } from "../mc/version.ts";

// These packages ship CommonJS; their typings promise default exports that node does not give.
const load = createRequire(import.meta.url);

/** The registry shape the harness reads; `bot.registry` in a running body is the same object type. */
export interface Registry {
  readonly blocks: Record<number, RegistryBlock>;
  readonly blocksByName: Record<string, RegistryBlock>;
  readonly blocksArray: RegistryBlock[];
  readonly items: Record<number, RegistryItem>;
  readonly itemsByName: Record<string, RegistryItem>;
  readonly foodsByName: Record<string, { foodPoints: number; saturation: number }>;
  readonly entitiesByName: Record<string, { type?: string; category?: string; height?: number; width?: number; displayName?: string }>;
}
export interface RegistryBlock {
  id: number;
  name: string;
  /** Item ids the block drops when it is harvested. */
  drops: number[];
}
export interface RegistryItem {
  id: number;
  name: string;
  stackSize: number;
}

export interface BlockClass {
  fromProperties(type: number | string, properties: Record<string, unknown>, biomeId: number): Block;
}
export interface ItemClass {
  new (type: number, count: number, metadata?: number | null): Item;
}
export interface EntityClass {
  new (id: number): Entity;
}
export interface RecipeClass {
  find(itemType: number, metadata: number | null): Recipe[];
}

export interface Universe {
  registry: Registry;
  Block: BlockClass;
  Item: ItemClass;
  Entity: EntityClass;
  Recipe: RecipeClass;
}

let cached: Universe | undefined;

/** The shared registry and prismarine classes for `MC_VERSION`. */
export function universe(): Universe {
  if (cached) return cached;
  const registry = (load("prismarine-registry") as (version: string) => Registry)(MC_VERSION);
  cached = {
    registry,
    Block: (load("prismarine-block") as (registry: Registry) => BlockClass)(registry),
    Item: (load("prismarine-item") as (registry: Registry) => ItemClass)(registry),
    Entity: (load("prismarine-entity") as (registry: Registry) => EntityClass)(registry),
    Recipe: (load("prismarine-recipe") as (registry: Registry) => { Recipe: RecipeClass })(registry).Recipe,
  };
  return cached;
}
