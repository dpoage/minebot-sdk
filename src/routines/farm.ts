// The farm routines: tilling soil, planting seeds, harvesting ripe crops, breeding animals.
import { type Block, defineRoutine, type Entity, goals, isAir, nameMatcher, NamePattern, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Till soil, plant seeds, harvest ripe crops, and breed animals.";
export const uses = [] as const;

// Survival players interact with blocks up to 4.5 blocks from the eyes, and with entities up to 3.
const BLOCK_REACH = 4.5;
const ENTITY_REACH = 2.5;
const DEFAULT_HARVEST_TIMEOUT_MS = 120_000;
const DEFAULT_BREED_TIMEOUT_MS = 30_000;

/** What a seed item grows into. */
const SEED_CROPS: Record<string, string> = {
  wheat_seeds: "wheat",
  carrot: "carrots",
  potato: "potatoes",
  beetroot_seeds: "beetroots",
  melon_seeds: "melon_stem",
  pumpkin_seeds: "pumpkin_stem",
  torchflower_seeds: "torchflower_crop",
  pitcher_pod: "pitcher_crop",
  nether_wart: "nether_wart",
};

// Names an agent may use for a seed: the crop, or the plural block name.
const SEED_ALIASES: Record<string, string> = {
  wheat: "wheat_seeds",
  carrots: "carrot",
  potatoes: "potato",
  beetroot: "beetroot_seeds",
  beetroots: "beetroot_seeds",
  melon: "melon_seeds",
  pumpkin: "pumpkin_seeds",
  torchflower: "torchflower_seeds",
  pitcher: "pitcher_pod",
};

/** The crops `harvest` takes: block name, the seed item that replants it, and the `age` at which it is ripe. */
const HARVESTABLE: Record<string, { seed: string; ripe: number }> = {
  wheat: { seed: "wheat_seeds", ripe: 7 },
  carrots: { seed: "carrot", ripe: 7 },
  potatoes: { seed: "potato", ripe: 7 },
  beetroots: { seed: "beetroot_seeds", ripe: 3 },
  nether_wart: { seed: "nether_wart", ripe: 3 },
};

// What each animal eats to breed. Cats and horses accept more than listed; these are the common foods.
const BREEDING_FOODS: Record<string, string[]> = {
  cow: ["wheat"],
  mooshroom: ["wheat"],
  sheep: ["wheat"],
  goat: ["wheat"],
  pig: ["carrot", "potato", "beetroot"],
  chicken: ["wheat_seeds", "beetroot_seeds", "melon_seeds", "pumpkin_seeds", "torchflower_seeds", "pitcher_pod"],
  horse: ["golden_apple", "golden_carrot", "enchanted_golden_apple"],
  donkey: ["golden_apple", "golden_carrot", "enchanted_golden_apple"],
  llama: ["hay_block"],
  rabbit: ["dandelion", "carrot", "golden_carrot"],
  cat: ["cod", "salmon"],
  ocelot: ["cod", "salmon"],
  wolf: ["beef", "porkchop", "mutton", "chicken", "rabbit", "rotten_flesh", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "cooked_rabbit"],
  fox: ["sweet_berries", "glow_berries"],
  panda: ["bamboo"],
  turtle: ["seagrass"],
  camel: ["cactus"],
  armadillo: ["spider_eye"],
  frog: ["slime_ball"],
  hoglin: ["crimson_fungus"],
  strider: ["warped_fungus"],
  sniffer: ["torchflower_seeds"],
};

/** The seed item for a seed or crop name (`wheat` and `wheat_seeds` both give `wheat_seeds`), or null when nothing is planted from it. */
export function seedItem(name: string): string | null {
  const item = SEED_ALIASES[name.replace(/^minecraft:/, "")] ?? name.replace(/^minecraft:/, "");
  return item in SEED_CROPS ? item : null;
}

/** The block that planting `seed` makes. */
export function cropOf(seed: string): string | null {
  return SEED_CROPS[seed] ?? null;
}

/** True when a `crop` block with this `age` can be harvested; false for unknown crops. */
export function isRipe(crop: string, age: number): boolean {
  const info = HARVESTABLE[crop];
  return info !== undefined && age >= info.ripe;
}

/** The foods `animal` breeds with, best known first; empty for animals that cannot be bred this way. */
export function breedingFoods(animal: string): readonly string[] {
  return BREEDING_FOODS[animal] ?? [];
}

/** True for a baby animal: ageable mobs keep the flag in entity metadata slot 16. */
export function isBaby(entity: { metadata?: readonly unknown[] }): boolean {
  return entity.metadata?.[16] === true;
}

/** The two animals closest to each other, or null with fewer than two. Breeding animals walk to each other only when close. */
export function closestPair<T extends { position: Vec3 }>(animals: readonly T[]): [T, T] | null {
  let best: [T, T] | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < animals.length; i++) {
    for (let j = i + 1; j < animals.length; j++) {
      const distance = animals[i]!.position.distanceTo(animals[j]!.position);
      if (distance < bestDistance) {
        best = [animals[i]!, animals[j]!];
        bestDistance = distance;
      }
    }
  }
  return best;
}

