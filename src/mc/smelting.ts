// What a furnace does, as plain data: which items smelt into which, and how long each fuel burns.
// minecraft-data (3.117, which Mineflayer 4.39 loads for 26.1) has crafting recipes but no
// smelting recipes and no fuel times, so both are explicit tables here. Names that the running
// registry lacks are simply never matched.

/** Ticks a furnace needs per item. Blast furnaces and smokers halve it for their own recipes. */
export const SMELT_TICKS = 200;

/** Smelting recipes by input item, for the plain furnace. Logs, wood, and glazed terracotta are generated below. */
const DIRECT: Readonly<Record<string, string>> = {
  raw_iron: "iron_ingot",
  iron_ore: "iron_ingot",
  deepslate_iron_ore: "iron_ingot",
  raw_gold: "gold_ingot",
  gold_ore: "gold_ingot",
  deepslate_gold_ore: "gold_ingot",
  nether_gold_ore: "gold_ingot",
  raw_copper: "copper_ingot",
  copper_ore: "copper_ingot",
  deepslate_copper_ore: "copper_ingot",
  ancient_debris: "netherite_scrap",
  coal_ore: "coal",
  deepslate_coal_ore: "coal",
  lapis_ore: "lapis_lazuli",
  deepslate_lapis_ore: "lapis_lazuli",
  redstone_ore: "redstone",
  deepslate_redstone_ore: "redstone",
  diamond_ore: "diamond",
  deepslate_diamond_ore: "diamond",
  emerald_ore: "emerald",
  deepslate_emerald_ore: "emerald",
  nether_quartz_ore: "quartz",
  sand: "glass",
  red_sand: "glass",
  cobblestone: "stone",
  stone: "smooth_stone",
  cobbled_deepslate: "deepslate",
  clay_ball: "brick",
  clay: "terracotta",
  netherrack: "nether_brick",
  sandstone: "smooth_sandstone",
  red_sandstone: "smooth_red_sandstone",
  quartz_block: "smooth_quartz",
  basalt: "smooth_basalt",
  stone_bricks: "cracked_stone_bricks",
  deepslate_bricks: "cracked_deepslate_bricks",
  deepslate_tiles: "cracked_deepslate_tiles",
  nether_bricks: "cracked_nether_bricks",
  polished_blackstone_bricks: "cracked_polished_blackstone_bricks",
  cactus: "green_dye",
  sea_pickle: "lime_dye",
  kelp: "dried_kelp",
  wet_sponge: "sponge",
  chorus_fruit: "popped_chorus_fruit",
  beef: "cooked_beef",
  porkchop: "cooked_porkchop",
  mutton: "cooked_mutton",
  chicken: "cooked_chicken",
  rabbit: "cooked_rabbit",
  cod: "cooked_cod",
  salmon: "cooked_salmon",
  potato: "baked_potato",
};

const COLORS = [
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
];

/** Every log and wood block that burns (not nether stems) smelts to charcoal. */
const BURNING_LOG = /^(?:stripped_)?[a-z_]+_(?:log|wood)$/;

/** What `input` smelts into in a furnace, or undefined when it does not smelt. */
export function smeltOutput(input: string): string | undefined {
  const name = input.replace(/^minecraft:/, "");
  const direct = DIRECT[name];
  if (direct !== undefined) return direct;
  if (BURNING_LOG.test(name)) return "charcoal";
  const color = COLORS.find((c) => name === `${c}_terracotta`);
  return color === undefined ? undefined : `${color}_glazed_terracotta`;
}

/** The names among `candidates` that smelt into `output`, in candidate order. */
export function smeltInputs(output: string, candidates: Iterable<string>): string[] {
  const target = output.replace(/^minecraft:/, "");
  return [...candidates].filter((name) => smeltOutput(name) === target);
}

/** Burn time in ticks of the fuels that are not wood. Wood is matched by name in `burnTicks`. */
const FUEL_TICKS: Readonly<Record<string, number>> = {
  lava_bucket: 20000,
  coal_block: 16000,
  dried_kelp_block: 4000,
  blaze_rod: 2400,
  coal: 1600,
  charcoal: 1600,
  bamboo_block: 300,
  stick: 100,
  bamboo: 50,
  scaffolding: 50,
};

/** How many ticks one `item` burns in a furnace; 0 when it is not a fuel. */
export function burnTicks(item: string): number {
  const name = item.replace(/^minecraft:/, "");
  const table = FUEL_TICKS[name];
  if (table !== undefined) return table;
  if (BURNING_LOG.test(name) || (name.endsWith("_planks") && !/^(?:crimson|warped)_/.test(name))) return 300;
  if (/^wooden_(?:sword|pickaxe|axe|shovel|hoe)$/.test(name)) return 200;
  return 0;
}

/** Fuels the kit picks on its own, in order of preference: clean fuel first, then wood. Never buckets, blocks, or tools. */
const AUTO_FUEL_ORDER = ["charcoal", "coal"];

function autoFuelRank(name: string): number {
  const listed = AUTO_FUEL_ORDER.indexOf(name);
  if (listed >= 0) return listed;
  if (name.endsWith("_planks")) return AUTO_FUEL_ORDER.length;
  if (BURNING_LOG.test(name)) return AUTO_FUEL_ORDER.length + 1;
  if (name === "stick") return AUTO_FUEL_ORDER.length + 2;
  return -1;
}

/** `held` (item name -> count) with `count` of `item` set aside, e.g. the logs about to be smelted, which must not also burn as fuel. */
export function withoutReserved(held: Readonly<Record<string, number>>, item: string, count: number): Record<string, number> {
  const rest = { ...held };
  if (item in rest) rest[item] = Math.max(0, rest[item]! - count);
  return rest;
}

/** Items needed to burn `ticks`; rounds up. */
export function fuelItemsFor(item: string, ticks: number): number {
  const per = burnTicks(item);
  if (per <= 0) throw new Error(`${item} is not a furnace fuel`);
  return Math.max(0, Math.ceil(ticks / per));
}

/**
 * Chooses the fuel for `ticks` of burning from `held` (item name -> count). A named `fuel` is used
 * as is. Otherwise the first of charcoal, coal, planks, logs, sticks that the inventory holds in
 * enough quantity. Returns undefined when the inventory cannot cover it.
 */
export function pickFuel(held: Readonly<Record<string, number>>, ticks: number, fuel?: string): { item: string; count: number } | undefined {
  if (fuel !== undefined) {
    const item = fuel.replace(/^minecraft:/, "");
    const count = fuelItemsFor(item, ticks);
    return (held[item] ?? 0) >= count ? { item, count } : undefined;
  }
  const ranked = Object.keys(held)
    .filter((name) => (held[name] ?? 0) > 0 && burnTicks(name) > 0 && autoFuelRank(name) >= 0)
    .sort((a, b) => autoFuelRank(a) - autoFuelRank(b) || a.localeCompare(b));
  for (const item of ranked) {
    const count = fuelItemsFor(item, ticks);
    if ((held[item] ?? 0) >= count) return { item, count };
  }
  return undefined;
}
