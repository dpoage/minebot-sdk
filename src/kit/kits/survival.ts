// The survival kit: eating, sleeping, and wearing armor — the actions that keep a player alive.
// It acts only when called; nothing here eats or sleeps on its own.
import { z } from "zod";
import { action, defineKit, goals, isHostile, type KitContext, Position, toVec3 } from "../kit.ts";

/** Foods the kit never picks on its own: they poison, starve, teleport, or are too valuable to waste. Name one to eat it. */
const AVOIDED_FOODS = [
  "rotten_flesh",
  "spider_eye",
  "pufferfish",
  "poisonous_potato",
  "chicken",
  "suspicious_stew",
  "chorus_fruit",
  "golden_apple",
  "enchanted_golden_apple",
];

export interface FoodOption {
  name: string;
  foodPoints: number;
  saturation: number;
}

/**
 * The best of `foods` to eat while `deficit` food points are missing: among the safe foods, the
 * one that restores the most without overshooting (best saturation on a tie); when every food
 * overshoots, the one that wastes least. Undefined when there is no safe food.
 */
export function chooseFood(foods: readonly FoodOption[], deficit: number): FoodOption | undefined {
  const safe = foods.filter((f) => !AVOIDED_FOODS.includes(f.name));
  const fits = safe.filter((f) => f.foodPoints <= deficit).sort((a, b) => b.foodPoints - a.foodPoints || b.saturation - a.saturation);
  if (fits[0]) return fits[0];
  return safe.sort((a, b) => a.foodPoints - b.foodPoints || b.saturation - a.saturation)[0];
}

/** The time of day (ticks) in which a bed works: dusk to dawn. A thunderstorm allows it at any time. */
const NIGHT_START = 12541;
const NIGHT_END = 23458;

export function canSleep(timeOfDay: number, thunderstorm: boolean): boolean {
  return thunderstorm || (timeOfDay >= NIGHT_START && timeOfDay <= NIGHT_END);
}

/** Armor materials from worst to best. Copper armor is new in the 1.21 line. */
const ARMOR_TIERS = ["leather", "copper", "golden", "turtle", "chainmail", "iron", "diamond", "netherite"];
const ARMOR_SLOTS = { head: ["_helmet"], torso: ["_chestplate"], legs: ["_leggings"], feet: ["_boots"] } as const;
type ArmorSlot = keyof typeof ARMOR_SLOTS;

/** Which armor slot an item name fits, or undefined for anything that is not armor. */
export function armorSlotOf(name: string): ArmorSlot | undefined {
  return (Object.keys(ARMOR_SLOTS) as ArmorSlot[]).find((slot) => ARMOR_SLOTS[slot].some((suffix) => name.endsWith(suffix)));
}

/** Rank of an armor item's material, 0 (leather) upward; -1 for anything that is not armor. */
export function armorTier(name: string): number {
  if (armorSlotOf(name) === undefined) return -1;
  return ARMOR_TIERS.findIndex((material) => name.startsWith(`${material}_`));
}

const MONSTER_RADIUS = 8;

async function eat(ctx: KitContext, item: string | undefined) {
  const { bot } = ctx;
  if (bot.food >= 20) throw new Error(`not hungry: food ${bot.food}/20`);
  const held = bot.inventory.items();
  let name: string;
  if (item !== undefined) {
    name = item.replace(/^minecraft:/, "");
    if (!bot.registry.foodsByName[name]) throw new Error(`${name} is not food`);
  } else {
    const options: FoodOption[] = [];
    for (const stack of held) {
      const food = bot.registry.foodsByName[stack.name];
      if (food && !options.some((o) => o.name === stack.name)) options.push({ name: food.name, foodPoints: food.foodPoints, saturation: food.saturation });
    }
    const chosen = chooseFood(options, 20 - bot.food);
    if (!chosen) {
      const skipped = options.map((o) => o.name);
      throw new Error(skipped.length > 0 ? `only ${skipped.join(", ")} to eat, which the kit does not pick; name one with \`item\`` : "the inventory holds no food");
    }
    name = chosen.name;
  }
  const stack = held.find((i) => i.name === name);
  if (!stack) throw new Error(`no ${name} in inventory`);
  const before = bot.food;
  await bot.equip(stack, "hand");
  await ctx.within(6_000, `eating ${name}`, bot.consume(), () => bot.deactivateItem());
  // The health packet with the new food level can trail the end of the meal.
  for (let wait = 0; wait < 10 && bot.food === before; wait++) await ctx.sleep(100);
  return { item: name, food: bot.food, saturation: bot.foodSaturation };
}

/** The nearest bed block within `radius` of the player. */
function nearestBed(ctx: KitContext, radius: number) {
  const { bot } = ctx;
  const ids = Object.values(bot.registry.blocksByName)
    .filter((b) => b.name.endsWith("_bed"))
    .map((b) => b.id);
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 8 })[0];
}

