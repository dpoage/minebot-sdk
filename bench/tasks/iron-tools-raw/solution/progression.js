// Reference ("oracle") program for the benchmark tasks. It proves each task is solvable
// through the body API and that its verifier passes. Run it with a TARGET prepended:
//   { echo 'const TARGET = "wooden_pickaxe";'; cat progression.js; } | minebot run --timeout 900000
// TARGET is "logs" (collect LOG_GOAL logs), "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "shelter" (dig in and
// seal the hole; the shell waits for the nights), "stock_chest", "stash_chest" (the first session of two-sessions),
// or "retrieve_logs" (the second).
// The first three targets use Mineflayer alone, in every tier. The others use the kits where the body offers them
// (`kit` is defined) and Mineflayer where it does not, so one program solves each task in each tier.
/* global TARGET, kit */
const LOG_GOAL = TARGET === "logs" ? 8 : 4;
const reg = bot.registry;
const isLog = (name) => name.endsWith("_log") && !name.startsWith("stripped_");
const count = (pred) => bot.inventory.items().filter((i) => pred(i.name)).reduce((n, i) => n + i.count, 0);
const has = (name) => count((n) => n === name) > 0;
const logIds = Object.values(reg.blocksByName).filter((b) => isLog(b.name)).map((b) => b.id);

/** Rejects after `ms` and runs `cancel`; pathfinding and digging can otherwise wait forever. */
async function within(ms, label, promise, cancel) {
  const expired = Promise.withResolvers();
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

const goto = (goal, ms = 45_000) => within(ms, "pathfinding", bot.pathfinder.goto(goal), () => bot.pathfinder.stop());

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
      log(`could not reach drop at ${p}: ${err.message}`);
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

async function collect(blockIds, enough, label, radius = 48) {
  let failures = 0;
  const skipped = new Set();
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
      const block = bot.blockAt(target);
      // Hold the best tool for every block; a stone block dug by hand drops nothing.
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool) await bot.equip(tool, "hand");
      if (!block.canHarvest(bot.heldItem?.type ?? null)) throw new Error(`cannot harvest ${block.name} with ${bot.heldItem?.name ?? "an empty hand"}`);
      await within(20_000, "digging", bot.dig(block), () => bot.stopDigging());
      await pickUpDrops();
      log(`${label}: dug ${block.name} at ${target}`);
    } catch (err) {
      skipped.add(target.toString());
      if (++failures > 12) throw new Error(`gave up collecting ${label}: ${err.message}`);
      log(`skipping ${label} at ${target}: ${err.message}`);
    }
  }
}

async function craft(name, times = 1, table = null) {
  const recipe = bot.recipesFor(reg.itemsByName[name].id, null, 1, table)[0];
  if (!recipe) {
    const inv = bot.inventory.items().map((i) => `${i.name} x${i.count}`).join(", ");
    throw new Error(`no recipe for ${name} with the current inventory (${inv}; table: ${table ? table.position : "none"})`);
  }
  await bot.craft(recipe, times, table);
  log(`crafted ${name}`);
}

