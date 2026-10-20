// The harness world: a map of blocks over an optional flat ground layer. Anything not in the map
// and not on the ground layer is air, and the world has no edge, so `blockAt` never returns null.
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import type { BlockClass, Registry } from "./universe.ts";

/** A position as tests write it. */
export type At = Vec3 | { x: number; y: number; z: number } | readonly [number, number, number];

export function vec(at: At): Vec3 {
  if (at instanceof Vec3) return at.clone();
  if (Array.isArray(at)) return new Vec3(at[0]!, at[1]!, at[2]!);
  const point = at as { x: number; y: number; z: number };
  return new Vec3(point.x, point.y, point.z);
}

/** One block, or an inclusive box of one kind of block. `properties` are block states, e.g. `{ lit: false }`. */
export type BlockSpec =
  | { name: string; at: At; properties?: Record<string, unknown> }
  | { name: string; from: At; to: At; properties?: Record<string, unknown> };

export interface Ground {
  /** The y of the one layer of ground blocks. */
  y: number;
  /** The block that layer is made of. */
  name: string;
}

/** `matching` as `bot.findBlocks` takes it: a block id, a list of ids, or a predicate over blocks. */
export type Matching = number | readonly number[] | ((block: Block) => boolean);

export interface FindOptions {
  matching: Matching;
  maxDistance?: number;
  count?: number;
  point?: Vec3;
  /** A function is a second filter over blocks that already matched; `true` is accepted as Mineflayer does and changes nothing here. */
  useExtraInfo?: boolean | ((block: Block) => boolean);
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export class World {
  readonly #Block: BlockClass;
  readonly #registry: Registry;
  readonly ground: Ground | null;
  /** Blocks tests and kits set: they win over the ground layer and over air. */
  readonly #set = new Map<string, Block>();
  /** Ground and air blocks made on first look, so the same position gives the same block object. */
  readonly #implicit = new Map<string, Block>();

  constructor(Block: BlockClass, registry: Registry, ground: Ground | null) {
    this.#Block = Block;
    this.#registry = registry;
    this.ground = ground;
  }

  #make(name: string, x: number, y: number, z: number, properties: Record<string, unknown> = {}): Block {
    if (!this.#registry.blocksByName[name]) throw new Error(`unknown block "${name}"`);
    const block = this.#Block.fromProperties(name, properties, 0);
    block.position = new Vec3(x, y, z);
    return block;
  }

  /** The block at `pos`: what was set there, else the ground, else air. */
  blockAt(pos: Vec3): Block {
    const [x, y, z] = [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)] as const;
    const id = key(x, y, z);
    const set = this.#set.get(id);
    if (set) return set;
    let implicit = this.#implicit.get(id);
    if (!implicit) {
      implicit = this.#make(this.ground && y === this.ground.y ? this.ground.name : "air", x, y, z);
      this.#implicit.set(id, implicit);
    }
    return implicit;
  }

  setBlock(at: At, name: string, properties?: Record<string, unknown>): Block {
    const pos = vec(at).floor();
    const block = this.#make(name, pos.x, pos.y, pos.z, properties);
    this.#set.set(key(pos.x, pos.y, pos.z), block);
    return block;
  }

  /** Sets every block of a spec list. */
  apply(specs: readonly BlockSpec[]): void {
    for (const spec of specs) {
      if ("at" in spec) {
        this.setBlock(spec.at, spec.name, spec.properties);
        continue;
      }
      const from = vec(spec.from).floor();
      const to = vec(spec.to).floor();
      for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
        for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
          for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) this.setBlock([x, y, z], spec.name, spec.properties);
        }
      }
    }
  }

  /**
   * Positions of blocks matching `options`, nearest first, with Mineflayer's rules: the point is
   * floored, `maxDistance` and `count` default with `||` (16 and 1, so 0 reads as the default), a
   * predicate is first asked about an unpositioned block of the same state (Mineflayer's palette
   * check, where `block.position` is null) and then about the positioned block, and a function
   * `useExtraInfo` filters what matched. Only set blocks and the ground layer are searched: air
   * fills the rest of the world and is not enumerable, so a predicate that matches air finds
   * none of it.
   */
  findBlocks(options: FindOptions & { point: Vec3 }): Vec3[] {
    const { matching } = options;
    const point = options.point.floored();
    const maxDistance = options.maxDistance || 16;
    const count = options.count || 1;
    const extra = typeof options.useExtraInfo === "function" ? options.useExtraInfo : null;
    const ids = typeof matching === "number" ? [matching] : typeof matching === "function" ? null : matching;
    const palette = new Map<string, boolean>();
    const test = (block: Block): boolean => {
      if (ids) return ids.includes(block.type);
      const matches = matching as (block: Block) => boolean;
      const state = `${block.name}:${JSON.stringify(block.getProperties())}`;
      let inPalette = palette.get(state);
      if (inPalette === undefined) {
        inPalette = matches(this.#Block.fromProperties(block.name, block.getProperties(), 0));
        palette.set(state, inPalette);
      }
      return inPalette && matches(block);
    };
    const hits: { pos: Vec3; distance: number }[] = [];
    const consider = (block: Block) => {
      const distance = block.position.distanceTo(point);
      if (distance <= maxDistance && test(block) && (!extra || extra(block))) hits.push({ pos: block.position.clone(), distance });
    };
    for (const block of this.#set.values()) consider(block);
    const ground = this.ground;
    if (ground && Math.abs(ground.y - point.y) <= maxDistance) {
      const groundId = this.#registry.blocksByName[ground.name]?.id;
      // Ids that cannot be the ground skip the layer without making a block per cell.
      if (!ids || (groundId !== undefined && ids.includes(groundId))) {
        const reach = Math.ceil(maxDistance);
        const [cx, cz] = [Math.floor(point.x), Math.floor(point.z)];
        for (let x = cx - reach; x <= cx + reach; x++) {
          for (let z = cz - reach; z <= cz + reach; z++) {
            if (this.#set.has(key(x, ground.y, z))) continue;
            consider(this.blockAt(new Vec3(x, ground.y, z)));
          }
        }
      }
    }
    return hits
      .sort((a, b) => a.distance - b.distance || a.pos.y - b.pos.y || a.pos.x - b.pos.x || a.pos.z - b.pos.z)
      .slice(0, count)
      .map((hit) => hit.pos);
  }
}
