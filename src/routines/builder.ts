// The builder routines: build structures from blueprints, calling the place and inventory primitives.
// The blueprint format lives here because it is these routines' argument.
import { defineRoutine, Point, Position, type RoutineContext, toVec3, Vec3, z } from "minebot-sdk/routine";
import * as place from "minebot-sdk/routines/place";
import * as inventory from "minebot-sdk/routines/inventory";

export const description = "Place blocks and build structures from blueprints. Blueprints: { palette: { '#': 'oak_planks' }, layers: [layer, ...] }; layers go bottom to top, rows run along +z, characters along +x, '.' or space skips.";
export const uses = ["move", "sense", "dig", "place", "inventory"] as const;

/**
 * A structure to build. `layers` go bottom to top. In each layer, rows run along +z and
 * characters along +x. `.` and space leave a position untouched.
 */
const Blueprint = z.object({
  palette: z.record(z.string().length(1), z.string().min(1)),
  layers: z.array(z.union([z.string(), z.array(z.string())])).min(1),
});
type Blueprint = z.infer<typeof Blueprint>;

interface BlueprintBlock {
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

interface BuildResult {
  placed: number;
  alreadyCorrect: number;
  failed: { position: Vec3; block: string; reason: string }[];
}

async function buildBlueprint(ctx: RoutineContext, blueprint: Blueprint, origin: Vec3, partial = false): Promise<BuildResult> {
  const { bot } = ctx;
  const targets = blueprintBlocks(blueprint).map((b) => ({ position: origin.offset(b.dx, b.dy, b.dz), block: b.block }));
  const todo = targets.filter((t) => bot.blockAt(t.position)?.name !== t.block);
  const needed: Record<string, number> = {};
  for (const t of todo) needed[t.block] = (needed[t.block] ?? 0) + 1;
  const short = (
    await Promise.all(Object.entries(needed).map(async ([block, n]) => [block, n - (await inventory.count(ctx, { items: block }))] as const))
  ).filter(([, missing]) => missing > 0);
  if (short.length > 0 && !partial) {
    throw new Error(`missing materials: ${short.map(([b, n]) => `${b} x${n}`).join(", ")} (pass { partial: true } to build what you can)`);
  }
  const result: BuildResult = { placed: 0, alreadyCorrect: targets.length - todo.length, failed: [] };
  // Bottom layer first; within a layer, nearest first.
  todo.sort((a, b) => a.position.y - b.position.y || a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  for (const t of todo) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      if (await place.place(ctx, { at: t.position, item: t.block })) result.placed++;
    } catch (err) {
      result.failed.push({ position: t.position, block: t.block, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  ctx.log(`build: placed ${result.placed}, already correct ${result.alreadyCorrect}, failed ${result.failed.length}`);
  return result;
}

interface BuildCheck {
  correct: number;
  total: number;
  mismatches: { position: Vec3; expected: string; actual: string }[];
}

function checkBuild(ctx: RoutineContext, blueprint: Blueprint, origin: Vec3): BuildCheck {
  const blocks = blueprintBlocks(blueprint);
  const mismatches: BuildCheck["mismatches"] = [];
  for (const b of blocks) {
    const position = origin.offset(b.dx, b.dy, b.dz);
    const actual = ctx.bot.blockAt(position)?.name ?? "unloaded";
    if (actual !== b.block) mismatches.push({ position, expected: b.block, actual });
  }
  return { correct: blocks.length - mismatches.length, total: blocks.length, mismatches: mismatches.slice(0, 20) };
}

export const materials = defineRoutine(
  {
    name: "builder.materials",
    description: "Block counts the `blueprint` needs, e.g. { oak_planks: 24 }.",
    args: z.object({ blueprint: Blueprint }),
    returns: z.record(z.string(), z.number()),
  },
  (_, { blueprint }) => blueprintMaterials(blueprint),
);

export const build = defineRoutine(
  {
    name: "builder.build",
    description: "Build the `blueprint` with its first layer's first row's first character at `origin`. Skips blocks already correct, places bottom-up. Fails up front on missing materials unless `partial`. Returns { placed, alreadyCorrect, failed }.",
    args: z.object({
      blueprint: Blueprint,
      origin: Position,
      partial: z.boolean().default(false),
    }),
    returns: z.object({
      placed: z.number(),
      alreadyCorrect: z.number(),
      failed: z.array(z.object({ position: Point, block: z.string(), reason: z.string() })),
    }),
  },
  (ctx, { blueprint, origin, partial }) => buildBlueprint(ctx, blueprint, toVec3(origin).floored(), partial),
);

export const check = defineRoutine(
  {
    name: "builder.check",
    description: "Compare the world with the `blueprint` at `origin`: { correct, total, mismatches (first 20) }.",
    args: z.object({ blueprint: Blueprint, origin: Position }),
    returns: z.object({
      correct: z.number(),
      total: z.number(),
      mismatches: z.array(z.object({ position: Point, expected: z.string(), actual: z.string() })),
    }),
  },
  (ctx, { blueprint, origin }) => checkBuild(ctx, blueprint, toVec3(origin).floored()),
);