function eyes(ctx: RoutineContext): Vec3 {
  return ctx.bot.entity.position.offset(0, ctx.bot.entity.height * 0.9, 0);
}

/** Walks until `pos` is within block reach, and off `pos` itself, which a placed block or a hoe cannot use while the player stands in it. */
async function reach(ctx: RoutineContext, pos: Vec3): Promise<void> {
  const { bot } = ctx;
  if (eyes(ctx).distanceTo(pos.offset(0.5, 0.5, 0.5)) > BLOCK_REACH) {
    await within(30_000, "pathfinding", bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)), () => bot.pathfinder.setGoal(null));
  }
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.equals(pos.offset(0, 1, 0))) {
    await within(10_000, "pathfinding", bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1))), () =>
      bot.pathfinder.setGoal(null),
    );
  }
}

/** The inventory stack called `name`, or an error naming what is missing. */
function stackOf(ctx: RoutineContext, name: string) {
  const stack = ctx.bot.inventory.items().find((i) => i.name === name);
  if (!stack) throw new Error(`no ${name} in inventory`);
  return stack;
}

function ageOf(block: Block): number {
  return Number(block.getProperties().age ?? 0);
}

/** True when water lies within 4 blocks horizontally of the soil at `pos`, on its level or one above: the range that keeps farmland wet. */
function isHydrated(ctx: RoutineContext, pos: Vec3): boolean {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        if (ctx.bot.blockAt(pos.offset(dx, dy, dz))?.name === "water") return true;
      }
    }
  }
  return false;
}

const TILLABLE = new Set(["dirt", "grass_block", "dirt_path"]);

/** Wild plants that `till` digs out of the way. Crops, saplings, torches, and every other block above the soil stop it. */
const CLEARABLE_PLANTS: Record<string, true> = {
  short_grass: true,
  tall_grass: true,
  fern: true,
  large_fern: true,
  dead_bush: true,
  short_dry_grass: true,
  tall_dry_grass: true,
  bush: true,
  dandelion: true,
  golden_dandelion: true,
  torchflower: true,
  poppy: true,
  blue_orchid: true,
  allium: true,
  azure_bluet: true,
  red_tulip: true,
  orange_tulip: true,
  white_tulip: true,
  pink_tulip: true,
  oxeye_daisy: true,
  cornflower: true,
  wither_rose: true,
  lily_of_the_valley: true,
  sunflower: true,
  lilac: true,
  rose_bush: true,
  peony: true,
};

