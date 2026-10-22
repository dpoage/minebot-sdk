// The furnace routines: smelting at a furnace that is within reach — loading fuel and input, waiting
// for the output, and taking it. Finding or placing a furnace is the crafter routines' work.
import { type Block, burnTicks, defineRoutine, type Furnace, goals, type Item, pickFuel, Point, Position, type RoutineContext, SMELT_TICKS, smeltOutput, toVec3, Vec3, within, withoutReserved, z } from "minebot-sdk/routine";

export const description = "Smelt at a furnace within reach: load fuel and input, wait, take the output.";
export const uses = [] as const;

/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const OPEN_TIMEOUT_MS = 8_000;
const POLL_MS = 500;
const SLACK_MS = 15_000;
const FURNACE_BLOCKS = ["furnace", "blast_furnace", "smoker"];

/**
 * The furnace window as Mineflayer fills it in at runtime: its typings claim the slots are never
 * empty. `burnLeft` is ticks of burning left, which `open` tracks from the server's bar packets.
 */
type FurnaceWindow = Omit<Furnace, "inputItem" | "fuelItem" | "outputItem"> & {
  burnLeft: number | null;
  inputItem(): Item | null;
  fuelItem(): Item | null;
  outputItem(): Item | null;
};

/** Input that still has to go into the furnace. */
interface Reserve {
  item: string;
  count: number;
}

function heldTotals(ctx: RoutineContext): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of ctx.bot.inventory.items()) totals[item.name] = (totals[item.name] ?? 0) + item.count;
  return totals;
}

function eyeDistance(ctx: RoutineContext, pos: Vec3): number {
  return ctx.bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
}

/** The nearest plain furnace within reach of the player's eyes, or null. */
function furnaceInReach(ctx: RoutineContext): Block | null {
  const { bot } = ctx;
  const id = bot.registry.blocksByName.furnace!.id;
  const reachable = bot
    .findBlocks({ matching: id, maxDistance: 6, count: 16 })
    .filter((p) => eyeDistance(ctx, p) <= REACH)
    .sort((a, b) => eyeDistance(ctx, a) - eyeDistance(ctx, b));
  return reachable[0] ? bot.blockAt(reachable[0]) : null;
}

/** The furnace block to use: the one at `at` (walking next to it first), else the nearest within reach. */
async function locate(ctx: RoutineContext, at: Position | undefined): Promise<Block> {
  const { bot } = ctx;
  if (at === undefined) {
    const found = furnaceInReach(ctx);
    if (!found) throw new Error(`no furnace within ${REACH} blocks; stand next to one, place one, or pass \`at\``);
    return found;
  }
  const pos = toVec3(at).floored();
  const block = bot.blockAt(pos);
  if (!block) throw new Error(`${pos} is not loaded`);
  if (!FURNACE_BLOCKS.includes(block.name)) throw new Error(`no furnace at ${pos}; the block there is ${block.name}`);
  if (eyeDistance(ctx, pos) > REACH) {
    await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), () => bot.pathfinder.setGoal(null));
  }
  return block;
}

/**
 * Opens the furnace and tracks its burn time. On 26.1 a lit furnace that Mineflayer opens reads
 * `fuelSeconds` 0 and `totalFuel` null (observed): its total-burn packet arrives before Mineflayer
 * listens, and is only sent again when the fuel type changes. Property 0, the ticks of burning
 * left, is sent again every tick while the furnace burns, so this listener catches it.
 */
async function open(ctx: RoutineContext, block: Block): Promise<FurnaceWindow> {
  const { bot } = ctx;
  const opened = Object.assign(await within(OPEN_TIMEOUT_MS, `opening the ${block.name}`, bot.openFurnace(block), () => {}), { burnLeft: null as number | null });
  const furnace: FurnaceWindow = opened;
  const onBar = (packet: { windowId: number; property: number; value: number }) => {
    if (packet.windowId === furnace.id && packet.property === 0) furnace.burnLeft = packet.value;
  };
  bot._client.on("craft_progress_bar", onBar);
  furnace.once("close", () => bot._client.off("craft_progress_bar", onBar));
  if (block.getProperties().lit) {
    for (let wait = 0; wait < 20 && furnace.burnLeft === null; wait++) await ctx.sleep(50);
  } else {
    furnace.burnLeft = 0;
  }
  return furnace;
}

