// The crafter routines: plan recipe chains and make sure a crafting table or a furnace is there to
// craft and smelt them at — calling the move, inventory, craft, and furnace primitives, and placing
// the table or furnace itself.
import { type Block, type Bot, burnTicks, defineRoutine, isAir, pickFuel, type RoutineContext, SMELT_TICKS, smeltInputs, Vec3, withoutReserved, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as inventory from "minebot-sdk/routines/inventory";
import * as craft from "minebot-sdk/routines/craft";
import * as furnace from "minebot-sdk/routines/furnace";

export const description = "Plan, craft, and smelt item chains: crafter.plan lists the raw materials still missing for an item; crafter.make crafts and smelts it from the inventory, finding or placing a crafting table or furnace when needed.";
export const uses = ["move", "sense", "place", "inventory", "craft", "items", "furnace"] as const;

const MAX_MAKE_DEPTH = 4;
const MAX_PLAN_PASSES = 4;
/** A furnace keeps burning between two smelts: of the ticks it has left, this many are not counted on. */
const BURN_SLACK_TICKS = 100;
const TABLE_SEARCH_RADIUS = 32;
const FURNACE_SEARCH_RADIUS = 32;

function countOf(ctx: RoutineContext, name: string): Promise<number> {
  return inventory.count(ctx, { items: name });
}

function itemId(ctx: RoutineContext, name: string): number {
  const item = ctx.bot.registry.itemsByName[name.replace(/^minecraft:/, "")];
  if (!item) throw new Error(`unknown item "${name}"`);
  return item.id;
}

/** Holds `name` from the inventory, confirming the hand actually changed. */
async function holdItem(ctx: RoutineContext, name: string): Promise<void> {
  const { bot } = ctx;
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new Error(`no ${name} in inventory`);
    await bot.equip(item, "hand");
    if (bot.heldItem?.name === name) return;
    await ctx.sleep(250);
  }
  throw new Error(`could not hold the ${name}`);
}