/** Hoes dirt, grass, or a dirt path at `pos` into farmland. Returns false when it already is farmland. */
async function tillAt(ctx: RoutineContext, pos: Vec3) {
  const { bot } = ctx;
  const soil = bot.blockAt(pos);
  if (!soil) throw new Error(`${pos} is not loaded`);
  if (soil.name === "farmland") return { tilled: false, hydrated: isHydrated(ctx, pos) };
  if (!TILLABLE.has(soil.name)) throw new Error(`cannot till ${soil.name} at ${pos}: only dirt, grass_block, and dirt_path`);
  const hoe = bot.inventory.items().find((i) => i.name.endsWith("_hoe"));
  if (!hoe) throw new Error("no hoe in inventory");
  const above = bot.blockAt(pos.offset(0, 1, 0));
  if (above && !isAir(above)) {
    // A hoe works only under air. Wild plants are fair to clear; anything else above the soil is not ours to remove.
    if (!CLEARABLE_PLANTS[above.name]) throw new Error(`cannot till ${pos}: ${above.name} is above it`);
    await reach(ctx, pos);
    await within(10_000, `clearing ${above.name}`, bot.dig(above), () => bot.stopDigging());
  }
  await reach(ctx, pos);
  await bot.equip(hoe, "hand");
  await bot.activateBlock(soil);
  for (let waited = 0; waited < 2000; waited += 100) {
    if (bot.blockAt(pos)?.name === "farmland") return { tilled: true, hydrated: isHydrated(ctx, pos) };
    await ctx.sleep(100);
  }
  throw new Error(`the server did not till ${soil.name} at ${pos}`);
}

/** Plants `seed` on the soil at `at`, or in the empty block `at` above soil. Returns false when that crop already grows there. */
async function plantAt(ctx: RoutineContext, at: Vec3, seed: string): Promise<boolean> {
  const { bot } = ctx;
  const item = seedItem(seed);
  if (!item) throw new Error(`cannot plant "${seed}": use one of ${Object.keys(SEED_CROPS).join(", ")}`);
  const crop = SEED_CROPS[item]!;
  const target = bot.blockAt(at);
  if (!target) throw new Error(`${at} is not loaded`);
  if (target.name === crop) return false;
  // `at` may name the soil (what till took) or the empty block above it (where the crop grows).
  const soilPos = isAir(target) ? at.offset(0, -1, 0) : at;
  const soil = bot.blockAt(soilPos);
  if (!soil) throw new Error(`${soilPos} is not loaded`);
  const wanted = crop === "nether_wart" ? "soul_sand" : "farmland";
  if (soil.name !== wanted) throw new Error(`${crop} grows on ${wanted}, not ${soil.name} at ${soilPos}`);
  const cropPos = soilPos.offset(0, 1, 0);
  const there = bot.blockAt(cropPos);
  if (there?.name === crop) return false;
  if (there && !isAir(there)) throw new Error(`${there.name} is in the way at ${cropPos}`);
  await reach(ctx, cropPos);
  await bot.equip(stackOf(ctx, item), "hand");
  await bot.placeBlock(soil, new Vec3(0, 1, 0));
  return true;
}

