// Reference ("oracle") program for the benchmark tasks. It proves each task is solvable
// through the body API and that its verifier passes. Run it as a module with the target in its arguments:
//   minebot run progression.ts --args '{"target":"wooden_pickaxe","builtins":false}' --timeout 900000
// or save it as a routine (`minebot routines save progression.ts`) and call it with the same arguments. The solutions of the
// benchmark tasks use all three paths: collect-logs saves it, binds it as the action `oracle`, and calls it; craft-wooden-pickaxe
// saves it and runs run-saved.ts, which imports it from the library; every other solution runs this file.
// target is "logs" (collect LOG_GOAL logs), "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "shelter"
// (dig in and seal the hole; the shell waits for the nights), "stock_chest", "stash_chest" (the first session of
// two-sessions), "retrieve_logs" (the second), or "dawn" (strike what comes close until the first night is over).
// The first three targets use Mineflayer alone, in every tier. The others call the built-in routines where the body
// offers them (`builtins` is true) and use Mineflayer where it does not, so one program solves each task in each tier.
// Each built-in module is imported where it is called (`await import`, because a static import would evaluate it on a body
// that does not offer it), so with `builtins: false` no built-in import is evaluated, and a body that fails to offer a
// module the tier promises fails the run instead of silently taking the Mineflayer path.
//
// The default export takes the run's ctx and arguments, and the helpers read them as `ctx`, `bot`, `log`, `sleep`, `signal`,
// `notes`, `target` and `builtins`. A `!` marks a value that the types allow to be absent and that the program uses without a check
// (it dereferences the value or passes it on); `errMessage` reads the message of a catch variable, whose type is unknown.
import { goals } from "mineflayer-pathfinder";
import type { Block, Entity, Item, RoutineContext } from "minebot-sdk/routine";
import type * as vec3 from "vec3";

const { Vec3 } = require("vec3") as typeof vec3;
type Vec3 = vec3.Vec3;

type Target =
  | "logs"
  | "wooden_pickaxe"
  | "stone_pickaxe"
  | "iron_pickaxe"
  | "diamond_pickaxe"
  | "shelter"
  | "stock_chest"
  | "stash_chest"
  | "retrieve_logs"
  | "dawn";

