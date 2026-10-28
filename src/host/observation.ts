// The observation projection: the live bot as one JSON object, and that object as one line.
import type { Bot } from "mineflayer";
import { biomeAt } from "../mc/biome.ts";
import { sensesOf } from "../mc/deaths.ts";
import { activeEffects } from "../mc/effects.ts";
import { skyAbove, type SkyView } from "../mc/sky.ts";
import type { DeathSummary, EntitySummary, ItemSummary, Observation } from "../protocol/index.ts";
import { round, vec } from "../mc/position.ts";
import { droppedStack } from "../routines/items.ts";

const NEARBY_ENTITY_RADIUS = 32;
const NEARBY_ENTITY_LIMIT = 24;
/** How far the line of sight reaches, in blocks. */
const SIGHT_RANGE = 5;

function armorOf(bot: Bot): Extract<Observation, { connected: true }>["armor"] {
  const at = (destination: string) => itemIn(bot, bot.getEquipmentDestSlot(destination));
  return { head: at("head"), chest: at("torso"), legs: at("legs"), feet: at("feet") };
}

function itemIn(bot: Bot, slot: number): ItemSummary | null {
  const item = bot.inventory.slots[slot];
  return item ? { name: item.name, count: item.count, slot: item.slot } : null;
}

/** The block the player stands on: the one below the feet, or the partial block (slab, carpet) the feet are in. */
function standingOn(bot: Bot): string | null {
  const { position, onGround } = bot.entity;
  const feet = position.floored();
  const inside = onGround && position.y - feet.y > 0.01 ? bot.blockAt(feet) : null;
  const block = inside && inside.boundingBox === "block" ? inside : bot.blockAt(feet.offset(0, -1, 0));
  return block?.name ?? null;
}