/** Places a `name` block (crafting_table or furnace) from the inventory on open natural ground within 8 blocks. */
async function placeNearby(ctx: RoutineContext, name: string): Promise<Block> {
  const { bot } = ctx;
  const blockId = bot.registry.blocksByName[name]!.id;
  const nearby = bot.findBlock({ matching: blockId, maxDistance: 4 });
  if (nearby) return nearby;
  if ((await countOf(ctx, name)) === 0) throw new Error(`no ${name} in inventory`);
  // Only air is safe: thin blocks such as leaf_litter have no collision box, but the server
  // does not replace them, so placing into them fails.
  const free = (b: Block | null) => b !== null && isAir(b);
  // Solid, non-tree ground with room for the block and a player beside it.
  const grounds = bot
    .findBlocks({
      matching: (b: Block) => b.boundingBox === "block" && !/_leaves$|_log$/.test(b.name),
      maxDistance: 8,
      count: 200,
    })
    .filter((p) => free(bot.blockAt(p.offset(0, 1, 0))) && free(bot.blockAt(p.offset(0, 2, 0))))
    .filter((p) => !bot.entity.position.floored().equals(p.offset(0, 1, 0)));
  for (const groundPos of grounds.slice(0, 8)) {
    const spot = groundPos.offset(0, 1, 0);
    try {
      await holdItem(ctx, name);
      await bot.placeBlock(bot.blockAt(groundPos)!, new Vec3(0, 1, 0));
      const placed = bot.blockAt(spot);
      if (placed?.name === name) return placed;
    } catch (err) {
      ctx.log(`placeNearby: ${spot} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`found no open ground within 8 blocks to place a ${name}; move to flat ground and retry`);
}

/**
 * A crafting table within reach: an existing one nearby, else one placed (and made if needed,
 * from planks the inventory holds or the logs it holds). Callers that go on to make ingredients
 * ensure the table first: its 4 planks would otherwise come out of the ingredients' planks.
 */
async function ensureTable(ctx: RoutineContext, depth: number): Promise<Block> {
  const { bot } = ctx;
  const tableId = bot.registry.blocksByName.crafting_table!.id;
  const near = bot.findBlock({ matching: tableId, maxDistance: 4 });
  if (near) return near;
  const known = bot.findBlock({ matching: tableId, maxDistance: TABLE_SEARCH_RADIUS });
  if (known) {
    await move.to(ctx, { position: known.position, range: 2, timeoutMs: 30_000 });
    return bot.blockAt(known.position) ?? known;
  }
  if ((await countOf(ctx, "crafting_table")) === 0) await makeItem(ctx, "crafting_table", 1, depth + 1);
  return placeNearby(ctx, "crafting_table");
}

/** A furnace to smelt at: an existing one within 32 blocks, else one placed from the inventory, else one crafted from cobblestone. */
async function ensureFurnace(ctx: RoutineContext, depth: number): Promise<Block> {
  const { bot } = ctx;
  const furnaceId = bot.registry.blocksByName.furnace!.id;
  const near = bot.findBlock({ matching: furnaceId, maxDistance: 4 });
  if (near) return near;
  const known = bot.findBlock({ matching: furnaceId, maxDistance: FURNACE_SEARCH_RADIUS });
  if (known) {
    await move.to(ctx, { position: known.position, range: 2, timeoutMs: 30_000 });
    return bot.blockAt(known.position) ?? known;
  }
  if ((await countOf(ctx, "furnace")) === 0) await makeItem(ctx, "furnace", 1, depth + 1);
  return placeNearby(ctx, "furnace");
}

/** The held items that smelt into `name`, most plentiful first. */
async function heldSmeltInputs(ctx: RoutineContext, name: string): Promise<{ input: string; count: number }[]> {
  const held = await Promise.all(smeltInputs(name, Object.keys(ctx.bot.registry.itemsByName)).map(async (input) => ({ input, count: await countOf(ctx, input) })));
  return held.filter((h) => h.count > 0).sort((a, b) => b.count - a.count);
}

/**
 * Smelts up to `missing` of `name` from the inputs the inventory holds, one smelt per input
 * kind, at a furnace it finds, places, or crafts. Smelting is one item for one item.
 */
async function smeltMissing(ctx: RoutineContext, name: string, missing: number, depth: number): Promise<void> {
  let left = missing;
  for (const { input, count } of await heldSmeltInputs(ctx, name)) {
    if (left <= 0) return;
    const n = Math.min(left, count);
    const block = await ensureFurnace(ctx, depth);
    await furnace.smelt(ctx, { item: input, count: n, at: block.position });
    left -= n;
  }
}

/**
 * Makes sure the inventory holds at least `count` of `name`: smelting it from inputs the
 * inventory holds when it is a furnace output, and crafting missing intermediate items
 * recursively from what the inventory holds. Does not gather raw materials.
 */
async function makeItem(ctx: RoutineContext, name: string, count = 1, depth = 0): Promise<number> {
  const { bot } = ctx;
  const have = await countOf(ctx, name);
  if (have >= count) return have;
  const id = itemId(ctx, name);
  const failures: string[] = [];
  // Smelting first: a smelted item such as iron_ingot also has a crafting recipe (from nuggets or a block) that the inventory rarely satisfies.
  const smeltable = smeltInputs(name, Object.keys(bot.registry.itemsByName));
  if (smeltable.length > 0 && (await heldSmeltInputs(ctx, name)).length > 0) {
    try {
      await smeltMissing(ctx, name, count - have, depth);
      if ((await countOf(ctx, name)) >= count) return countOf(ctx, name);
    } catch (err) {
      // Items on the ground and a full inventory: another recipe would only spend more inputs, so the caller frees a slot first.
      if (err instanceof craft.InventoryFullError) throw err;
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  const recipes = bot.recipesAll(id, null, true);
  if (recipes.length === 0) {
    if (smeltable.length === 0) throw new Error(`need ${count - have} more ${name}, which cannot be crafted; gather it`);
    // An input that is itself a furnace output (stone for smooth_stone) can be smelted in turn.
    if (depth < MAX_MAKE_DEPTH && failures.length === 0) {
      for (const input of smeltable.filter((i) => smeltInputs(i, Object.keys(bot.registry.itemsByName)).length > 0)) {
        try {
          await makeItem(ctx, input, count - (await countOf(ctx, name)), depth + 1);
          await smeltMissing(ctx, name, count - (await countOf(ctx, name)), depth);
          if ((await countOf(ctx, name)) >= count) return countOf(ctx, name);
        } catch (err) {
          if (err instanceof craft.InventoryFullError) throw err;
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    const reason = failures.length > 0 ? `: ${[...new Set(failures)].slice(0, 3).join("; ")}` : `; the inventory holds none of them, gather some`;
    throw new Error(`need ${count - (await countOf(ctx, name))} more ${name}, which a furnace makes from ${smeltable.slice(0, 4).join(", ")}${reason}`);
  }
  if (depth >= MAX_MAKE_DEPTH) throw new Error(`gave up making ${name}: recipe chain deeper than ${MAX_MAKE_DEPTH}`);
  // Tagged ingredients expand to one recipe per variant (oak planks, birch planks, ...).
  // Try first the recipes whose ingredients the inventory holds or can craft directly.
  const ranked = (
    await Promise.all(
      recipes.map(async (recipe) => {
        const times = Math.ceil((count - have) / recipe.result.count);
        let shortfall = 0;
        for (const d of recipe.delta) {
          if (d.count >= 0) continue;
          const ingredient = bot.registry.items[d.id]?.name ?? `#${d.id}`;
          const missing = -d.count * times - (await countOf(ctx, ingredient));
          if (missing <= 0) continue;
          const smeltHeld = (await heldSmeltInputs(ctx, ingredient)).reduce((n, held) => n + held.count, 0);
          shortfall += bot.recipesFor(d.id, null, missing, true).length > 0 || smeltHeld >= missing ? 1 : 10 + missing;
        }
        return { recipe, times, shortfall };
      }),
    )
  ).sort((a, b) => a.shortfall - b.shortfall);
  for (const { recipe, times } of ranked.slice(0, 4)) {
    try {
      const ingredients = recipe.delta
        .filter((d) => d.count < 0)
        .map((d) => ({ name: bot.registry.items[d.id]?.name ?? `#${d.id}`, need: -d.count * times }));
      // The table comes first: making it uses planks, and making the ingredients first would
      // leave it short of the planks they used (a wooden pickaxe from 7 logs needs 3 + 2 + 4 planks).
      if (recipe.requiresTable) await ensureTable(ctx, depth);
      // Making one ingredient can consume another (sticks use planks), so repeat until all are present at once.
      for (let pass = 0; pass < 3; pass++) {
        const short: typeof ingredients = [];
        for (const i of ingredients) if ((await countOf(ctx, i.name)) < i.need) short.push(i);
        if (short.length === 0) break;
        for (const i of short) await makeItem(ctx, i.name, i.need, depth + 1);
      }
      // Making ingredients can walk away from the table (to a furnace), so bring it back within reach.
      if (recipe.requiresTable) await ensureTable(ctx, depth);
      await craft.craft(ctx, { item: name, count: count - (await countOf(ctx, name)) });
      return countOf(ctx, name);
    } catch (err) {
      if (err instanceof craft.InventoryFullError) throw err;
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  const hint = smeltable.length > 0 && (await heldSmeltInputs(ctx, name)).length === 0 ? `a furnace makes it from ${smeltable.slice(0, 3).join(", ")}, which the inventory lacks; ` : "";
  throw new Error(`cannot make ${count} ${name}: ${hint}${[...new Set(failures)].slice(0, 3).join("; ")}`);
}

export const make = defineRoutine(
  {
    name: "crafter.make",
    description: "Make sure the inventory holds at least `count` (default 1) of `item`, crafting intermediate items (planks, sticks, tables) as needed and finding or placing a crafting table. An item that a furnace makes (iron_ingot, glass, stone, charcoal, cooked food) is smelted from the matching input the inventory holds, at a furnace within 32 blocks, else one placed from the inventory, else one crafted from 8 cobblestone; fuel is coal, charcoal, planks, or logs from the inventory. Fails with the missing raw material, which you must gather, or, when a crafted item found no room in the inventory, with where it fell. Returns the count held.",
    args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.number(),
  },
  (ctx, { item, count }) => makeItem(ctx, item, count),
);

// ── crafter.plan: a dry run of makeItem over a virtual inventory ──────────────────────────────────

/** The raw materials a plan names first when recipe variants cover the inventory equally well: oak wood, cobblestone, raw iron, coal. */
const COMMON_FIRST = ["oak_log", "cobblestone", "raw_iron", "coal"];

function commonRank(item: string): number {
  const rank = COMMON_FIRST.indexOf(item);
  return rank < 0 ? COMMON_FIRST.length : rank;
}

type Recipe = ReturnType<Bot["recipesAll"]>[number];

/** One way to craft an item, by item name. */
interface Variant {
  makes: number;
  requiresTable: boolean;
  /** What one craft changes, in the recipe's order: ingredients negative, results positive. */
  delta: { name: string; count: number }[];
  /** The only kind of ingredient, or null when the recipe takes several kinds. */
  only: string | null;
  /** A storage recipe (block back to ingots, ingots back to nuggets): not a way to make the item, see `isStorage`. */
  storage: boolean;
}

interface Facts {
  variants: Variant[];
  /** Every item that smelts into it, in registry order. */
  smeltable: string[];
  /** What a plan may name as missing to smelt it: the smelt inputs that are not ore blocks (mining an ore drops the raw item). */
  candidates: string[];
}

/** What the registry says about recipes and smelting, by item name; the registry never changes, so it is read once. */
class Catalog {
  private readonly bot: Bot;
  private readonly names: string[];
  private readonly recipes = new Map<string, Omit<Variant, "storage">[]>();
  private readonly smelts = new Map<string, string[]>();
  private readonly known = new Map<string, Facts>();

  constructor(bot: Bot) {
    this.bot = bot;
    this.names = Object.keys(bot.registry.itemsByName);
  }

  private recipesOf(name: string): Omit<Variant, "storage">[] {
    let found = this.recipes.get(name);
    if (!found) {
      const id = this.bot.registry.itemsByName[name]?.id;
      found = id === undefined ? [] : this.bot.recipesAll(id, null, true).map((r) => this.variant(r));
      this.recipes.set(name, found);
    }
    return found;
  }

  private variant(recipe: Recipe): Omit<Variant, "storage"> {
    const delta = recipe.delta.map((d) => ({ name: this.bot.registry.items[d.id]?.name ?? `#${d.id}`, count: d.count }));
    const kinds = new Set(delta.filter((d) => d.count < 0).map((d) => d.name));
    return { makes: recipe.result.count, requiresTable: recipe.requiresTable, delta, only: kinds.size === 1 ? [...kinds][0]! : null };
  }

  smeltable(name: string): string[] {
    let found = this.smelts.get(name);
    if (!found) {
      found = smeltInputs(name, this.names);
      this.smelts.set(name, found);
    }
    return found;
  }

  /**
   * A recipe for `name` whose only ingredient is `Y` is a storage recipe (not a way to make `name`) when
   * every way to make `Y` is a recipe whose only ingredient is `name`: an iron_block is nine ingots and
   * nothing else makes one, so the ingot's recipe from the block is no way to get an ingot.
   */
  private isStorage(name: string, recipe: Omit<Variant, "storage">): boolean {
    if (recipe.only === null) return false;
    const ways = this.recipesOf(recipe.only);
    return ways.length > 0 && this.smeltable(recipe.only).length === 0 && ways.every((way) => way.only === name);
  }

  facts(name: string): Facts {
    let found = this.known.get(name);
    if (!found) {
      const smeltable = this.smeltable(name);
      found = {
        variants: this.recipesOf(name).map((r) => ({ ...r, storage: this.isStorage(name, r) })),
        smeltable,
        candidates: smeltable.filter((input) => !input.endsWith("_ore")),
      };
      this.known.set(name, found);
    }
    return found;
  }
}

const CATALOGS = new WeakMap<object, Catalog>();

function catalogOf(bot: Bot): Catalog {
  let catalog = CATALOGS.get(bot.registry);
  if (!catalog) {
    catalog = new Catalog(bot);
    CATALOGS.set(bot.registry, catalog);
  }
  return catalog;
}

/** A route that ends the branch being tried: it costs more than a route already found, or it cannot be done. */
class BranchEnd {
  readonly pruned: boolean;
  constructor(pruned: boolean) {
    this.pruned = pruned;
  }
}
const PRUNED = new BranchEnd(true);
const INFEASIBLE = new BranchEnd(false);

/** What a dry run changes: the inventory it would hold, the raw materials it had to add, and the stations. */
class Sim {
  inv: Map<string, number>;
  missing: Map<string, number>;
  alternatives: Map<string, string[]>;
  table: boolean;
  furnace: boolean;
  /** Ticks of burning left in the furnace's fuel slot after the smelts so far: the next smelt starts from them, as furnace.smelt does. */
  burn = 0;
  /** Raw units added so far. */
  cost: number;
  /** A branch whose cost passes this ends: a cheaper one exists. */
  limit: number;

  constructor(inv: Map<string, number>, missing: Map<string, number>, alternatives: Map<string, string[]>, table: boolean, furnace: boolean, cost = 0, limit = Infinity) {
    this.inv = inv;
    this.missing = missing;
    this.alternatives = alternatives;
    this.table = table;
    this.furnace = furnace;
    this.cost = cost;
    this.limit = limit;
  }

  have(name: string): number {
    return this.inv.get(name) ?? 0;
  }

  give(name: string, n: number): void {
    this.inv.set(name, this.have(name) + n);
  }

  take(name: string, n: number): void {
    this.inv.set(name, this.have(name) - n);
  }

  /** Adds `n` of a raw material the inventory lacks, and counts it as missing. */
  lack(name: string, n: number): void {
    this.give(name, n);
    this.missing.set(name, (this.missing.get(name) ?? 0) + n);
    this.cost += n;
    if (this.cost > this.limit) throw PRUNED;
  }

  totals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const [name, n] of this.inv) if (n > 0) totals[name] = n;
    return totals;
  }

  clone(): Sim {
    const copy = new Sim(new Map(this.inv), new Map(this.missing), new Map(this.alternatives), this.table, this.furnace, this.cost, this.limit);
    copy.burn = this.burn;
    return copy;
  }

  adopt(other: Sim): void {
    this.inv = other.inv;
    this.missing = other.missing;
    this.alternatives = other.alternatives;
    this.table = other.table;
    this.furnace = other.furnace;
    this.burn = other.burn;
    this.cost = other.cost;
  }
}

