// What the body notices happening to its own player: items it picks up, blocks it breaks, places, and
// crafts, hostile creatures that come close, and health or food running low. Each becomes an event.
import type { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { trackEffects } from "../mc/effects.ts";
import { isHostile } from "../mc/hostile.ts";
import { round, vec } from "../mc/position.ts";
import type { EventLog } from "../body/events.ts";

/** Health below this raises `low_health`. */
const LOW_HEALTH = 8;
/** Food below this raises `low_food`. */
const LOW_FOOD = 6;
/** A hostile creature this close raises `hostile_near`. */
const HOSTILE_RADIUS = 16;
/** A notified creature raises the event again only after it has been this far away or gone. */
const HOSTILE_REARM_RADIUS = 32;
/** Physics ticks between two looks at the nearby creatures: twice a second. */
const HOSTILE_CHECK_TICKS = 10;

/** Translates the player's own actions and vitals into events. Call once per bot, before it joins. */
export function watchGame(bot: Bot, events: EventLog): void {
  trackEffects(bot);

  // The packet carries the picked-up count; the collect event of Mineflayer does not.
  bot._client.on("collect", (packet: { collectedEntityId: number; collectorEntityId: number; pickupItemCount: number }) => {
    if (packet.collectorEntityId !== bot.entity?.id) return;
    const item = bot.entities[packet.collectedEntityId]?.getDroppedItem();
    if (item) events.push("item_picked_up", { item: item.name, count: packet.pickupItemCount });
  });

  // Mineflayer emits blockPlaced after the server confirmed the player's own placement; its typings omit the event.
  (bot as unknown as EventEmitter).on("blockPlaced", (_old: Block | null, block: Block) => {
    events.push("block_placed", { block: block.name, position: vec(block.position) });
  });

  // Mineflayer's own diggingCompleted event carries the air that replaced the block, so the dig call is wrapped.
  // Plugins load after createBot returns, as for the click pacing in connection.ts.
  bot.once("login", () => {
    const dig = bot.dig.bind(bot) as (block: Block, forceLook?: boolean | "ignore", digFace?: "auto" | "raycast" | Vec3) => Promise<void>;
    bot.dig = (async (block: Block, forceLook?: boolean | "ignore", digFace?: "auto" | "raycast" | Vec3) => {
      const { name, position } = block;
      await dig(block, forceLook, digFace);
      events.push("block_broken", { block: name, position: vec(position) });
    }) as typeof bot.dig;
    const craft = bot.craft.bind(bot);
    bot.craft = async (recipe, count, table) => {
      await craft(recipe, count, table);
      const item = bot.registry.items[recipe.result.id]?.name;
      if (item) events.push("item_crafted", { item, count: recipe.result.count * (count ?? 1) });
    };
  });

  // Each threshold fires once on the way down and arms again when the value is back at or above it.
  let healthArmed = true;
  let foodArmed = true;
  bot.on("health", () => {
    if (bot.health >= LOW_HEALTH) healthArmed = true;
    else if (healthArmed) {
      healthArmed = false;
      events.push("low_health", { health: round(bot.health) });
    }
    if (bot.food >= LOW_FOOD) foodArmed = true;
    else if (foodArmed) {
      foodArmed = false;
      events.push("low_food", { food: bot.food });
    }
  });

  const notified = new Set<number>();
  let ticks = 0;
  bot.on("physicsTick", () => {
    if (++ticks % HOSTILE_CHECK_TICKS !== 0 || !bot.entity) return;
    for (const id of notified) {
      const entity = bot.entities[id];
      if (!entity || entity.position.distanceTo(bot.entity.position) > HOSTILE_REARM_RADIUS) notified.delete(id);
    }
    for (const entity of Object.values(bot.entities)) {
      if (!isHostile(entity) || notified.has(entity.id)) continue;
      const distance = entity.position.distanceTo(bot.entity.position);
      if (distance > HOSTILE_RADIUS) continue;
      notified.add(entity.id);
      events.push("hostile_near", { name: entity.name, id: entity.id, distance: round(distance) });
    }
  });
}
