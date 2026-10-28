// The body's reflexes that need no program: while no run holds the run slot, a player whose eyes are in water holds
// jump, so it floats to the air instead of sinking and drowning during the minutes an agent takes between calls.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

/** How high a standing player's eyes are above the position of its feet. */
const EYE_HEIGHT = 1.62;

/** Mineflayer's physics tick; the float looks again this often. */
export const FLOAT_CHECK_MS = 50;

/** Blocks that fill their cell with water. */
const WATER_BLOCKS: Record<string, true> = { water: true, kelp: true, kelp_plant: true, seagrass: true, tall_seagrass: true, bubble_column: true };

/** The run slot as the float sees it: `busy` is the recorder's, true from a run's arrival to the end of its grace. */
export interface RunSlot {
  readonly busy: boolean;
}

export interface Afloat {
  /**
   * Lets go of the jump the float holds, now. The body calls it synchronously right before a run's code starts, so the run
   * never begins with the float's jump held; the float never presses again while the slot is taken.
   */
  release(): void;
  /** Stops the float, releasing what it holds. */
  close(): void;
}

/** Whether the cell at the player's eyes holds water: a water block, a plant that grows in it, or a waterlogged block. */
export function eyesInWater(bot: Bot): boolean {
  const feet = bot.entity.position;
  const block = bot.blockAt(new Vec3(feet.x, feet.y + EYE_HEIGHT, feet.z).floored());
  if (!block) return false;
  return Object.hasOwn(WATER_BLOCKS, block.name) || block.getProperties().waterlogged === true;
}

/**
 * Holds jump on the player `getBot` returns while `slot` is free and its eyes are in water, and holds nothing otherwise.
 * It looks every physics tick, presses a jump only when none is held, and releases only a jump it pressed itself: a run's
 * controls are never touched. The bot may be replaced (a reconnect) between ticks; the old one is simply forgotten.
 */
export function keepAfloat(getBot: () => Bot | undefined, slot: RunSlot): Afloat {
  /** The bot whose jump the float holds. */
  let pressed: Bot | undefined;

  const release = () => {
    const bot = pressed;
    pressed = undefined;
    bot?.setControlState("jump", false);
  };

  const check = () => {
    const bot = getBot();
    if (pressed !== undefined && pressed !== bot) pressed = undefined;
    // A halt or a run cleared the jump the float held: it holds nothing now, and may press again.
    if (pressed !== undefined && !pressed.controlState.jump) pressed = undefined;
    if (bot?.entity === undefined || slot.busy || !eyesInWater(bot)) {
      release();
      return;
    }
    if (pressed === undefined && !bot.controlState.jump) {
      bot.setControlState("jump", true);
      pressed = bot;
    }
  };

  const timer = setInterval(check, FLOAT_CHECK_MS);
  timer.unref();
  return {
    release,
    close() {
      clearInterval(timer);
      release();
    },
  };
}