/** One way to get an item: it runs on a copy of the state and throws a BranchEnd when it cannot or should not go on. */
interface Route {
  /** Taken only when the inventory covers it: a storage recipe. */
  coveredOnly: boolean;
  run(s: Sim): void;
}

interface Tried {
  sim: Sim;
  /** The raw materials this route added. */
  added: Map<string, number>;
}

/**
 * crafter.make over a virtual inventory: the same choices in the same order (smelt first when the
 * inventory holds an input; a table or furnace ensured before use; ingredients in recipe order;
 * depth 4), where make would fail for want of a raw material the plan names it as missing instead.
 */
class Planner {
  private readonly bot: Bot;
  private readonly catalog: Catalog;

  constructor(bot: Bot, catalog: Catalog) {
    this.bot = bot;
    this.catalog = catalog;
  }

  make(s: Sim, name: string, count: number, depth: number): void {
    const have0 = s.have(name);
    if (have0 >= count) return;
    const facts = this.catalog.facts(name);
    // A smelt that falls short fails as make's does: the furnace it made or placed stays, and the other routes go on from there.
    try {
      this.smeltHeld(s, name, count - have0, depth);
    } catch (err) {
      if (err !== INFEASIBLE) throw err;
    }
    if (s.have(name) >= count) return;
    const routes: Route[] = [
      ...facts.variants.map((v): Route => ({ coveredOnly: v.storage, run: (t) => this.craft(t, name, count, have0, depth, v) })),
      ...facts.candidates.map((input): Route => ({ coveredOnly: false, run: (t) => this.smeltFrom(t, name, count, input, depth) })),
    ];
    const chosen = this.choose(s, routes);
    if (chosen) s.adopt(chosen);
    // No way to get it here (or none within the depth limit): it is a raw material, to gather.
    else s.lack(name, count - s.have(name));
  }