/** Item totals in the player's slots of the open furnace window. `bot.inventory` does not follow clicks while a window is open, so counts taken from it go stale. */
function windowTotals(furnace: FurnaceWindow): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd)) {
    if (item) totals[item.name] = (totals[item.name] ?? 0) + item.count;
  }
  return totals;
}

/**
 * Adds to the furnace's fuel slot enough of `fuel` (or the default fuel) to smelt `items` more
 * items. `reserve` is the input that still has to go into the furnace: it is not fuel, even when
 * it is the same item (logs smelting into charcoal). Returns what it added.
 */
async function addFuel(ctx: RoutineContext, furnace: FurnaceWindow, items: number, fuel: string | undefined, reserve: Reserve): Promise<Record<string, number>> {
  const slot = furnace.fuelItem();
  const burning = furnace.burnLeft ?? 0;
  const queued = slot ? slot.count * burnTicks(slot.name) : 0;
  const needed = items * SMELT_TICKS - burning - queued;
  if (needed <= 0) return {};
  const total = windowTotals(furnace);
  const held = withoutReserved(total, reserve.item, reserve.count);
  // A fuel slot holds one kind of item: keep using the one that is in it.
  const choice = pickFuel(held, needed, slot ? slot.name : fuel);
  if (!choice) {
    const wanted = slot ? ` (the furnace already holds ${slot.name})` : fuel ? ` of ${fuel}` : "";
    throw new Error(`not enough fuel${wanted}: smelting ${items} takes ${needed / 20} s of burning; after setting aside the ${reserve.count} ${reserve.item} to smelt, the inventory holds ${JSON.stringify(held)}; pass \`fuel\` or gather coal, charcoal, planks, or logs`);
  }
  const def = ctx.bot.registry.itemsByName[choice.item]!;
  const count = Math.min(choice.count, def.stackSize - (slot?.count ?? 0));
  if (count <= 0) return {};
  await furnace.putFuel(def.id, null, count);
  return { [choice.item]: count };
}

function merge(into: Record<string, number>, from: Record<string, number>): void {
  for (const [name, n] of Object.entries(from)) into[name] = (into[name] ?? 0) + n;
}

/** Takes whatever is in the output slot into the inventory. Returns its name and count, or null when it is empty. */
async function takeOutput(furnace: FurnaceWindow): Promise<{ name: string; count: number } | null> {
  const out = furnace.outputItem();
  if (!out) return null;
  const taken = { name: out.name, count: out.count };
  await furnace.takeOutput();
  return taken;
}

export interface SmeltResult {
  /** The item smelted. */
  input: string;
  /** What it became. */
  output: string;
  /** How many `output` items the inventory gained. */
  count: number;
  /** Fuel loaded, e.g. { coal: 1 }. */
  fuel: Record<string, number>;
  at: { x: number; y: number; z: number };
}

/**
 * Smelts `count` of `item` at a furnace and takes the output. The furnace's fuel and input slots
 * hold one kind of item each, so a furnace busy with another input is refused, and input
 * beyond one stack goes in as the earlier batch finishes.
 */
