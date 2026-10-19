// The builder kit: build structures from blueprints — built from the move, sense, dig, place,
// and inventory primitives. The blueprint format lives here because it is this kit's argument.
import { Vec3 } from "vec3";
import { z } from "zod";
import { action, defineKit, type KitContext, Position, toVec3 } from "../kit.ts";

/**
 * A structure to build. `layers` go bottom to top. In each layer, rows run along +z and
 * characters along +x. `.` and space leave a position untouched.
 */
export const Blueprint = z.object({
  palette: z.record(z.string().length(1), z.string().min(1)),
  layers: z.array(z.union([z.string(), z.array(z.string())])).min(1),
});
export type Blueprint = z.infer<typeof Blueprint>;

export interface BlueprintBlock {
  dx: number;
  dy: number;
  dz: number;
  block: string;
}

const SKIP = new Set([".", " "]);

/** Removes blank edge lines and common indentation, so layers can be written as template literals. */
function layerRows(layer: string | string[]): string[] {
  const lines = Array.isArray(layer) ? layer : layer.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  const rows = lines.slice(start, end);
  const indent = Math.min(...rows.filter((r) => r.trim() !== "").map((r) => r.length - r.trimStart().length));
  return rows.map((r) => r.slice(indent));
}

/** Every block a blueprint places, as offsets from its origin. */
export function blueprintBlocks(blueprint: Blueprint): BlueprintBlock[] {
  const blocks: BlueprintBlock[] = [];
  blueprint.layers.forEach((layer, dy) => {
    layerRows(layer).forEach((row, dz) => {
      [...row].forEach((ch, dx) => {
        if (SKIP.has(ch)) return;
        const block = blueprint.palette[ch];
        if (!block) throw new Error(`blueprint layer ${dy}, row ${dz}: character "${ch}" is not in the palette`);
        blocks.push({ dx, dy, dz, block: block.replace(/^minecraft:/, "") });
      });
    });
  });
  return blocks;
}

/** Block counts a blueprint needs, e.g. { oak_planks: 24 }. */
export function blueprintMaterials(blueprint: Blueprint): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const { block } of blueprintBlocks(blueprint)) totals[block] = (totals[block] ?? 0) + 1;
  return totals;
}

export interface BuildResult {
  placed: number;
  alreadyCorrect: number;
  failed: { position: Vec3; block: string; reason: string }[];
}

export async function build(ctx: KitContext, blueprint: Blueprint, origin: Vec3, partial = false): Promise<BuildResult> {
  const { bot } = ctx;
  const targets = blueprintBlocks(blueprint).map((b) => ({ position: origin.offset(b.dx, b.dy, b.dz), block: b.block }));
  const todo = targets.filter((t) => bot.blockAt(t.position)?.name !== t.block);
  const needed: Record<string, number> = {};
  for (const t of todo) needed[t.block] = (needed[t.block] ?? 0) + 1;
  const short = Object.entries(needed)
    .map(([block, n]) => [block, n - (ctx.kits.inventory!.count!({ items: block }) as number)] as const)
    .filter(([, missing]) => missing > 0);
  if (short.length > 0 && !partial) {
    throw new Error(`missing materials: ${short.map(([b, n]) => `${b} x${n}`).join(", ")} (pass { partial: true } to build what you can)`);
  }
  const result: BuildResult = { placed: 0, alreadyCorrect: targets.length - todo.length, failed: [] };
  // Bottom layer first; within a layer, nearest first.
  todo.sort((a, b) => a.position.y - b.position.y || a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  for (const t of todo) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      if ((await ctx.kits.place!.place!({ at: t.position, item: t.block })) as boolean) result.placed++;
    } catch (err) {
      result.failed.push({ position: t.position, block: t.block, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  ctx.log(`build: placed ${result.placed}, already correct ${result.alreadyCorrect}, failed ${result.failed.length}`);
  return result;
}

export interface BuildCheck {
  correct: number;
  total: number;
  mismatches: { position: Vec3; expected: string; actual: string }[];
}

export function checkBuild(ctx: KitContext, blueprint: Blueprint, origin: Vec3): BuildCheck {
  const blocks = blueprintBlocks(blueprint);
  const mismatches: BuildCheck["mismatches"] = [];
  for (const b of blocks) {
    const position = origin.offset(b.dx, b.dy, b.dz);
    const actual = ctx.bot.blockAt(position)?.name ?? "unloaded";
    if (actual !== b.block) mismatches.push({ position, expected: b.block, actual });
  }
  return { correct: blocks.length - mismatches.length, total: blocks.length, mismatches: mismatches.slice(0, 20) };
}

export const builder = defineKit({
  name: "builder",
  description: "Place blocks and build structures from blueprints. Blueprints: { palette: { '#': 'oak_planks' }, layers: [layer, ...] }; layers go bottom to top, rows run along +z, characters along +x, '.' or space skips.",
  uses: ["move", "sense", "dig", "place", "inventory"],
  actions: {
    materials: action({
      doc: "Block counts the `blueprint` needs, e.g. { oak_planks: 24 }.",
      args: z.object({ blueprint: Blueprint }),
      run: (_, { blueprint }) => blueprintMaterials(blueprint),
    }),
    build: action({
      doc: "Build the `blueprint` with its first layer's first row's first character at `origin`. Skips blocks already correct, places bottom-up. Fails up front on missing materials unless `partial`. Returns { placed, alreadyCorrect, failed }.",
      args: z.object({
        blueprint: Blueprint,
        origin: Position,
        partial: z.boolean().default(false),
      }),
      run: (ctx, { blueprint, origin, partial }) => build(ctx, blueprint, toVec3(origin).floored(), partial),
    }),
    check: action({
      doc: "Compare the world with the `blueprint` at `origin`: { correct, total, mismatches (first 20) }.",
      args: z.object({ blueprint: Blueprint, origin: Position }),
      run: (ctx, { blueprint, origin }) => checkBuild(ctx, blueprint, toVec3(origin).floored()),
    }),
  },
});