/** Digs every ripe crop within `radius`, collects the drops, and replants where it can. */
async function harvestCrops(ctx: RoutineContext, radius: number, crops: NamePattern | undefined, replant: boolean, timeoutMs: number) {
  const { bot } = ctx;
  const matches = crops === undefined ? () => true : nameMatcher(crops);
  const wanted = Object.entries(HARVESTABLE).filter(([block, info]) => matches(block) || matches(info.seed));
  if (wanted.length === 0) throw new Error(`no harvestable crop matches ${JSON.stringify(crops)}: ${Object.keys(HARVESTABLE).join(", ")}`);
  const ids = wanted.map(([block]) => bot.registry.blocksByName[block]!.id);
  const deadline = Date.now() + timeoutMs;
  const before = new Map<string, number>();
  for (const stack of bot.inventory.items()) before.set(stack.name, (before.get(stack.name) ?? 0) + stack.count);

  const ripe = bot
    .findBlocks({ matching: ids, maxDistance: radius, count: 256 })
    .map((p) => bot.blockAt(p)!)
    .filter((b) => isRipe(b.name, ageOf(b)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  let harvested = 0;
  let replanted = 0;
  let skipped = 0;
  for (const block of ripe) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (Date.now() > deadline) break;
    const pos = block.position;
    try {
      await reach(ctx, pos);
      const current = bot.blockAt(pos);
      if (!current || !isRipe(current.name, ageOf(current))) continue;
      await within(10_000, `digging ${current.name}`, bot.dig(current), () => bot.stopDigging());
      harvested++;
      await ctx.sleep(500); // dropped items cannot be picked up for half a second
      for (const drop of Object.values(bot.entities).filter((e) => e.name === "item" && e.position.distanceTo(pos) < 4)) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        await within(8_000, "collecting a drop", bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5)), () =>
          bot.pathfinder.setGoal(null),
        ).catch((err: unknown) => {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          ctx.log(`harvest: could not reach a drop at ${drop.position.floored()}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (replant) {
        const seed = HARVESTABLE[current.name]!.seed;
        if (bot.inventory.items().some((i) => i.name === seed)) {
          await plantAt(ctx, pos.offset(0, -1, 0), seed);
          replanted++;
        } else {
          ctx.log(`harvest: no ${seed} to replant at ${pos}`);
        }
      }
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      skipped++;
      ctx.log(`harvest: skipping ${pos}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await ctx.sleep(300); // the inventory update for the last placement or pickup trails the block update
  const gained: Record<string, number> = {};
  for (const stack of bot.inventory.items()) gained[stack.name] = (gained[stack.name] ?? 0) + stack.count;
  for (const [name, n] of Object.entries(gained)) {
    const delta = n - (before.get(name) ?? 0);
    if (delta > 0) gained[name] = delta;
    else delete gained[name];
  }
  return { harvested, replanted, skipped, gained };
}

/** Feeds two adult `animal`s and waits for the baby. */
async function breedAnimals(ctx: RoutineContext, animal: string, food: string | undefined, radius: number, timeoutMs: number) {
  const { bot } = ctx;
  const foods = food ? [food.replace(/^minecraft:/, "")] : breedingFoods(animal);
  if (foods.length === 0) throw new Error(`do not know what ${animal} eats to breed: pass \`food\``);
  const here = bot.entity.position;
  const named = (e: Entity) => e.name === animal && e.position.distanceTo(here) <= radius;
  const babies = new Set(Object.values(bot.entities).filter((e) => named(e) && isBaby(e)).map((e) => e.id));
  const adults = Object.values(bot.entities).filter((e) => named(e) && !isBaby(e));
  const pair = closestPair(adults);
  if (!pair) throw new Error(`need two adult ${animal} within ${radius} blocks, found ${adults.length}`);
  const stack = bot.inventory.items().find((i) => foods.includes(i.name));
  if (!stack) throw new Error(`no ${foods.join(" or ")} in inventory`);
  const held = () => bot.inventory.items().filter((i) => i.name === stack.name).reduce((n, i) => n + i.count, 0);
  const deadline = Date.now() + timeoutMs;

  for (const target of pair) {
    const stillThere = bot.entities[target.id];
    if (!stillThere) throw new Error(`${animal} ${target.id} left view`);
    const eaten = held();
    await bot.equip(stackOf(ctx, stack.name), "hand");
    if (eyes(ctx).distanceTo(stillThere.position.offset(0, stillThere.height / 2, 0)) > ENTITY_REACH) {
      await within(
        20_000,
        "pathfinding",
        bot.pathfinder.goto(new goals.GoalFollow(stillThere, 1)),
        () => bot.pathfinder.setGoal(null),
      );
    }
    await bot.activateEntity(bot.entities[target.id] ?? stillThere);
    await ctx.sleep(400);
    // A fed animal takes the food; one in its breeding cooldown leaves it in the stack.
    if (held() >= eaten) throw new Error(`${animal} ${target.id} did not take the ${stack.name}: it may have bred in the last 5 minutes`);
  }

  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const baby = Object.values(bot.entities).find((e) => e.name === animal && isBaby(e) && !babies.has(e.id));
    if (baby) return { fed: 2, baby: true, babyId: baby.id };
    await ctx.sleep(500);
  }
  return { fed: 2, baby: false, babyId: null };
}

export const till = defineRoutine(
  {
    name: "farm.till",
    description: "Hoe the dirt, grass_block, or dirt_path block at `at` ({x,y,z} or [x,y,z]) into farmland, walking close and holding a hoe from the inventory. Digs out wild plants above it (grass, ferns, dead bush, flowers); fails when any other block is above, such as a torch, a sapling, or a crop. Farmland dries out and turns back to dirt unless water lies within 4 blocks. Returns { tilled, hydrated } — tilled is false when it already was farmland.",
    args: z.object({ at: Position }),
    returns: z.object({ tilled: z.boolean(), hydrated: z.boolean() }),
  },
  (ctx, { at }) => tillAt(ctx, toVec3(at).floored()),
);

export const plant = defineRoutine(
  {
    name: "farm.plant",
    description: "Plant `seed` ('wheat_seeds', 'carrot', 'potato', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod', 'nether_wart', or the crop name such as 'wheat') on the farmland at `at` ({x,y,z} or [x,y,z]); `at` may also be the empty block above the farmland. Nether wart needs soul_sand. Walks close and takes the seed from the inventory. Returns true when it planted, false when that crop already grows there.",
    args: z.object({ at: Position, seed: z.string().min(1) }),
    returns: z.boolean(),
  },
  (ctx, { at, seed }) => plantAt(ctx, toVec3(at).floored(), seed),
);

export const harvest = defineRoutine(
  {
    name: "farm.harvest",
    description: "Dig the ripe crops within `radius` (default 16), nearest first, collect the drops, and replant each (`replant`, default true) when the inventory has its seed. `crops` limits it to some of wheat, carrots, potatoes, beetroots, nether_wart (a seed name matches too); default all. Stops after `timeoutMs` (default 120000). Returns { harvested, replanted, skipped, gained } — gained is the inventory change, e.g. { wheat: 3, wheat_seeds: 2 }.",
    args: z.object({
      radius: z.number().positive().default(16),
      crops: NamePattern.optional(),
      replant: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(DEFAULT_HARVEST_TIMEOUT_MS),
    }),
    returns: z.object({ harvested: z.number(), replanted: z.number(), skipped: z.number(), gained: z.record(z.string(), z.number()) }),
  },
  (ctx, { radius, crops, replant, timeoutMs }) => harvestCrops(ctx, radius, crops, replant, timeoutMs),
);

export const breed = defineRoutine(
  {
    name: "farm.breed",
    description: "Feed the two adult `animal`s ('cow', 'sheep', 'pig', 'chicken', ...) nearest each other within `radius` (default 16) and wait up to `timeoutMs` (default 30000) for the baby. `food` defaults to what that animal eats and the inventory holds (cow, sheep, goat: wheat; pig: carrot, potato, beetroot; chicken: seeds). Fails when fewer than two adults are near, there is no food, or an animal refuses it (it bred in the last 5 minutes). Returns { fed, baby, babyId } — baby is false when none appeared in time.",
    args: z.object({
      animal: z.string().min(1),
      food: z.string().min(1).optional(),
      radius: z.number().positive().default(16),
      timeoutMs: z.number().int().positive().default(DEFAULT_BREED_TIMEOUT_MS),
    }),
    returns: z.object({ fed: z.number(), baby: z.boolean(), babyId: z.number().nullable() }),
  },
  (ctx, { animal, food, radius, timeoutMs }) => breedAnimals(ctx, animal, food, radius, timeoutMs),
);
