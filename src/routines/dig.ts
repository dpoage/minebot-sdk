// The dig routines: digging one block with the right tool, keeping falling blocks from refilling it.
import { type Bot, type Block, defineRoutine, isAir, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Dig one block with the right tool; falling blocks that refill the hole are dug too.";
export const uses = [] as const;

/** A server's longest answer to a finished dig: it came 17-105 ms after the dig on a local server; this allows a remote server's round trip. */
const CONFIRM_MS = 3_000;
/** The server breaks a block only when its box is closer than this to the player's eyes (survival: 4.5 interaction range + 1). */
const SERVER_REACH = 5.5;
/** Player eye height above the feet, standing. */
const EYE_HEIGHT = 1.62;
/** Fluids are a clear cell like air: there is nothing to dig, and the server breaks seagrass into water. */
const FLUIDS = new Set(["water", "lava", "bubble_column"]);

interface DigResult {
  /** The last block that was dug, or null when the position was already clear. */
  block: string | null;
}

const isClear = (block: Block) => isAir(block) || FLUIDS.has(block.name);

/** Distance from the player's eyes to the nearest point of the 1x1x1 box of the block at `pos`: the distance the server measures. */
function boxDistance(bot: Bot, pos: Vec3): number {
  const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  const gap = (eye: number, low: number) => Math.max(low - eye, 0, eye - (low + 1));
  return Math.hypot(gap(eyes.x, pos.x), gap(eyes.y, pos.y), gap(eyes.z, pos.z));
}

/**
 * Starts listening for the server's answer to a dig at `pos`. Mineflayer resolves `bot.dig` on its own
 * prediction (a blockUpdate to air it makes itself) before the server answers, so only updates that arrive
 * after `armed()` count: those came from the server's block_change / multi_block_change. `confirmed` settles
 * true when such an update leaves the cell in a state other than `stateId`, the state that was dug.
 */
function watchServerBreak(bot: Bot, pos: Vec3, stateId: number) {
  let armed = false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onUpdate = (_old: Block | null, next: Block | null) => {
    if (armed && next && next.position.equals(pos) && next.stateId !== stateId) resolve(true);
  };
  bot.on("blockUpdate", onUpdate);
  return {
    arm: () => {
      armed = true;
    },
    /** Resolves true on the server's update; false after `ms` without one. */
    confirmed: (ms: number) => {
      const timer = setTimeout(resolve, ms, false);
      return promise.finally(() => clearTimeout(timer));
    },
    stop: () => {
      bot.off("blockUpdate", onUpdate);
    },
  };
}

/** The error for a dig the server did not answer with a break, after the client's view of the cell was put back to the dug block. */
function refusal(bot: Bot, block: Block): Error {
  const where = `${block.position}`;
  const point = `{ x: ${block.position.x}, y: ${block.position.y}, z: ${block.position.z} }`;
  const distance = boxDistance(bot, block.position);
  if (distance >= SERVER_REACH) {
    return new Error(
      `the server refused to dig ${block.name} at ${where}: its box is ${distance.toFixed(2)} blocks from your eyes and the server digs only closer than ${SERVER_REACH}. ` +
        `Walk next to it with move.to({ position: ${point}, range: 3 }), then dig again.`,
    );
  }
  return new Error(
    `the server did not break ${block.name} at ${where} within ${CONFIRM_MS / 1000} s although it is in reach (${distance.toFixed(2)} blocks from your eyes; limit ${SERVER_REACH}); ` +
      `it is still there. Spawn protection or adventure mode stops digs; try a different block, or move.to({ position: ${point}, range: 3 }) and dig again.`,
  );
}

/**
 * Digs the block at `pos`, keeping digging while falling blocks (gravel, sand) refill the
 * position. Equips the best harvest tool and fails with the tools the block needs when the
 * inventory has none of them. Success is the server's block update at the position, not the
 * client's own prediction; without one the client's view of the cell is put back and the dig fails.
 */
async function digAt(ctx: RoutineContext, pos: Vec3): Promise<DigResult> {
  const { bot } = ctx;
  let dug: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const block = bot.blockAt(pos);
    if (!block) throw new Error(`${pos} is not loaded`);
    if (isClear(block)) return { block: dug };
    if (!block.diggable) throw new Error(`${block.name} at ${pos} cannot be dug`);
    const tool = bot.pathfinder.bestHarvestTool(block);
    if (tool) await bot.equip(tool, "hand");
    if (!block.canHarvest(bot.heldItem?.type ?? null)) {
      const tools = Object.keys(block.harvestTools ?? {}).map((id) => bot.registry.items[Number(id)]?.name);
      throw new Error(`${block.name} needs one of: ${tools.join(", ")}`);
    }
    const watch = watchServerBreak(bot, pos, block.stateId);
    try {
      await within(30_000, `digging ${block.name}`, bot.dig(block, true), () => bot.stopDigging());
      watch.arm();
      if (!(await watch.confirmed(CONFIRM_MS))) {
        if (bot.blockAt(pos)?.stateId !== block.stateId) bot.world.setBlockStateId(pos, block.stateId);
        throw refusal(bot, block);
      }
    } finally {
      watch.stop();
    }
    dug = block.name;
    await ctx.sleep(250); // let a falling block land
  }
  throw new Error(`${pos} keeps refilling`);
}

export const dig = defineRoutine(
  {
    name: "dig.dig",
    description:
      "Dig the block at `at` ({x,y,z} or [x,y,z]) and wait for the server to confirm the break: signs, torches, flowers and grass are dug like stone. It does not walk: a block whose box is 5.5 blocks or more from your eyes (the server's reach) throws naming the block, the distance and the move.to call to make first. Equips the best tool and fails with the tools it needs when the inventory lacks them. Throws when the server does not break the block within 3 s (the block is then still there). Digs on while gravel or sand refills the position. Returns { block } — the last block dug, or null when the position was already clear (air or fluid).",
    args: z.object({ at: Position }),
    returns: z.object({ block: z.string().nullable() }),
  },
  (ctx, { at }) => digAt(ctx, toVec3(at).floored()),
);