export async function smeltItems(ctx: RoutineContext, item: string, count: number, fuel: string | undefined, at: Position | undefined): Promise<SmeltResult> {
  const { bot } = ctx;
  const input = item.replace(/^minecraft:/, "");
  const def = bot.registry.itemsByName[input];
  if (!def) throw new Error(`unknown item "${item}"`);
  const output = smeltOutput(input);
  if (!output) throw new Error(`${input} has no smelting recipe; try its ore, raw item, raw meat, sand, cobblestone, or a log`);
  const held = heldTotals(ctx)[input] ?? 0;
  if (held < count) throw new Error(`need ${count} ${input} but the inventory holds ${held}`);
  const block = await locate(ctx, at);
  const furnace = await open(ctx, block);
  const used: Record<string, number> = {};
  const before = heldTotals(ctx)[output] ?? 0;
  try {
    // Old output would stop the furnace once the slot holds a different item, or push the count past a stack.
    await takeOutput(furnace);
    const busy = furnace.inputItem();
    if (busy && busy.name !== input) throw new Error(`the furnace is already smelting ${busy.count} ${busy.name}; take it first with furnace.take`);
    let remaining = count;
    while (remaining > 0) {
      const existing = furnace.inputItem()?.count ?? 0;
      const batch = Math.min(remaining, def.stackSize - existing);
      if (batch <= 0) throw new Error(`the furnace input slot is full of ${input}`);
      merge(used, await addFuel(ctx, furnace, existing + batch, fuel, { item: input, count: remaining }));
      await furnace.putInput(def.id, null, batch);
      const target = existing + batch;
      const deadline = Date.now() + target * (SMELT_TICKS / 20) * 1000 + SLACK_MS;
      for (;;) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        const ready = furnace.outputItem();
        if (ready && ready.count >= target) break;
        const waiting = furnace.inputItem();
        if (!waiting) break;
        if (Date.now() > deadline) {
          await takeOutput(furnace);
          throw new Error(`smelting ${input} took longer than expected; the furnace still holds ${waiting.count} ${input}; collect later with furnace.take`);
        }
        // Fuel that burns out before the input is done: add more of the same kind.
        if (!furnace.fuelItem() && !furnace.burnLeft) merge(used, await addFuel(ctx, furnace, waiting.count, fuel, { item: input, count: remaining - batch }));
        await ctx.sleep(POLL_MS);
      }
      await takeOutput(furnace);
      remaining -= batch;
    }
  } finally {
    furnace.close();
  }
  const gained = (heldTotals(ctx)[output] ?? 0) - before;
  ctx.log(`smelted ${gained} ${output} from ${input}`);
  return { input, output, count: gained, fuel: used, at: { x: block.position.x, y: block.position.y, z: block.position.z } };
}

/** Takes the output of the furnace at `at` (or within reach) without adding anything. */
export async function takeFurnaceOutput(ctx: RoutineContext, at: Position | undefined) {
  const block = await locate(ctx, at);
  const furnace = await open(ctx, block);
  try {
    const taken = await takeOutput(furnace);
    const left = furnace.inputItem();
    return {
      item: taken?.name ?? null,
      count: taken?.count ?? 0,
      smelting: left ? { item: left.name, count: left.count } : null,
    };
  } finally {
    furnace.close();
  }
}

export const smelt = defineRoutine(
  {
    name: "furnace.smelt",
    description: "Smelt `count` (default 1) of `item` (an input such as raw_iron, sand, cobblestone, beef, or a log) at the nearest furnace within 4.5 blocks, or at `at` ({x,y,z} or [x,y,z]), walking next to it first. Loads `fuel` (an item name) or else the first of charcoal, coal, planks, logs, sticks that the inventory holds in enough quantity; waits 10 s per item; takes the output. Fails with the missing item or fuel, or when no furnace is there. Returns { input, output, count, fuel, at }.",
    args: z.object({
      item: z.string().min(1),
      count: z.number().int().positive().default(1),
      fuel: z.string().min(1).optional(),
      at: Position.optional(),
    }),
    returns: z.object({
      input: z.string(),
      output: z.string(),
      count: z.number(),
      fuel: z.record(z.string(), z.number()),
      at: Point,
    }),
  },
  (ctx, { item, count, fuel, at }) => smeltItems(ctx, item, count, fuel, at),
);

export const take = defineRoutine(
  {
    name: "furnace.take",
    description: "Collect the output of the furnace within 4.5 blocks, or at `at`, without waiting for it. Returns { item, count, smelting }: what was taken (item null when the slot was empty) and what the furnace is still smelting, or null.",
    args: z.object({ at: Position.optional() }),
    returns: z.object({
      item: z.string().nullable(),
      count: z.number(),
      smelting: z.object({ item: z.string(), count: z.number() }).nullable(),
    }),
  },
  (ctx, { at }) => takeFurnaceOutput(ctx, at),
);
