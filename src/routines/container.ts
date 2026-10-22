// The container routines: looking into chests, barrels, and shulker boxes, and moving items between
// them and the inventory.
import { type Block, type Chest, defineRoutine, goals, type Item, nameMatcher, NamePattern, Position, type RoutineContext, toVec3, within, z } from "minebot-sdk/routine";

export const description = "Look into chests, barrels, and shulker boxes, and move items between them and the inventory.";
export const uses = [] as const;

/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const OPEN_TIMEOUT_MS = 8_000;
const SETTLE_MS = 150;
/** The blocks Mineflayer's openContainer accepts. */
const CONTAINER_BLOCK = /^(?:chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|(?:[a-z_]+_)?shulker_box)$/;

interface ContainerContents {
  /** The container block, e.g. "chest". */
  block: string;
  /** Totals by item name. */
  items: Record<string, number>;
  /** Slots with nothing in them. */
  emptySlots: number;
}

/** How many more of `type` fit into `slots`: empty slots take a stack, partial stacks of the same item take the rest. */
export function roomFor(slots: readonly (Item | null | undefined)[], type: number, stackSize: number): number {
  let room = 0;
  for (const slot of slots) {
    if (!slot) room += stackSize;
    else if (slot.type === type) room += Math.max(0, stackSize - slot.count);
  }
  return room;
}

function totals(items: readonly Item[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[item.name] = (result[item.name] ?? 0) + item.count;
  return result;
}

/** Opens the container at `at`, walking next to it first when it is out of reach. */
async function open(ctx: RoutineContext, at: Position): Promise<{ block: Block; chest: Chest }> {
  const { bot } = ctx;
  const pos = toVec3(at).floored();
  const block = bot.blockAt(pos);
  if (!block) throw new Error(`${pos} is not loaded`);
  if (!CONTAINER_BLOCK.test(block.name)) throw new Error(`no container at ${pos}; the block there is ${block.name}`);
  if (bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > REACH) {
    await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), () => bot.pathfinder.setGoal(null));
  }
  const chest = (await within(OPEN_TIMEOUT_MS, `opening the ${block.name}`, bot.openContainer(block), () => {})) as Chest;
  return { block, chest };
}

/** The container's own slots and the player's slots in its window. */
function sides(chest: Chest): { container: (Item | null)[]; player: (Item | null)[] } {
  return { container: chest.slots.slice(0, chest.inventoryStart), player: chest.slots.slice(chest.inventoryStart, chest.inventoryEnd) };
}

async function listContainer(ctx: RoutineContext, at: Position): Promise<ContainerContents> {
  const { block, chest } = await open(ctx, at);
  try {
    const { container } = sides(chest);
    return {
      block: block.name,
      items: totals(container.filter((i): i is Item => i !== null)),
      emptySlots: container.filter((i) => i === null).length,
    };
  } finally {
    chest.close();
  }
}

/**
 * Moves up to `count` (default all) of the matching items one way, one item kind at a time, as
 * many as the destination has room for. `from` is the side the items leave.
 */
async function transfer(ctx: RoutineContext, at: Position, pattern: NamePattern, count: number | undefined, from: "inventory" | "container") {
  const matches = nameMatcher(pattern);
  const { block, chest } = await open(ctx, at);
  const moved: Record<string, number> = {};
  let left = count ?? Infinity;
  let full = false;
  try {
    const source = from === "inventory" ? sides(chest).player : sides(chest).container;
    const kinds = new Map<number, { name: string; count: number; stackSize: number }>();
    for (const item of source) {
      if (!item || !matches(item.name)) continue;
      const kind = kinds.get(item.type);
      if (kind) kind.count += item.count;
      else kinds.set(item.type, { name: item.name, count: item.count, stackSize: item.stackSize });
    }
    if (kinds.size === 0) throw new Error(`${from === "inventory" ? "the inventory" : `the ${block.name}`} holds nothing matching ${JSON.stringify(pattern)}`);
    for (const [type, kind] of kinds) {
      if (left <= 0) break;
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const destination = from === "inventory" ? sides(chest).container : sides(chest).player;
      const room = roomFor(destination, type, kind.stackSize);
      const n = Math.min(kind.count, left, room);
      if (n < Math.min(kind.count, left)) full = true;
      if (n <= 0) continue;
      if (from === "inventory") await chest.deposit(type, null, n);
      else await chest.withdraw(type, null, n);
      await ctx.sleep(SETTLE_MS);
      moved[kind.name] = (moved[kind.name] ?? 0) + n;
      left -= n;
    }
  } finally {
    chest.close();
  }
  const total = Object.values(moved).reduce((sum, n) => sum + n, 0);
  ctx.log(`${from === "inventory" ? "deposited" : "withdrew"} ${total} item(s) ${from === "inventory" ? "into" : "from"} the ${block.name}`);
  return { moved, total, full };
}

export const list = defineRoutine(
  {
    name: "container.list",
    description: "What the chest, barrel, shulker box, hopper, dispenser, or dropper at `at` ({x,y,z} or [x,y,z]) holds, walking next to it first. Returns { block, items: { name: count }, emptySlots }.",
    args: z.object({ at: Position }),
    returns: z.object({ block: z.string(), items: z.record(z.string(), z.number()), emptySlots: z.number() }),
  },
  (ctx, { at }) => listContainer(ctx, at),
);

export const deposit = defineRoutine(
  {
    name: "container.deposit",
    description: "Put inventory items matching `items` ('cobblestone', '*_log', or a list) into the container at `at`, up to `count` in total (default all that match), as many as fit. Returns { deposited: { name: count }, total, full }; `full` is true when the container had no room for some of it. Fails when nothing in the inventory matches.",
    args: z.object({ at: Position, items: NamePattern, count: z.number().int().positive().optional() }),
    returns: z.object({ deposited: z.record(z.string(), z.number()), total: z.number(), full: z.boolean() }),
  },
  async (ctx, { at, items, count }) => {
    const { moved, total, full } = await transfer(ctx, at, items, count, "inventory");
    return { deposited: moved, total, full };
  },
);

export const withdraw = defineRoutine(
  {
    name: "container.withdraw",
    description: "Take items matching `items` ('iron_ingot', '*_planks', or a list) out of the container at `at` into the inventory, up to `count` in total (default all that match), as many as fit. Returns { withdrawn: { name: count }, total, full }; `full` is true when the inventory had no room for some of it. Fails when the container holds nothing that matches.",
    args: z.object({ at: Position, items: NamePattern, count: z.number().int().positive().optional() }),
    returns: z.object({ withdrawn: z.record(z.string(), z.number()), total: z.number(), full: z.boolean() }),
  },
  async (ctx, { at, items, count }) => {
    const { moved, total, full } = await transfer(ctx, at, items, count, "container");
    return { withdrawn: moved, total, full };
  },
);