/** Places a `name` block (crafting_table, furnace, chest) from the inventory on open ground near the player, or finds one within 4 blocks. */
async function placeNear(name) {
  const nearby = bot.findBlock({ matching: reg.blocksByName[name].id, maxDistance: 4 });
  if (nearby) return nearby;
  await bot.equip(reg.itemsByName[name].id, "hand");
  const base = bot.entity.position.floored();
  const free = (b) => b?.boundingBox === "empty" && !/water|lava/.test(b.name);
  const spots = [];
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
      return bot.blockAt(spot);
    } catch (err) {
      log(`placing ${name} at ${spot} failed: ${err.message}`);
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

const K = typeof kit === "undefined" ? null : kit;
const isPlanks = (name) => name.endsWith("_planks");
const blockIds = (names) => names.map((n) => reg.blocksByName[n].id);

/** Walks next to the nearest block of `name` that the inventory placed earlier, or places one when there is none within 4 blocks. */
async function nearBlock(name) {
  const near = bot.findBlock({ matching: reg.blocksByName[name].id, maxDistance: 4 });
  if (near) return near;
  const known = bot.findBlock({ matching: reg.blocksByName[name].id, maxDistance: 64 });
  if (!known) return null;
  // Coming back from the ore can be a long walk uphill.
  for (let attempt = 1; ; attempt++) {
    try {
      await goto(new goals.GoalNear(known.position.x, known.position.y, known.position.z, 2), 120_000);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      log(`walking to the ${name}: ${err.message}; trying again`);
    }
  }
  return bot.blockAt(known.position);
}

/**
 * Collects `n` logs of one species: planks of two species do not mix in a recipe, so the tools and the chest
 * are crafted from one. Returns the species, e.g. "oak_log".
 */
async function collectLogs(n) {
  let nearest = bot.findBlock({ matching: logIds, maxDistance: 64 });
  while (!nearest) {
    await explore();
    nearest = bot.findBlock({ matching: logIds, maxDistance: 64 });
  }
  const species = nearest.name;
  const before = count((name) => name === species);
  if (K) {
    if (n > before) await K.gatherer.gather({ blocks: species, count: n - before });
  } else await collect(blockIds([species]), () => count((name) => name === species) >= n, species);
  return species;
}

/** Crafts planks from `species` logs until the inventory holds `n` planks. */
async function planksFrom(species, n) {
  const planks = species.replace(/_log$/, "_planks");
  while (count(isPlanks) < n) await craft(planks, 1);
}

/** Digs the named blocks until the inventory holds `n` of `item`. */
async function mine(blocks, item, n, radius = 48) {
  const have = () => count((name) => name === item);
  if (!K) return collect(blockIds(blocks), () => have() >= n, item, radius);
  // gather counts blocks dug, and a drop can stay behind, so ask again for what is missing.
  for (let attempt = 0; attempt < 4 && have() < n; attempt++) {
    try {
      await K.gatherer.gather({ blocks, count: n - have(), radius });
    } catch (err) {
      log(`gather ${item}: ${err.message}`);
      await sleep(1000);
    }
  }
  if (have() < n) throw new Error(`mined ${have()} of ${n} ${item}`);
}

/** Where the oracle placed its crafting table, so that it can come back from wherever the ore was. */
let tableSpot = null;

/** The crafting table of the oracle's work: a table within reach, placed from the inventory if need be. */
async function tableNearby() {
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
async function woodenPickaxe(species) {
  if (K) {
    // Place the table before making the pickaxe: make() otherwise crafts a table from the planks that the pickaxe needs.
    if (!(await nearBlock("crafting_table"))) {
      await K.crafter.make({ item: "crafting_table" });
      tableSpot = (await placeNear("crafting_table")).position;
    }
    await K.crafter.make({ item: "wooden_pickaxe" });
    return;
  }
  await planksFrom(species, 9);
  await craft("stick", 2);
  const table = await tableNearby();
  await craft("wooden_pickaxe", 1, table);
}

async function stonePickaxe() {
  if (K) {
    await K.crafter.make({ item: "stone_pickaxe" });
    return;
  }
  await craft("stone_pickaxe", 1, await tableNearby());
}

/** Whether an item name matches a `*` glob such as `*_log`. */
const globMatch = (glob) => {
  const re = new RegExp(`^${glob.replace(/\*/g, ".*")}$`);
  return (name) => re.test(name);
};

/** Takes every item that matches the glob out of the chest block into the inventory. */
async function withdrawAll(chestBlock, glob) {
  if (K) {
    await K.container.withdraw({ at: chestBlock.position, items: glob });
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
async function depositSome(chestBlock, glob, n) {
  if (K) {
    const { total } = await K.container.deposit({ at: chestBlock.position, items: glob, count: n });
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
async function smelt(furnaceBlock, input, n) {
  const fuel = bot.inventory.items().find((i) => i.name === "coal" || i.name === "charcoal") ?? bot.inventory.items().find((i) => isLog(i.name));
  if (!fuel) throw new Error("no fuel for the furnace");
  const fuelItems = fuel.name === "coal" || fuel.name === "charcoal" ? 1 : Math.min(fuel.count, Math.ceil((n * 10) / 15) + 1);
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    await furnace.putFuel(fuel.type, null, fuelItems);
    await furnace.putInput(reg.itemsByName[input].id, null, n);
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
  if (K) {
    // Back to the table, on the surface: make() places a furnace on open ground near where it stands, and the ore was underground.
    await tableNearby();
    // Smelts the raw iron at a furnace that it crafts from the cobblestone and places, then crafts the pickaxe.
    // A busy server can leave a placement unanswered; the next attempt starts from the table again.
    for (let attempt = 1; ; attempt++) {
      try {
        await K.crafter.make({ item: "iron_pickaxe" });
        return;
      } catch (err) {
        if (attempt === 3) throw err;
        log(`iron_pickaxe attempt ${attempt}: ${err.message}`);
        await sleep(5000);
        await tableNearby();
      }
    }
  }
  const table = await tableNearby();
  await craft("furnace", 1, table);
  const furnace = await placeNear("furnace");
  await smelt(furnace, "raw_iron", 3);
  await craft("iron_pickaxe", 1, await tableNearby());
}

// ---- shelter: a one-block shaft three deep with a block over it. The shell then waits for the nights. ----

/** Blocks that a bare hand digs fast and that never fall or flow. */
const SOFT = new Set(["grass_block", "dirt", "coarse_dirt", "podzol", "rooted_dirt", "mycelium", "farmland", "dirt_path"]);

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * A column near the player where the three blocks below the feet are soft ground, solid dry ground lies under them,
 * and all four sides of the three blocks are solid: a shaft that has no cave, water, or lava beside it.
 */
function shaftSite() {
  const base = bot.entity.position.floored();
  const sites = [];
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const feet = base.offset(dx, dy, dz);
        if (bot.blockAt(feet)?.boundingBox !== "empty") continue;
        if (![1, 2, 3].every((d) => SOFT.has(bot.blockAt(feet.offset(0, -d, 0))?.name))) continue;
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
    const below = bot.blockAt(here.floored().offset(0, -1, 0));
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
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
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
async function placeChest(species) {
  if (K) await K.crafter.make({ item: "chest" });
  else {
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
  if (K) await K.crafter.make({ item: "crafting_table" });
  else await planksFrom(species, 12);
  await tableNearby();
  const chest = await placeChest(species);
  await depositSome(chest, "*_log", STASH_LOGS);
  const { x, y, z } = chest.position;
  // The next session knows what the notes say and nothing else. In a kits tier the place memory holds it too.
  notes.set("stash", `The chest with ${STASH_LOGS} logs for the stone pickaxe is at x=${x} y=${y} z=${z} (overworld). Take the logs out and craft the tools.`);
  if (K) await K.explorer.remember({ name: "stash", at: [x, y, z], kind: "chest", contents: { [species]: STASH_LOGS }, note: "logs for the stone pickaxe" });
  // Walk away along one heading, a leg at a time, until the chest is far behind and outside the loaded chunks.
  const angle = Math.random() * 2 * Math.PI;
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
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
  let spot = null;
  if (K) {
    const [place] = await K.explorer.places({ kind: "chest" });
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

if (TARGET === "iron_pickaxe") await ironPickaxe();
else if (TARGET === "shelter") await shelter();
else if (TARGET === "stock_chest") await stockChest();
else if (TARGET === "stash_chest") await stashChest();
else if (TARGET === "retrieve_logs") await retrieveLogs();
else {
  await collect(logIds, () => count(isLog) >= LOG_GOAL, "logs");
  if (TARGET !== "logs") {
    const table = await woodenTools();
    if (TARGET === "stone_pickaxe") {
      const stoneIds = ["stone", "cobblestone"].map((n) => reg.blocksByName[n].id);
      await collect(stoneIds, () => count((n) => n === "cobblestone") >= 3, "cobblestone");
      let near = bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 4 });
      if (!near) {
        await goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2));
        near = bot.blockAt(table.position);
      }
      await craft("stone_pickaxe", 1, near);
    }
  }
}
return bot.inventory.items().map((i) => `${i.name} x${i.count}`);
