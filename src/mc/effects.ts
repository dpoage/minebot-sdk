// Active potion effects of the player. Mineflayer keeps the duration from the packet that applied
// an effect and never counts it down, so the time each packet arrived is kept beside it.
import type { Bot } from "mineflayer";
import type { EffectSummary } from "../protocol/index.ts";

const TICK_MS = 50;

/** The arrival time of each effect object Mineflayer stores on the player. */
const appliedAt = new WeakMap<object, number>();

/** Starts recording when the player's effects arrive. Call once per bot, before it joins. */
export function trackEffects(bot: Bot): void {
  bot.on("entityEffect", (entity, effect) => {
    if (entity === bot.entity) appliedAt.set(effect, Date.now());
  });
}

/** `MiningFatigue` as `mining_fatigue`: the names commands use. */
function snakeCase(name: string): string {
  return name.replace(/(?<=[a-z])(?=[A-Z])/g, "_").toLowerCase();
}

/** The effects on the player now, with the seconds each has left. */
export function activeEffects(bot: Bot, now = Date.now()): EffectSummary[] {
  return Object.values(bot.entity.effects).map((effect) => {
    const name = bot.registry.effects[effect.id]?.name;
    const summary: EffectSummary = { name: name ? snakeCase(name) : `effect_${effect.id}`, amplifier: effect.amplifier };
    // A duration of -1 is an effect that does not run out.
    const start = appliedAt.get(effect);
    if (effect.duration >= 0 && start !== undefined) {
      summary.remaining = Math.max(0, Math.round((effect.duration * TICK_MS - (now - start)) / 1000));
    }
    return summary;
  });
}