/** A step on the ground plane, and a unit step in space. */
type Step = [number, number];
type Face = [number, number, number];

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export default async function oracle(ctx: RoutineContext, { target, builtins }: { target: Target; builtins: boolean }): Promise<string[] | number> {
  const { bot, log, sleep, signal, notes } = ctx;
  const LOG_GOAL = target === "logs" ? 8 : 4;
  const reg = bot.registry;
  const isLog = (name: string) => name.endsWith("_log") && !name.startsWith("stripped_");
  const count = (pred: (name: string) => boolean) => bot.inventory.items().filter((i) => pred(i.name)).reduce((n, i) => n + i.count, 0);
  const has = (name: string) => count((n) => n === name) > 0;
  const logIds = Object.values(reg.blocksByName).filter((b) => isLog(b.name)).map((b) => b.id);

  /** Rejects after `ms` and runs `cancel`; pathfinding and digging can otherwise wait forever. */
  async function within<T>(ms: number, label: string, promise: Promise<T>, cancel: () => void): Promise<T> {
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      cancel();
      expired.reject(new Error(`${label} took longer than ${ms} ms`));
    }, ms);
    try {
      return await Promise.race([promise, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  const goto = (goal: goals.Goal, ms = 45_000) => within(ms, "pathfinding", bot.pathfinder.goto(goal), () => bot.pathfinder.stop());

  async function pickUpDrops() {
    await sleep(400);
    const drops = Object.values(bot.entities).filter(
      (e) => e.name === "item" && e.position.distanceTo(bot.entity.position) < 8,
    );
    for (const drop of drops) {
      const p = drop.position.floored();
      try {
        await goto(new goals.GoalBlock(p.x, p.y, p.z), 10_000);
      } catch (err) {
        log(`could not reach drop at ${p}: ${errMessage(err)}`);
      }
    }
    await sleep(400);
  }

  async function explore() {
    const angle = Math.random() * 2 * Math.PI;
    const p = bot.entity.position;
    log("no target nearby; exploring");
    await goto(new goals.GoalXZ(p.x + 40 * Math.cos(angle), p.z + 40 * Math.sin(angle)), 60_000).catch((err) =>
      log(`exploring: ${err.message}`),
    );
  }

  async function collect(blockIds: number[], enough: () => boolean, label: string, radius = 48) {
    let failures = 0;
    const skipped = new Set<string>();
    while (!enough()) {
      if (signal.aborted) throw signal.reason;
      // Prefer blocks near our own height: high logs need scaffolding.
      const candidates = bot
        .findBlocks({ matching: blockIds, maxDistance: radius, count: 64 })
        .filter((p) => !skipped.has(p.toString()))
        .sort(
          (a, b) =>
            Math.abs(a.y - bot.entity.position.y) - Math.abs(b.y - bot.entity.position.y) ||
            a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position),
        );
      const target = candidates[0];
      if (!target) {
        await explore();
        continue;
      }
      try {
        await goto(new goals.GoalLookAtBlock(target, bot.world));
        const block = bot.blockAt(target)!;
        // Hold the best tool for every block; a stone block dug by hand drops nothing.
        const tool = bot.pathfinder.bestHarvestTool(block);
        if (tool) await bot.equip(tool, "hand");
        if (!block.canHarvest(bot.heldItem?.type ?? null)) throw new Error(`cannot harvest ${block.name} with ${bot.heldItem?.name ?? "an empty hand"}`);
        await within(20_000, "digging", bot.dig(block), () => bot.stopDigging());
        await pickUpDrops();
        log(`${label}: dug ${block.name} at ${target}`);
      } catch (err) {
        skipped.add(target.toString());
        if (++failures > 12) throw new Error(`gave up collecting ${label}: ${errMessage(err)}`);
        log(`skipping ${label} at ${target}: ${errMessage(err)}`);
      }
    }
  }

  async function craft(name: string, times = 1, table: Block | null = null) {
    const recipe = bot.recipesFor(reg.itemsByName[name]!.id, null, 1, table)[0];
    if (!recipe) {
      const inv = bot.inventory.items().map((i) => `${i.name} x${i.count}`).join(", ");
      throw new Error(`no recipe for ${name} with the current inventory (${inv}; table: ${table ? table.position : "none"})`);
    }
    await bot.craft(recipe, times, table ?? undefined);
    log(`crafted ${name}`);
  }

  /** Places a `name` block (crafting_table, furnace, chest) from the inventory on open ground near the player, or finds one within 4 blocks. */
  async function placeNear(name: string): Promise<Block> {
    const nearby = bot.findBlock({ matching: reg.blocksByName[name]!.id, maxDistance: 4 });
    if (nearby) return nearby;
    await bot.equip(reg.itemsByName[name]!.id, "hand");
    const base = bot.entity.position.floored();
    const free = (b: Block | null) => b?.boundingBox === "empty" && !/water|lava/.test(b.name);
    const spots: { spot: Vec3; ground: Block }[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (Math.abs(dx) + Math.abs(dz) < 1 || (dx === 0 && dz === 0)) continue;
          const spot = base.offset(dx, dy, dz);
          const ground = bot.blockAt(spot.offset(0, -1, 0));
          if (ground?.boundingBox === "block" && free(bot.blockAt(spot))) spots.push({ spot, ground });
        }
      }
    }
    spots.sort((a, b) => a.spot.distanceTo(base) - b.spot.distanceTo(base));
    for (const { spot, ground } of spots.slice(0, 8)) {
      try {
        await goto(new goals.GoalNear(spot.x, spot.y, spot.z, 3), 15_000);
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        return bot.blockAt(spot)!;
      } catch (err) {
        log(`placing ${name} at ${spot} failed: ${errMessage(err)}`);
      }
    }
    throw new Error(`found no spot to place the ${name}`);
  }

  async function woodenTools() {
    // Each log type crafts its own planks; any planks work for the tools.
    for (const item of bot.inventory.items().filter((i) => isLog(i.name))) {
      await craft(item.name.replace(/_log$/, "_planks"), item.count);
    }
    if (!has("crafting_table")) await craft("crafting_table");
    await craft("stick");
    const table = await placeNear("crafting_table");
    await craft("wooden_pickaxe", 1, table);
    return table;
  }

  // ---- Helpers for the longer targets ----

  const isPlanks = (name: string) => name.endsWith("_planks");
  const blockIds = (names: string[]) => names.map((n) => reg.blocksByName[n]!.id);

  /** Walks next to the nearest block of `name` that the inventory placed earlier, or places one when there is none within 4 blocks. */
  async function nearBlock(name: string): Promise<Block | null> {
    const near = bot.findBlock({ matching: reg.blocksByName[name]!.id, maxDistance: 4 });
    if (near) return near;
    const known = bot.findBlock({ matching: reg.blocksByName[name]!.id, maxDistance: 64 });
    if (!known) return null;
    // Coming back from the ore can be a long walk uphill.
    for (let attempt = 1; ; attempt++) {
      try {
        await goto(new goals.GoalNear(known.position.x, known.position.y, known.position.z, 2), 120_000);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        log(`walking to the ${name}: ${errMessage(err)}; trying again`);
      }
    }
    return bot.blockAt(known.position);
  }

  /**
   * Collects `n` logs of one species: planks of two species do not mix in a recipe, so the tools and the chest
   * are crafted from one. Returns the species, e.g. "oak_log".
   */
  async function collectLogs(n: number) {
    let nearest = bot.findBlock({ matching: logIds, maxDistance: 64 });
    while (!nearest) {
      await explore();
      nearest = bot.findBlock({ matching: logIds, maxDistance: 64 });
    }
    const species = nearest.name;
    const before = count((name) => name === species);
    if (builtins) {
      const gatherer = await import("minebot-sdk/routines/gatherer");
      if (n > before) await gatherer.gather(ctx, { blocks: species, count: n - before });
    } else await collect(blockIds([species]), () => count((name) => name === species) >= n, species);
    return species;
  }

  /** Crafts planks from `species` logs until the inventory holds `n` planks. */
  async function planksFrom(species: string, n: number) {
    const planks = species.replace(/_log$/, "_planks");
    while (count(isPlanks) < n) await craft(planks, 1);
  }

  /** Digs the named blocks until the inventory holds `n` of `item`. */
  async function mine(blocks: string[], item: string, n: number, radius = 48) {
    const have = () => count((name) => name === item);
    if (!builtins) return collect(blockIds(blocks), () => have() >= n, item, radius);
    const gatherer = await import("minebot-sdk/routines/gatherer");
    // gather counts blocks dug, and a drop can stay behind, so ask again for what is missing.
    for (let attempt = 0; attempt < 4 && have() < n; attempt++) {
      try {
        await gatherer.gather(ctx, { blocks, count: n - have(), radius });
      } catch (err) {
        log(`gather ${item}: ${errMessage(err)}`);
        await sleep(1000);
      }
    }
    if (have() < n) throw new Error(`mined ${have()} of ${n} ${item}`);
  }

  /** Where the oracle placed its crafting table, so that it can come back from wherever the ore was. */
  let tableSpot: Vec3 | null = null;

  /** The crafting table of the oracle's work: a table within reach, placed from the inventory if need be. */
  async function tableNearby(): Promise<Block> {
    const table = await nearBlock("crafting_table");
    if (table) return table;
    if (tableSpot) {
      await goto(new goals.GoalNear(tableSpot.x, tableSpot.y, tableSpot.z, 2), 120_000);
      const there = bot.blockAt(tableSpot);
      if (there?.name === "crafting_table") return there;
    }
    if (!has("crafting_table")) await craft("crafting_table");
    const placed = await placeNear("crafting_table");
    tableSpot = placed.position;
    return placed;
  }

  /** Tools up to the wooden pickaxe from logs of one species, keeping the other logs. */
  async function woodenPickaxe(species: string) {
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      // Place the table before making the pickaxe: make() otherwise crafts a table from the planks that the pickaxe needs.
      if (!(await nearBlock("crafting_table"))) {
        await crafter.make(ctx, { item: "crafting_table" });
        tableSpot = (await placeNear("crafting_table")).position;
      }
      await crafter.make(ctx, { item: "wooden_pickaxe" });
      return;
    }
    await planksFrom(species, 9);
    await craft("stick", 2);
    const table = await tableNearby();
    await craft("wooden_pickaxe", 1, table);
  }

  async function stonePickaxe() {
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      await crafter.make(ctx, { item: "stone_pickaxe" });
      return;
    }
    await craft("stone_pickaxe", 1, await tableNearby());
  }

  /** Whether an item name matches a `*` glob such as `*_log`. */
  const globMatch = (glob: string) => {
    const re = new RegExp(`^${glob.replace(/\*/g, ".*")}$`);
    return (name: string) => re.test(name);
  };

  /** Takes every item that matches the glob out of the chest block into the inventory. */
  async function withdrawAll(chestBlock: Block, glob: string) {
    if (builtins) {
      const container = await import("minebot-sdk/routines/container");
      await container.withdraw(ctx, { at: chestBlock.position, items: glob });
      return;
    }
    const matches = globMatch(glob);
    const chest = await bot.openContainer(chestBlock);
    try {
      for (const item of chest.containerItems().filter((i) => matches(i.name))) {
        await chest.withdraw(item.type, null, item.count);
        await sleep(300);
      }
    } finally {
      chest.close();
    }
  }

  /** Puts `n` of the items that match the glob into the chest block, one kind at a time. */
  async function depositSome(chestBlock: Block, glob: string, n: number) {
    if (builtins) {
      const container = await import("minebot-sdk/routines/container");
      const { total } = await container.deposit(ctx, { at: chestBlock.position, items: glob, count: n });
      if (total < n) throw new Error(`the inventory lacked ${n - total} of the items for the chest`);
      return;
    }
    const matches = globMatch(glob);
    const chest = await bot.openContainer(chestBlock);
    try {
      let left = n;
      for (const item of bot.inventory.items().filter((i) => matches(i.name))) {
        if (left <= 0) break;
        const take = Math.min(item.count, left);
        await chest.deposit(item.type, null, take);
        await sleep(300);
        left -= take;
      }
      if (left > 0) throw new Error(`the inventory lacked ${left} of the items for the chest`);
    } finally {
      chest.close();
    }
  }

  /** Smelts `n` of `input` at the furnace block with logs or coal as fuel. */
  async function smelt(furnaceBlock: Block, input: string, n: number) {
    const fuel = bot.inventory.items().find((i) => i.name === "coal" || i.name === "charcoal") ?? bot.inventory.items().find((i) => isLog(i.name));
    if (!fuel) throw new Error("no fuel for the furnace");
    const fuelItems = fuel.name === "coal" || fuel.name === "charcoal" ? 1 : Math.min(fuel.count, Math.ceil((n * 10) / 15) + 1);
    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      await furnace.putFuel(fuel.type, null, fuelItems);
      await furnace.putInput(reg.itemsByName[input]!.id, null, n);
      const deadline = Date.now() + n * 10_000 + 30_000;
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if ((furnace.outputItem()?.count ?? 0) >= n) break;
        if (Date.now() > deadline) throw new Error(`smelting ${n} ${input} took too long`);
        await sleep(500);
      }
      await furnace.takeOutput();
      log(`smelted ${n} ${input}`);
    } finally {
      furnace.close();
    }
  }

  // ---- iron_pickaxe: wood, stone, iron ore, a furnace, fuel, three ingots, the pickaxe ----

  async function ironPickaxe() {
    // Planks: table 4, sticks 4 (three tools need six sticks), wooden pickaxe 3 = 3 logs. Fuel: 3 logs. A margin of 1.
    const species = await collectLogs(7);
    await woodenPickaxe(species);
    // The stone pickaxe takes 3 cobblestone and the furnace 8.
    await mine(["stone", "cobblestone"], "cobblestone", 11);
    await stonePickaxe();
    await mine(["iron_ore", "deepslate_iron_ore"], "raw_iron", 3, 96);
    // The pathfinder spends cobblestone as scaffolding on the way to the ore and back; the furnace needs 8.
    const cobblestoneForFurnace = async () => {
      if (count((name) => name === "cobblestone") < 8) await mine(["stone", "cobblestone"], "cobblestone", 8);
    };
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      // Back to the table, on the surface: make() places a furnace on open ground near where it stands, and the ore was underground.
      await tableNearby();
      await cobblestoneForFurnace();
      await tableNearby();
      // Smelts the raw iron at a furnace that it crafts from the cobblestone and places, then crafts the pickaxe.
      // A busy server can leave a placement unanswered; the next attempt starts from the table again.
      for (let attempt = 1; ; attempt++) {
        try {
          await crafter.make(ctx, { item: "iron_pickaxe" });
          return;
        } catch (err) {
          if (attempt === 3) throw err;
          log(`iron_pickaxe attempt ${attempt}: ${errMessage(err)}`);
          await sleep(5000);
          await tableNearby();
        }
      }
    }
    await tableNearby();
    await cobblestoneForFurnace();
    const table = await tableNearby();
    await craft("furnace", 1, table);
    const furnace = await placeNear("furnace");
    await smelt(furnace, "raw_iron", 3);
    await craft("iron_pickaxe", 1, await tableNearby());
  }

  // ---- diamond_pickaxe: the iron pickaxe chain, three diamonds from deep underground, the pickaxe ----

  const DIAMOND_ORES = ["diamond_ore", "deepslate_diamond_ore"];

  async function diamondPickaxe() {
    // Plans through rock take long on a busy machine: give the pathfinder more time than its 5 s default.
    bot.pathfinder.thinkTimeout = 30_000;
    // Two logs more than the iron pickaxe needs: a crafting table down at the diamonds, so the pickaxe needs no climb back.
    const species = await collectLogs(9);
    await ironPickaxe();
    // Tunneling 60 blocks and more down digs some 200 blocks, which wears out a stone pickaxe and would wear out the one iron
    // pickaxe that the diamonds need. Make two spare stone pickaxes for the rock, and dig with the iron one only where nothing
    // cheaper harvests the block.
    await spareStonePickaxes(species, 2);
    const fastest = bot.pathfinder.bestHarvestTool.bind(bot.pathfinder);
    bot.pathfinder.bestHarvestTool = (block) => cheapTool(block) ?? fastest(block);
    await diamonds(3);
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      await crafter.make(ctx, { item: "diamond_pickaxe" });
    } else {
      await planksFrom(species, 4);
      if (!has("crafting_table")) await craft("crafting_table");
      if (count((n) => n === "stick") < 2) {
        await planksFrom(species, 2);
        await craft("stick");
      }
      const table = await placeNear("crafting_table");
      await craft("diamond_pickaxe", 1, table);
    }
    // The night has to pass without a death, and the caves are dark: clear the creatures nearby, then wall the player in.
    await fightOff();
    await sealIn();
  }

  /** The cheapest pickaxe in the inventory that harvests `block`, stone before wood (wood digs deepslate slowly), iron excepted; none for diamond ore. */
  function cheapTool(block: Block): Item | undefined {
    if (DIAMOND_ORES.includes(block.name)) return undefined;
    return ["stone_pickaxe", "wooden_pickaxe"].map((name) => bot.inventory.items().find((i) => i.name === name)).find((tool) => tool && block.canHarvest(tool.type));
  }

  /** Crafts `n` more stone pickaxes at the crafting table, with sticks from `species` planks and cobblestone it mines if short. */
  async function spareStonePickaxes(species: string, n: number) {
    if (count((name) => name === "cobblestone") < 3 * n) await mine(["stone", "cobblestone"], "cobblestone", 3 * n);
    while (count((name) => name === "stick") < 2 * n) {
      await planksFrom(species, 2);
      await craft("stick");
    }
    const table = await tableNearby();
    for (let i = 0; i < n; i++) await craft("stone_pickaxe", 1, table);
  }

  const LIQUID = /lava|water/;
  const isSolid = (block: Block | null) => block?.boundingBox === "block";
  const FACES: Face[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  /** True when the cell holds lava or water, or touches it: digging it would let the liquid in. */
  const wet = (cell: Vec3) => ([[0, 0, 0], ...FACES] satisfies Face[]).some(([x, y, z]) => LIQUID.test(bot.blockAt(cell.offset(x, y, z))?.name ?? ""));

  /** Digs `cell` until it is open (falling gravel or sand fills it again), with the cheapest pickaxe that harvests the block. */
  async function digCell(cell: Vec3) {
    for (let i = 0; i < 6 && isSolid(bot.blockAt(cell)); i++) {
      const block = bot.blockAt(cell)!;
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool) await bot.equip(tool, "hand");
      await within(15_000, "digging", bot.dig(block, true), () => bot.stopDigging());
      await sleep(150);
    }
    if (isSolid(bot.blockAt(cell))) throw new Error(`could not clear ${cell}`);
  }

  /** Walks (jumping for a step up) into the open cell next to the player, and stops in its middle. */
  async function stepInto(cell: Vec3, jump: boolean) {
    const center = cell.offset(0.5, 0, 0.5);
    const flat = () => Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z);
    bot.setControlState("forward", true);
    if (jump) bot.setControlState("jump", true);
    try {
      for (const end = Date.now() + 3000; Date.now() < end && flat() > 0.3; ) {
        await bot.lookAt(new Vec3(center.x, bot.entity.position.y + 1.6, center.z), true);
        await sleep(50);
      }
    } finally {
      bot.clearControlStates();
    }
    await sleep(300);
    if (flat() > 0.6) throw new Error(`could not step into ${cell}`);
  }

  /** True when the player can stand in `cell` or drop at most 3 blocks below it onto solid ground, with no liquid on the way. */
  function landing(cell: Vec3) {
    for (let d = 1; d <= 4; d++) {
      const below = bot.blockAt(cell.offset(0, -d, 0));
      if (isSolid(below)) return true;
      if (LIQUID.test(below?.name ?? "")) return false;
    }
    return false;
  }

  /**
   * Tunnels toward `target` until the eyes are within `reach` of it: a staircase down while the target is below, a two-high
   * tunnel at its level, a step up while it is above. It digs every cell itself instead of planning with the pathfinder, which
   * gives up on long digs through rock and plans slowly on a busy machine. A direction whose cells hold or touch lava or water,
   * or that ends over a drop of more than 3 blocks, is not taken; the next one toward the target is. When no step down is safe
   * (an aquifer or a cave below), it steps level; when no step at all is, it lets the pathfinder walk it a few blocks aside.
   */
  async function tunnelTo(target: Vec3, reach = 4) {
    let heading: Step | null = null;
    let sidesteps = 0;
    const visited = new Set<string>();
    for (let step = 0; step < 500; step++) {
      if (signal.aborted) throw signal.reason;
      // Caves are dark at any hour: deal with a creature that comes close before the next step.
      if (bot.nearestEntity((e) => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < 4)) await fightOff(5, 20_000);
      const feet = bot.entity.position.floored();
      visited.add(feet.toString());
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(target) <= reach) return;
      const dx = Math.floor(target.x) - feet.x;
      const dz = Math.floor(target.z) - feet.z;
      const dy = Math.floor(target.y) - feet.y;
      const along = ([[Math.sign(dx), 0], [0, Math.sign(dz)]] satisfies Step[]).filter(([x, z]) => x || z);
      if (Math.abs(dz) > Math.abs(dx)) along.reverse();
      // Toward the target first; straight above or below it, keep the heading; then any side.
      const headings: Step[] = [...along, ...(heading ? [heading] : []), ...SIDES].filter((h, i, all) => all.findIndex((o) => o[0] === h[0] && o[1] === h[1]) === i);
      const wanted = dy < 0 ? -1 : dy > 1 ? 1 : 0;
      let moved = false;
      // A cell the tunnel stood in before is a way back, not forward: going there again is how a tunnel oscillates.
      for (const climb of wanted === 0 ? [0] : [wanted, 0]) {
        for (const [x, z] of headings) {
          const next = feet.offset(x, climb, z);
          if (visited.has(next.toString())) continue;
          const cells =
            climb < 0 ? [feet.offset(x, 1, z), feet.offset(x, 0, z), next] : climb > 0 ? [feet.offset(0, 2, 0), next, next.offset(0, 1, 0)] : [next, next.offset(0, 1, 0)];
          if (cells.some(wet) || !landing(next)) continue;
          try {
            for (const cell of cells) await digCell(cell);
            await stepInto(next, climb > 0);
            heading = [x, z];
            moved = true;
            break;
          } catch (err) {
            log(`tunnel at ${feet}: ${errMessage(err)}`);
          }
        }
        if (moved) break;
      }
      if (moved) continue;
      if (++sidesteps > 4) throw new Error(`boxed in at ${feet}: liquid or a drop on every side`);
      const angle = Math.random() * 2 * Math.PI;
      log(`boxed in at ${feet}; walking aside`);
      await goto(new goals.GoalNear(feet.x + Math.round(8 * Math.cos(angle)), feet.y, feet.z + Math.round(8 * Math.sin(angle)), 2), 60_000).catch((err) => log(`walking aside: ${err.message}`));
    }
    throw new Error(`still far from ${target}`);
  }

  /**
   * Mines diamond ore until the inventory holds `n` diamonds: the nearest ore first, reached by tunneling to it. Ore that
   * cannot be reached (water or lava around it) is skipped with its whole cluster.
   */
  async function diamonds(n: number) {
    const have = () => count((name) => name === "diamond");
    const skipped: Vec3[] = [];
    while (have() < n) {
      if (signal.aborted) throw signal.reason;
      const ores = bot.findBlocks({ matching: blockIds(DIAMOND_ORES), maxDistance: 128, count: 128 }).filter((p) => !skipped.some((s) => s.distanceTo(p) <= 4));
      ores.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
      const ore = ores[0];
      if (!ore) throw new Error(`no diamond ore within 128 blocks; have ${have()} of ${n}`);
      try {
        log(`going for the diamond ore at ${ore}`);
        await tunnelTo(ore.offset(0.5, 0.5, 0.5));
        const block = bot.blockAt(ore);
        if (!DIAMOND_ORES.includes(block?.name ?? "")) throw new Error(`the block is ${block?.name} now`);
        await bot.equip(bot.inventory.items().find((i) => i.name === "iron_pickaxe")!, "hand");
        await within(20_000, "digging", bot.dig(block!), () => bot.stopDigging());
        await pickUpDrops();
        log(`dug ${block!.name} at ${ore}; ${have()} diamonds`);
      } catch (err) {
        skipped.push(ore);
        if (skipped.length > 8) throw new Error(`gave up on diamonds: ${errMessage(err)}`);
        log(`skipping the diamonds around ${ore}: ${errMessage(err)}`);
      }
    }
  }

  /** Creatures that attack on sight (the body's own rule, src/mc/hostile.ts). */
  const isHostileMob = (e: Entity) => e.kind === "Hostile mobs" && !["enderman", "zombified_piglin", "strider"].includes(e.name!);

  /** Strikes the hostile creatures within `radius` until none is left there, or `ms` pass. */
  async function fightOff(radius = 6, ms = 90_000) {
    const pickaxe = bot.inventory.items().find((i) => i.name === "diamond_pickaxe" || i.name === "iron_pickaxe");
    if (pickaxe) await bot.equip(pickaxe, "hand");
    for (const end = Date.now() + ms; Date.now() < end; ) {
      const foe = bot.nearestEntity((e) => isHostileMob(e) && e.position.distanceTo(bot.entity.position) < radius);
      if (!foe) return;
      if (foe.position.distanceTo(bot.entity.position) < 3.5) {
        await bot.lookAt(foe.position.offset(0, foe.height * 0.8, 0), true);
        bot.attack(foe);
      }
      await sleep(650);
    }
  }

  /** Blocks the inventory may spend on walls. */
  const WALL = ["cobblestone", "cobbled_deepslate", "stone", "deepslate", "andesite", "diorite", "granite", "tuff", "dirt"];

  /**
   * Surrounds the player's feet and head with blocks and caps it, so nothing reaches it until it digs out. Best effort: a
   * placement the server refuses (a creature or a drop in the cell) is retried once and then left open.
   */
  async function sealIn() {
    const here = bot.entity.position.floored();
    // Stand in the middle of the block, so the body is in no neighbor cell.
    await goto(new goals.GoalBlock(here.x, here.y, here.z), 10_000).catch(() => {});
    const feet = bot.entity.position.floored();
    const cells = [...SIDES.map(([x, z]) => feet.offset(x, 0, z)), ...SIDES.map(([x, z]) => feet.offset(x, 1, z)), feet.offset(0, 2, 0)];
    const faces = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];
    const open: string[] = [];
    for (const cell of cells) {
      for (let attempt = 1; attempt <= 2 && bot.blockAt(cell)?.boundingBox !== "block"; attempt++) {
        const wall = bot.inventory.items().find((i) => WALL.includes(i.name));
        // Place against any solid neighbor of the cell: the floor for the feet level, the block below for the head level.
        const face = faces.find((f) => bot.blockAt(cell.plus(f))?.boundingBox === "block");
        if (!wall || !face) break;
        try {
          await bot.equip(wall, "hand");
          await bot.placeBlock(bot.blockAt(cell.plus(face))!, face.scaled(-1));
        } catch (err) {
          log(`walling ${cell}: ${errMessage(err)}`);
          await sleep(500);
        }
      }
      if (bot.blockAt(cell)?.boundingBox !== "block") open.push(cell.toString());
    }
    log(`walled in at ${feet}${open.length ? `; open: ${open.join(" ")}` : ""}`);
  }

  // ---- shelter: a one-block shaft three deep with a block over it. The shell then waits for the nights. ----

  /** Blocks that a bare hand digs fast and that never fall or flow. */
  const SOFT = new Set(["grass_block", "dirt", "coarse_dirt", "podzol", "rooted_dirt", "mycelium", "farmland", "dirt_path"]);

  const SIDES: Step[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  /**
   * A column near the player where the three blocks below the feet are soft ground, solid dry ground lies under them,
   * and all four sides of the three blocks are solid: a shaft that has no cave, water, or lava beside it.
   */
  function shaftSite() {
    const base = bot.entity.position.floored();
    const sites: Vec3[] = [];
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const feet = base.offset(dx, dy, dz);
          if (bot.blockAt(feet)?.boundingBox !== "empty") continue;
          if (![1, 2, 3].every((d) => SOFT.has(bot.blockAt(feet.offset(0, -d, 0))?.name ?? ""))) continue;
          const floor = bot.blockAt(feet.offset(0, -4, 0));
          if (floor?.boundingBox !== "block" || /lava|water/.test(floor.name)) continue;
          const walled = [1, 2, 3].every((d) => SIDES.every(([x, z]) => bot.blockAt(feet.offset(x, -d, z))?.boundingBox === "block"));
          if (walled) sites.push(feet);
        }
      }
    }
    sites.sort((a, b) => a.distanceTo(base) - b.distanceTo(base));
    return sites[0];
  }

  async function shelter() {
    let site = shaftSite();
    while (!site) {
      await explore();
      site = shaftSite();
    }
    await goto(new goals.GoalBlock(site.x, site.y, site.z), 60_000);
    for (let i = 0; i < 3; i++) {
      const here = bot.entity.position;
      const below = bot.blockAt(here.floored().offset(0, -1, 0))!;
      await within(15_000, "digging", bot.dig(below), () => bot.stopDigging());
      await sleep(700); // fall into the hole and pick up the drop
      if (bot.entity.position.y > here.y - 0.5) {
        // Standing on the edge of the hole: step to its middle.
        await bot.lookAt(new Vec3(below.position.x + 0.5, bot.entity.position.y, below.position.z + 0.5), true);
        bot.setControlState("forward", true);
        await sleep(200);
        bot.setControlState("forward", false);
        await sleep(700);
      }
    }
    const feet = bot.entity.position.floored();
    const cap = bot.inventory.items().find((i) => ["dirt", "coarse_dirt", "rooted_dirt"].includes(i.name));
    if (!cap) throw new Error("no block to seal the shaft with");
    await bot.equip(cap, "hand");
    // The block above the head is level with the first dug block; place it against a wall of that level.
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] satisfies Step[]) {
      const wall = bot.blockAt(feet.offset(x, 2, z));
      if (wall?.boundingBox !== "block") continue;
      await bot.lookAt(feet.offset(0.5, 2.5, 0.5));
      await bot.placeBlock(wall, new Vec3(-x, 0, -z));
      await sleep(300);
      if (bot.blockAt(feet.offset(0, 2, 0))?.boundingBox === "block") {
        log(`sealed in at ${feet}`);
        return;
      }
    }
    throw new Error("could not seal the shaft");
  }

  // ---- stock_chest: logs, a wooden pickaxe, 16 cobblestone, a chest, and the cobblestone in it ----

  async function stockChest() {
    // Planks: table 4, sticks 2, pickaxe 3, chest 8 = 17, which is 5 logs; one more for margin.
    const species = await collectLogs(6);
    await woodenPickaxe(species);
    await mine(["stone", "cobblestone"], "cobblestone", 16);
    const chest = await placeChest(species);
    await depositSome(chest, "cobblestone", 16);
    return chest;
  }

  /** Crafts a chest from the planks of `species` and places it near a crafting table; returns the chest block. */
  async function placeChest(species: string) {
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      await crafter.make(ctx, { item: "chest" });
    } else {
      await planksFrom(species, 8);
      await craft("chest", 1, await tableNearby());
    }
    return placeNear("chest");
  }

  // ---- stash_chest and retrieve_logs: the two sessions of two-sessions ----

  const STASH_LOGS = 8;
  const STASH_DISTANCE = 200;

  async function stashChest() {
    // Table 1 log, chest 2 logs, the stash 8 logs.
    const species = await collectLogs(11);
    if (builtins) {
      const crafter = await import("minebot-sdk/routines/crafter");
      await crafter.make(ctx, { item: "crafting_table" });
    } else await planksFrom(species, 12);
    await tableNearby();
    const chest = await placeChest(species);
    await depositSome(chest, "*_log", STASH_LOGS);
    const { x, y, z } = chest.position;
    // The next session knows what the notes say and nothing else. In a kits tier the place memory holds it too.
    notes.set("stash", `The chest with ${STASH_LOGS} logs for the stone pickaxe is at x=${x} y=${y} z=${z} (overworld). Take the logs out and craft the tools.`);
    if (builtins) {
      const explorer = await import("minebot-sdk/routines/explorer");
      await explorer.remember(ctx, { name: "stash", at: [x, y, z], kind: "chest", contents: { [species]: STASH_LOGS }, note: "logs for the stone pickaxe" });
    }
    // Walk away along one heading, a leg at a time, until the chest is far behind and outside the loaded chunks.
    const angle = Math.random() * 2 * Math.PI;
    const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
    for (let leg = 0; leg < 10 && flat(bot.entity.position, chest.position) < STASH_DISTANCE + 8; leg++) {
      const here = bot.entity.position;
      await goto(new goals.GoalXZ(here.x + 80 * Math.cos(angle), here.z + 80 * Math.sin(angle)), 90_000).catch((err) => log(`walking away: ${err.message}`));
    }
    const far = flat(bot.entity.position, chest.position);
    if (far < STASH_DISTANCE) throw new Error(`only ${Math.round(far)} blocks from the chest`);
    log(`left the chest at ${x} ${y} ${z}, now ${Math.round(far)} blocks away`);
  }

  async function retrieveLogs() {
    // Where the chest is: the place memory when this tier has it, else the notes the first session wrote.
    let spot: { x: number; y: number; z: number } | null = null;
    if (builtins) {
      const explorer = await import("minebot-sdk/routines/explorer");
      const [place] = await explorer.places(ctx, { kind: "chest" });
      if (place) spot = place.position;
    }
    if (!spot) {
      const note = notes.get("stash");
      const m = note?.match(/x=(-?\d+) y=(-?\d+) z=(-?\d+)/);
      if (!m) throw new Error(`no note about the chest (notes: ${JSON.stringify(notes.list().map((n) => n.key))})`);
      spot = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
    }
    log(`the chest is at ${spot.x} ${spot.y} ${spot.z}`);
    // The chest is outside the loaded chunks: walk toward it a leg at a time, then to the chest itself.
    for (let leg = 0; leg < 10 && Math.hypot(bot.entity.position.x - spot.x, bot.entity.position.z - spot.z) > 60; leg++) {
      const here = bot.entity.position;
      const dx = spot.x - here.x;
      const dz = spot.z - here.z;
      const d = Math.hypot(dx, dz);
      await goto(new goals.GoalXZ(here.x + (dx / d) * Math.min(80, d), here.z + (dz / d) * Math.min(80, d)), 90_000).catch((err) => log(`walking back: ${err.message}`));
    }
    await goto(new goals.GoalNear(spot.x, spot.y, spot.z, 2), 120_000);
    const chest = bot.blockAt(new Vec3(spot.x, spot.y, spot.z));
    if (chest?.name !== "chest") throw new Error(`no chest at ${spot.x} ${spot.y} ${spot.z}; the block there is ${chest?.name}`);
    await withdrawAll(chest, "*_log");
    // Planks of two species do not mix in a recipe; the first session collected one species.
    const species = bot.inventory.items().find((i) => isLog(i.name))?.name;
    if (!species) throw new Error("the chest held no logs");
    await woodenPickaxe(species);
    await mine(["stone", "cobblestone"], "cobblestone", 3);
    await stonePickaxe();
  }

  // ---- Dispatch ----

  if (target === "iron_pickaxe") await ironPickaxe();
  else if (target === "diamond_pickaxe") await diamondPickaxe();
  else if (target === "shelter") await shelter();
  else if (target === "stock_chest") await stockChest();
  else if (target === "stash_chest") await stashChest();
  else if (target === "retrieve_logs") await retrieveLogs();
  else if (target === "dawn") {
    // The pickaxe is made and the player is walled in: keep it alive until the server's clock passes the end of the first night.
    while (bot.time.day < 1) {
      const foe = bot.nearestEntity((e) => e.kind === "Hostile mobs" && e.position.distanceTo(bot.entity.position) < 3.5);
      if (foe) bot.attack(foe);
      await sleep(1000);
    }
    return bot.time.time;
  } else {
    await collect(logIds, () => count(isLog) >= LOG_GOAL, "logs");
    if (target !== "logs") {
      const table = await woodenTools();
      if (target === "stone_pickaxe") {
        const stoneIds = ["stone", "cobblestone"].map((n) => reg.blocksByName[n]!.id);
        await collect(stoneIds, () => count((n) => n === "cobblestone") >= 3, "cobblestone");
        let near = bot.findBlock({ matching: reg.blocksByName.crafting_table!.id, maxDistance: 4 });
        if (!near) {
          await goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
          near = bot.blockAt(table.position);
        }
        await craft("stone_pickaxe", 1, near);
      }
    }
  }
  return bot.inventory.items().map((i) => `${i.name} x${i.count}`);
}