async function sleepAt(ctx: KitContext, at: Position | undefined) {
  const { bot } = ctx;
  if (bot.isSleeping) throw new Error("already sleeping");
  const thunderstorm = bot.isRaining && bot.thunderState > 0;
  if (!canSleep(bot.time.timeOfDay, thunderstorm)) {
    throw new Error(`it is not night (time of day ${bot.time.timeOfDay}); a bed works from ${NIGHT_START} to ${NIGHT_END}, or in a thunderstorm`);
  }
  const pos = at ? toVec3(at).floored() : nearestBed(ctx, 16);
  if (!pos) throw new Error("no bed within 16 blocks; place one or pass `at`");
  const bed = bot.blockAt(pos);
  if (!bed) throw new Error(`${pos} is not loaded`);
  if (!bot.isABed(bed)) throw new Error(`no bed at ${pos}; the block there is ${bed.name}`);
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 3) {
    await ctx.within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), () => bot.pathfinder.setGoal(null));
  }
  try {
    await bot.sleep(bed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "there are monsters nearby") throw err;
    const near = Object.values(bot.entities)
      .filter((e) => isHostile(e) && e.position.distanceTo(pos) < MONSTER_RADIUS + 4)
      .map((e) => e.name ?? "unknown");
    throw new Error(`cannot sleep: monsters near the bed${near.length > 0 ? ` (${[...new Set(near)].join(", ")})` : ""}; kill them first`);
  }
  return { sleeping: true, at: { x: pos.x, y: pos.y, z: pos.z } };
}

/**
 * Leaves the bed. `bot.wake()` in Mineflayer 4.39 sends action 2, which 26.1 reads as
 * stop_sprinting, so the player stays in bed; leaving is action 0, `stop_sleeping`.
 */
async function wake(ctx: KitContext) {
  const { bot } = ctx;
  if (!bot.isSleeping) throw new Error("not sleeping");
  const woke = new Promise<void>((resolve) => bot.once("wake", resolve));
  bot._client.write("entity_action", { entityId: bot.entity.id, actionId: "stop_sleeping", jumpBoost: 0 });
  await ctx.within(3_000, "waking up", woke, () => {});
  return { sleeping: bot.isSleeping };
}

async function wearBestArmor(ctx: KitContext) {
  const { bot } = ctx;
  const equipped: Record<string, string> = {};
  const wearing: Record<string, string | null> = {};
  for (const slot of Object.keys(ARMOR_SLOTS) as ArmorSlot[]) {
    const worn = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
    const wornTier = worn ? armorTier(worn.name) : -1;
    // Something worn that is not armor of this slot (an elytra) stays on.
    const best = bot.inventory
      .items()
      .filter((i) => armorSlotOf(i.name) === slot)
      .sort((a, b) => armorTier(b.name) - armorTier(a.name))[0];
    if (best && armorTier(best.name) > wornTier && !(worn && wornTier < 0)) {
      await bot.equip(best, slot);
      equipped[slot] = best.name;
    }
    wearing[slot] = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]?.name ?? null;
  }
  return { equipped, wearing };
}

export const survival = defineKit({
  name: "survival",
  description: "Eat, sleep in a bed, wake up, and wear the best armor in the inventory.",
  uses: [],
  actions: {
    eat: action({
      doc: "Eat `item`, or the best safe food in the inventory when omitted: the one that restores the most without overshooting the missing food points. Rotten flesh, spider eyes, pufferfish, poisonous potatoes, raw chicken, suspicious stew, chorus fruit, and golden apples are never picked on their own; name one to eat it. Fails when the food bar is full. Returns { item, food, saturation } after the meal.",
      args: z.object({ item: z.string().min(1).optional() }),
      run: (ctx, { item }) => eat(ctx, item),
    }),
    sleep: action({
      doc: "Go to bed at `at` ({x,y,z} or [x,y,z]), or the nearest bed within 16 blocks, and sleep. Works at night (time of day 12541 to 23458) and in thunderstorms; fails with the reason otherwise, or when monsters are near the bed or the bed is occupied. Returns { sleeping, at } once asleep. Call `wake` or wait for morning to get up.",
      args: z.object({ at: Position.optional() }),
      run: (ctx, { at }) => sleepAt(ctx, at),
    }),
    wake: action({
      doc: "Get out of bed. Fails when the player is not sleeping. Returns { sleeping } after waking.",
      args: z.object({}),
      run: (ctx) => wake(ctx),
    }),
    armor: action({
      doc: "Wear the best armor the inventory holds in each slot, by material: leather, copper, golden, chainmail, iron, diamond, netherite (turtle helmets rank between golden and chainmail). Leaves better armor already worn, and an elytra, on. Returns { equipped: { slot: item }, wearing: { head, torso, legs, feet } }.",
      args: z.object({}),
      run: (ctx) => wearBestArmor(ctx),
    }),
  },
});
