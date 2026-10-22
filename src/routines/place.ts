// The place routines: placing one block from the inventory, clearing what is in the way.
import { defineRoutine, goals, isAir, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Place one block from the inventory, digging out a different solid block first.";
export const uses = [] as const;

const NEIGHBORS = [
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, 1, 0),
];

/**
 * Places `item` at `pos`, clearing a different solid block there first. Returns false when it
 * was already there. Needs a solid neighbor to place against.
 */
export async function placeAt(ctx: RoutineContext, pos: Vec3, item: string): Promise<boolean> {
  const { bot } = ctx;
  const name = item.replace(/^minecraft:/, "");
  const current = bot.blockAt(pos);
  if (!current) throw new Error(`${pos} is not loaded`);
  if (current.name === name) return false;

  const center = pos.offset(0.5, 0.5, 0.5);
  // Survival players interact with blocks up to 4.5 blocks from the eyes.
  if (bot.entity.position.offset(0, 1.6, 0).distanceTo(center) > 4.5) {
    await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), () => bot.pathfinder.setGoal(null));
  }
  // Clear anything but air and fluids, including thin blocks like leaf_litter or short_grass
  // that have no collision box; the server does not always replace them.
  if (!isAir(current) && !/water|lava/.test(current.name) && current.diggable) {
    const tool = bot.pathfinder.bestHarvestTool(current);
    if (tool) await bot.equip(tool, "hand");
    await within(20_000, `clearing ${current.name}`, bot.dig(current), () => bot.stopDigging());
  }
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await within(10_000, "pathfinding", bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1))), () =>
      bot.pathfinder.setGoal(null),
    );
  }
  const reference = NEIGHBORS.map((d) => bot.blockAt(pos.plus(d))).find((b) => b?.boundingBox === "block");
  if (!reference) throw new Error(`nothing solid next to ${pos} to place against`);
  const stack = bot.inventory.items().find((i) => i.name === name);
  if (!stack) throw new Error(`no ${name} in inventory`);
  await bot.equip(stack, "hand");
  await bot.placeBlock(reference, pos.minus(reference.position));
  return true;
}

export const place = defineRoutine(
  {
    name: "place.place",
    description: "Place one block of `item` at `at` ({x,y,z} or [x,y,z]), walking close and digging out a different solid block first. Needs a solid neighbor to place against. Returns false if the block was already there, true otherwise.",
    args: z.object({ at: Position, item: z.string().min(1) }),
    returns: z.boolean(),
  },
  (ctx, { at, item }) => placeAt(ctx, toVec3(at).floored(), item),
);