/** The observation of a spawned bot. */
export function observation(
  bot: Bot,
  extras: { programsWithoutChange: number; program: { running: boolean; elapsedMs?: number } },
): Observation {
  const self = bot.entity;
  const feet = self.position.floored();
  const feetBlock = bot.blockAt(feet);
  const sight = bot.blockAtCursor(SIGHT_RANGE);
  const sky = skyAbove(bot, self.position);
  const senses = sensesOf(bot);
  const nearbyEntities: EntitySummary[] = Object.values(bot.entities)
    .filter((e) => e !== self && e.position.distanceTo(self.position) <= NEARBY_ENTITY_RADIUS)
    .map((e) => {
      // A dropped item is an entity named "item"; the stack it holds is what the player cares about.
      const stack = droppedStack(e);
      return {
        id: e.id,
        type: e.type,
        name: e.name ?? e.displayName ?? "unknown",
        ...(e.username && { username: e.username }),
        ...(stack && { item: { name: stack.name, count: stack.count } }),
        distance: round(e.position.distanceTo(self.position)),
        position: vec(e.position),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, NEARBY_ENTITY_LIMIT);
  return {
    connected: true,
    username: bot.username,
    gameMode: bot.game.gameMode,
    dimension: bot.game.dimension,
    position: vec(self.position),
    yaw: round(self.yaw),
    pitch: round(self.pitch),
    onGround: self.onGround,
    health: bot.health,
    food: bot.food,
    saturation: bot.foodSaturation,
    oxygen: bot.oxygenLevel,
    experienceLevel: bot.experience.level,
    timeOfDay: bot.time.timeOfDay,
    isDay: bot.time.isDay,
    heldItem: bot.heldItem && { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.heldItem.slot },
    armor: armorOf(bot),
    offhand: itemIn(bot, bot.getEquipmentDestSlot("off-hand")),
    effects: activeEffects(bot),
    biome: biomeAt(bot, feet),
    standingOn: standingOn(bot),
    lookingAt: sight && {
      name: sight.name,
      position: vec(sight.position),
      distance: round(sight.position.offset(0.5, 0.5, 0.5).distanceTo(self.position.offset(0, self.height * 0.9, 0))),
    },
    ...(feetBlock && { light: { block: feetBlock.light, ...((feetBlock.skyLight > 0 || !sky.open) && { sky: feetBlock.skyLight }) } }),
    inventory: bot.inventory.items().map(({ name, count, slot }): ItemSummary => ({ name, count, slot })),
    isRaining: bot.isRaining,
    nearbyEntities,
    program: extras.program,
    sky,
    programsWithoutChange: extras.programsWithoutChange,
    ...(senses.lastDeath && { lastDeath: senses.lastDeath }),
    ...(senses.spawnPoint !== undefined && { spawnPoint: senses.spawnPoint }),
  };
}

function describeSky(sky: SkyView): string {
  if (sky.open) return "open sky";
  if (sky.waterAbove === 0) return `underground: ${sky.solidAbove} blocks above`;
  if (sky.solidAbove === 0) return `under water: ${sky.waterAbove} blocks of water above`;
  return `underground and under water: ${sky.solidAbove} solid and ${sky.waterAbove} water blocks above`;
}

/** `last death 5m ago at -286 42 104 (drowned)`: the cause without the player's name, since the line is theirs. */
function describeDeath(death: DeathSummary, username: string): string {
  const seen = Date.parse(death.time);
  const minutes = Number.isFinite(seen) ? Math.max(0, Math.floor((Date.now() - seen) / 60_000)) : 0;
  const cause = death.cause?.replaceAll(username, "").replace(/\s+/g, " ").trim();
  const at = `${Math.floor(death.position.x)} ${Math.floor(death.position.y)} ${Math.floor(death.position.z)}`;
  return `last death ${minutes}m ago at ${at}${cause ? ` (${cause})` : ""}`;
}

/** The observation as one short line, for agents with small context windows. */
export function brief(o: Observation & { connected: true; program: { running: boolean; elapsedMs?: number } }): string {
  const { x, y, z } = o.position;
  const inventory: Record<string, number> = {};
  for (const item of o.inventory) inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
  const items = Object.entries(inventory).map(([name, n]) => `${name} ${n}`).join(", ") || "empty";
  // Dropped stacks are named by the item they hold, grouped by name with the counts added up; everything
  // else that is worth naming keeps one entry, and the list reads nearest first.
  const stacks = new Map<string, { count: number; distance: number }>();
  for (const e of o.nearbyEntities) {
    if (!e.item) continue;
    const group = stacks.get(e.item.name);
    if (group) {
      group.count += e.item.count;
      group.distance = Math.min(group.distance, e.distance);
    } else stacks.set(e.item.name, { count: e.item.count, distance: e.distance });
  }
  const near = [
    ...o.nearbyEntities
      .filter((e) => !e.item && !["other", "object", "projectile", "orb", "global"].includes(e.type))
      .slice(0, 5)
      .map((e) => ({ text: `${e.username ?? e.name} ${Math.round(e.distance)}m`, distance: e.distance })),
    ...[...stacks].map(([name, group]) => ({ text: `${name} x${group.count} ${Math.round(group.distance)}m`, distance: group.distance })),
  ]
    .sort((a, b) => a.distance - b.distance)
    .map((e) => e.text)
    .join(", ");
  const worn = Object.values(o.armor).flatMap((item) => (item ? [item.name] : []));
  const effects = o.effects.map(
    (e) => `${e.name}${e.amplifier > 0 ? ` ${e.amplifier + 1}` : ""}${e.remaining === undefined ? "" : ` (${e.remaining}s)`}`,
  );
  return [
    `${o.username} in ${o.dimension.replace(/^minecraft:/, "")} at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} (${o.biome})`,
    `health ${Math.round(o.health)}/20 food ${o.food}/20${o.oxygen < 20 ? ` air ${o.oxygen}/20` : ""}`,
    ...(o.lastDeath ? [describeDeath(o.lastDeath, o.username)] : []),
    ...(o.spawnPoint !== undefined
      ? [
          o.spawnPoint === null
            ? "respawn: world spawn"
            : `respawn: bed at ${Math.floor(o.spawnPoint.x)} ${Math.floor(o.spawnPoint.y)} ${Math.floor(o.spawnPoint.z)}`,
        ]
      : []),
    `${o.isDay ? "day" : "night"} (time ${o.timeOfDay})`,
    describeSky(o.sky),
    `holding ${o.heldItem?.name ?? "nothing"}${o.offhand ? `, offhand ${o.offhand.name}` : ""}`,
    ...(worn.length > 0 ? [`armor: ${worn.join(", ")}`] : []),
    ...(effects.length > 0 ? [`effects: ${effects.join(", ")}`] : []),
    `inventory: ${items}`,
    `nearby: ${near || "none"}`,
    o.program.running ? `run in progress ${Math.round((o.program.elapsedMs ?? 0) / 1000)}s` : "no run in progress",
    ...(o.programsWithoutChange >= 3 ? [`no change for ${o.programsWithoutChange} runs`] : []),
  ].join(" | ");
}

export function briefOf(o: Observation, running: { elapsedMs: number } | null): string {
  if (!o.connected) {
    return `disconnected${o.reconnecting ? ", reconnecting" : ""}${o.lastDisconnect ? ` (${o.lastDisconnect})` : ""}`;
  }
  return brief({ ...o, program: running ? { running: true, elapsedMs: running.elapsedMs } : { running: false } });
}