  /** The cheapest of `routes`, by raw units added, then by how common those materials are, then in order; undefined when none can be done. */
  private choose(s: Sim, routes: Route[]): Sim | undefined {
    const tied: Tried[] = [];
    let bestCost = Infinity;
    let pruned = false;
    for (const route of routes) {
      const t = s.clone();
      t.limit = route.coveredOnly ? s.cost : Math.min(s.limit, s.cost + bestCost);
      try {
        route.run(t);
      } catch (err) {
        if (!(err instanceof BranchEnd)) throw err;
        // A storage route that needed anything is cut by its own limit, which says nothing about the caller's.
        pruned ||= err.pruned && !route.coveredOnly;
        continue;
      }
      const cost = t.cost - s.cost;
      if (cost < bestCost) {
        bestCost = cost;
        tied.length = 0;
      }
      tied.push({ sim: t, added: added(s, t) });
      if (cost === 0) break;
    }
    if (tied.length === 0) {
      // With no route found, only the limit a caller set can have cut one: the caller's route is the one that costs too much.
      if (pruned) throw PRUNED;
      return undefined;
    }
    const score = (t: Tried) => [...t.added].reduce((sum, [item, n]) => sum + commonRank(item) * n, 0);
    let primary = tied[0]!;
    for (const t of tied) if (score(t) < score(primary)) primary = t;
    for (const t of tied) if (t !== primary) standIns(primary, t);
    return primary.sim;
  }

  /** Smelts what the inventory holds of the inputs of `name`, most plentiful first, until `left` are made. */
  private smeltHeld(s: Sim, name: string, left: number, depth: number): void {
    const held = this.catalog
      .facts(name)
      .smeltable.map((input) => ({ input, count: s.have(input) }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count);
    for (const { input, count } of held) {
      if (left <= 0) return;
      const n = Math.min(left, count);
      this.smelt(s, input, name, n, depth);
      left -= n;
    }
  }

  /** The route of a recipe variant: a table, then the ingredients, then the craft. */
  private craft(t: Sim, name: string, count: number, have0: number, depth: number, v: Variant): void {
    if (depth >= MAX_MAKE_DEPTH) throw INFEASIBLE;
    const times = Math.ceil((count - have0) / v.makes);
    const ingredients = v.delta.filter((d) => d.count < 0).map((d) => ({ name: d.name, need: -d.count * times }));
    if (v.requiresTable) this.ensureTable(t, depth);
    // Making one ingredient can consume another, so repeat until all are present at once.
    for (let pass = 0; pass < 3; pass++) {
      const short = ingredients.filter((i) => t.have(i.name) < i.need);
      if (short.length === 0) break;
      for (const i of short) this.make(t, i.name, i.need, depth + 1);
    }
    if (v.requiresTable) this.ensureTable(t, depth);
    this.craftNow(t, name, count - t.have(name));
  }

  /** craft.craft: the first recipe the inventory satisfies, without a table, else with one. */
  private craftNow(t: Sim, name: string, need: number): void {
    const variants = this.catalog.facts(name).variants;
    const times = (v: Variant) => Math.ceil(need / v.makes);
    const met = (v: Variant) => v.delta.every((d) => t.have(d.name) + d.count * times(v) >= 0);
    const recipe = variants.find((v) => !v.requiresTable && met(v)) ?? variants.find((v) => v.requiresTable && t.table && met(v));
    if (!recipe) throw INFEASIBLE;
    for (const d of recipe.delta) t.give(d.name, d.count * times(recipe));
  }

  /** The route of an item with no recipe the inventory covers: make or name `input`, then smelt it. */
  private smeltFrom(t: Sim, name: string, count: number, input: string, depth: number): void {
    const need = count - t.have(name);
    if (this.catalog.facts(input).smeltable.length > 0) {
      // An input that is itself a furnace output (stone for smooth_stone) is made in turn.
      if (depth >= MAX_MAKE_DEPTH) throw INFEASIBLE;
      this.make(t, input, need, depth + 1);
    } else {
      // The furnace is made before the input is smelted, and may take cobblestone the input needs.
      this.ensureFurnace(t, depth);
      t.lack(input, need);
    }
    this.smeltHeld(t, name, count - t.have(name), depth);
    if (t.have(name) < count) throw INFEASIBLE;
  }

  private ensureTable(s: Sim, depth: number): void {
    if (!s.table) {
      if (s.have("crafting_table") === 0) this.make(s, "crafting_table", 1, depth + 1);
      s.take("crafting_table", 1);
      s.table = true;
    }
  }

  private ensureFurnace(s: Sim, depth: number): void {
    if (!s.furnace) {
      if (s.have("furnace") === 0) this.make(s, "furnace", 1, depth + 1);
      s.take("furnace", 1);
      s.furnace = true;
    }
  }

  /** Smelts `n` of `input` into `output`, one stack at a time, as furnace.smelt does: fuel for each batch, the input set aside. */
  private smelt(s: Sim, input: string, output: string, n: number, depth: number): void {
    this.ensureFurnace(s, depth);
    if (s.have(input) < n) throw INFEASIBLE;
    const stack = this.bot.registry.itemsByName[input]?.stackSize ?? 64;
    for (let remaining = n; remaining > 0; ) {
      const batch = Math.min(remaining, stack);
      this.burn(s, input, remaining, batch * SMELT_TICKS);
      s.take(input, batch);
      s.give(output, batch);
      remaining -= batch;
    }
  }

  /**
   * Spends the fuel furnace.smelt would load for `ticks`: none while the furnace still burns enough from
   * an earlier smelt (less BURN_SLACK_TICKS, which burn away between smelts); else what pickFuel picks,
   * or, when the inventory has none that covers it, the fewest coal that does.
   */
  private burn(s: Sim, input: string, remaining: number, ticks: number): void {
    const needed = ticks - Math.max(0, s.burn - BURN_SLACK_TICKS);
    if (needed <= 0) {
      s.burn -= ticks;
      return;
    }
    const held = withoutReserved(s.totals(), input, remaining);
    let fuel = pickFuel(held, needed);
    for (let coal = 1; !fuel; coal++) {
      fuel = pickFuel({ ...held, coal: (held.coal ?? 0) + coal }, needed);
      if (fuel) s.lack("coal", coal);
    }
    s.take(fuel.item, fuel.count);
    s.burn += fuel.count * burnTicks(fuel.item) - ticks;
  }
}

/** The raw materials `after` added to `before`. */
function added(before: Sim, after: Sim): Map<string, number> {
  const delta = new Map<string, number>();
  for (const [item, n] of after.missing) {
    const more = n - (before.missing.get(item) ?? 0);
    if (more > 0) delta.set(item, more);
  }
  return delta;
}

/** Records the raw materials `other` would use in place of the ones `primary` uses, pairing those that differ in order. */
function standIns(primary: Tried, other: Tried): void {
  const mine = [...primary.added.keys()].filter((item) => !other.added.has(item));
  const theirs = [...other.added.keys()].filter((item) => !primary.added.has(item));
  for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
    const list = primary.sim.alternatives.get(mine[i]!) ?? [];
    if (!list.includes(theirs[i]!)) primary.sim.alternatives.set(mine[i]!, [...list, theirs[i]!]);
  }
}

function planItem(ctx: RoutineContext, item: string, count: number) {
  const { bot } = ctx;
  const name = item.replace(/^minecraft:/, "");
  itemId(ctx, name);
  const inv = new Map<string, number>();
  for (const stack of bot.inventory.items()) inv.set(stack.name, (inv.get(stack.name) ?? 0) + stack.count);
  const near = (block: string) => bot.findBlock({ matching: bot.registry.blocksByName[block]!.id, maxDistance: TABLE_SEARCH_RADIUS }) !== null;
  const stations = { table: near("crafting_table"), furnace: near("furnace") };
  const have = inv.get(name) ?? 0;
  const planner = new Planner(bot, catalogOf(bot));
  const missing = new Map<string, number>();
  const standIn = new Map<string, string[]>();
  // With the raw materials in hand, make's own ranking can spend them differently than the plan expected
  // (it takes the first wood it can craft from): plan again on the stocked inventory until nothing more is missing.
  for (let pass = 0; pass < MAX_PLAN_PASSES; pass++) {
    const sim = new Sim(new Map(inv), new Map(), new Map(), stations.table, stations.furnace);
    planner.make(sim, name, count, 0);
    if (sim.missing.size === 0) break;
    for (const [raw, n] of sim.missing) {
      missing.set(raw, (missing.get(raw) ?? 0) + n);
      inv.set(raw, (inv.get(raw) ?? 0) + n);
    }
    for (const [raw, others] of sim.alternatives) standIn.set(raw, [...new Set([...(standIn.get(raw) ?? []), ...others])]);
  }
  const alternatives: Record<string, string[]> = {};
  for (const [raw, others] of standIn) if (missing.has(raw)) alternatives[raw] = others;
  return { item: name, count, have, missing: Object.fromEntries(missing), alternatives };
}

export const plan = defineRoutine(
  {
    name: "crafter.plan",
    description:
      "Say what `count` (default 1) of `item` still needs, without doing anything: a dry run of crafter.make over the inventory and the crafting table and furnace within 32 blocks. Returns { item, count, have, missing, alternatives }. `have` is what the inventory holds now. `missing` is { item: n } of the raw materials still to gather (oak_log, cobblestone, raw_iron, coal, ...), counting what a crafting table or furnace you lack would take (logs; 8 cobblestone) and coal for fuel (charcoal, planks, and logs burn too); `{}` means crafter.make can make it now. An ore block is never named: mine it for its raw item. Where several recipes need the same amount it names the commonest material, and `alternatives` lists the others that would do instead ({ cobblestone: [cobbled_deepslate, blackstone] }). Fails for an unknown item.",
    args: z.object({ item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.object({ item: z.string(), count: z.number(), have: z.number(), missing: z.record(z.string(), z.number()), alternatives: z.record(z.string(), z.array(z.string())) }),
  },
  (ctx, { item, count }) => planItem(ctx, item, count),
);
