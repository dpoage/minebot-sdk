// The fake bot: the slice of Mineflayer that routines' decision logic leans on, over the harness
// world and inventory. Scope is decisions, not physics: digging is instant (the clock advances by
// the dig time), pathfinding teleports to the nearest spot that satisfies the goal, items fall
// straight down. Anything outside the slice throws `not supported by minebot-sdk/testing`.
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Recipe } from "prismarine-recipe";
import { Vec3 } from "vec3";
import { emptyFurnace, type FurnaceState, furnaceWindow, tickFurnace } from "./furnace.ts";
import { Inventory } from "./inventory.ts";
import { strict } from "./strict.ts";
import { universe } from "./universe.ts";
import { type At, type BlockSpec, type FindOptions, type Ground, vec, World } from "./world.ts";

/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const EYE_HEIGHT = 1.62;
const PICKUP_RADIUS = 1.25;
/** How far from the goal the pathfinder looks for somewhere to stand. */
const MAX_STAND_RADIUS = 12;
/** How far a GoalInvert search walks from the bot: a goal such as "16 blocks away from here" needs room. */
const MAX_INVERT_RADIUS = 64;
/** Ripe crops the registry's drop lists leave without their crop item: block name to the age that is ripe and what it yields. */
const RIPE_CROPS: Record<string, { age: number; item: string }> = { wheat: { age: 7, item: "wheat" }, beetroots: { age: 3, item: "beetroot" } };
const REPLACEABLE = /^(?:air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|snow)$/;
const FURNACE_BLOCKS = /^(?:furnace|blast_furnace|smoker)$/;

/** A creature, player, or dropped item to place in the world. */
export interface EntitySpec {
  /** The registry entity name: `cow`, `zombie`, `player`, or `item` for a dropped item. */
  name: string;
  at: At;
  /** A player's name. */
  username?: string;
  /** A dropped item's name (`oak_log`), with `count`. Required when `name` is `item`. */
  item?: string;
  count?: number;
  /** An ageable animal that is a baby. */
  baby?: boolean;
  health?: number;
  id?: number;
}

export type EquipmentSlot = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

export interface FakeBotOptions {
  blocks: readonly BlockSpec[];
  ground: Ground | null;
  inventory: Readonly<Record<string, number>>;
  equipment: Readonly<Partial<Record<EquipmentSlot, string>>>;
  entities: readonly EntitySpec[];
  position: At;
  /** Ticks since dawn, 0 to 23999. */
  time: number;
  health: number;
  food: number;
  username: string;
  /** Game ticks between `bot.craft` resolving and the crafted item reaching the inventory: the table window's result arriving late, as on a laggy server. 0 is at once. */
  craftResultDelay: number;
}

/** The goal shape the pathfinder's goals share. */
interface GoalLike {
  isEnd(node: Vec3): boolean;
  [member: string]: unknown;
}

interface FurnaceEntry {
  pos: Vec3;
  state: FurnaceState;
  lit: boolean;
}

/** What the harness keeps beside the bot, for tests to read and drive. */
export interface BotHandle {
  bot: Bot;
  world: World;
  inventory: Inventory;
  /** Everything the bot said with `bot.chat`. */
  chat: string[];
  /** Passes game ticks: the clock moves and furnaces cook. */
  advance(ticks: number): void;
  /** Places a creature, player, or dropped item; returns it. */
  spawn(spec: EntitySpec): Entity;
  /** The entities in the world except the bot itself. */
  others(): Entity[];
  /** One furnace's contents, for assertions. */
  furnaceAt(at: At): FurnaceState | undefined;
}

const keyOf = (pos: Vec3) => `${pos.x},${pos.y},${pos.z}`;

export function createFakeBot(options: FakeBotOptions): BotHandle {
  const { registry, Block, Item, Entity, Recipe } = universe();
  const world = new World(Block, registry, options.ground);
  world.apply(options.blocks);
  const inventory = new Inventory(Item, registry);
  const itemName = (type: number) => registry.items[type]?.name ?? `#${type}`;
  const stackSize = (name: string) => registry.itemsByName[name]?.stackSize ?? 64;

  for (const [name, count] of Object.entries(options.inventory)) {
    if (inventory.add(inventory.make(name, 1).type, count) > 0) throw new Error(`the starting inventory does not fit ${count} ${name}`);
  }
  for (const [slot, name] of Object.entries(options.equipment) as [EquipmentSlot, string][]) {
    const stack = inventory.items().find((item) => item.name === name);
    if (!stack) throw new Error(`equipment ${slot}: the starting inventory holds no ${name}`);
    inventory.equip(stack, slot);
  }

  const events = new EventEmitter();
  const client = Object.assign(new EventEmitter(), {
    write: () => {
      throw new Error("not supported by minebot-sdk/testing: bot._client.write");
    },
  });
  const chat: string[] = [];
  const entities: Record<number, Entity> = {};
  const furnaces = new Map<string, FurnaceEntry>();
  let nextEntityId = 2;
  /** Crafted items on their way to the inventory: the clock age they arrive at. */
  const arriving: { due: number; type: number; count: number }[] = [];
  let nextWindowId = 1;

  const self = new Entity(1);
  Object.assign(self, { type: "player", name: "player", kind: "Player", username: options.username, height: 1.8, width: 0.6, isValid: true });
  self.position = vec(options.position);
  entities[1] = self;

  const time = {
    timeOfDay: options.time,
    age: options.time,
    get day() {
      return Math.floor(this.age / 24000);
    },
    doDaylightCycle: true,
    get isDay() {
      return this.timeOfDay < 13000;
    },
  };

  /** Where the bot's feet are, as a block position. */
  const feet = () => self.position.floored();
  const eyeDistance = (pos: Vec3) => self.position.offset(0, EYE_HEIGHT, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
  const requireReach = (block: Block) => {
    const distance = eyeDistance(block.position);
    if (distance > REACH) throw new Error(`${block.name} at ${block.position} is out of reach (${distance.toFixed(1)} blocks; the limit is ${REACH})`);
  };

  // Entities.
  function spawn(spec: EntitySpec): Entity {
    const def = registry.entitiesByName[spec.name];
    if (!def) throw new Error(`unknown entity "${spec.name}"`);
    if (spec.name === "item" && spec.item === undefined) throw new Error(`an item entity needs \`item\`, the item it holds`);
    const entity = new Entity(spec.id ?? nextEntityId++);
    Object.assign(entity, {
      name: spec.name,
      type: def.type ?? "other",
      kind: def.category,
      displayName: def.displayName,
      height: def.height ?? 1,
      width: def.width ?? 0.6,
      isValid: true,
      ...(spec.username !== undefined && { username: spec.username }),
      ...(spec.health !== undefined && { health: spec.health }),
    });
    entity.position = vec(spec.at);
    if (spec.baby) {
      const metadata: unknown[] = entity.metadata;
      metadata[16] = true;
    }
    if (spec.item !== undefined) {
      const stack = inventory.make(spec.item, spec.count ?? 1);
      Object.assign(entity, { getDroppedItem: () => stack });
    }
    entities[entity.id] = entity;
    if (spec.username !== undefined) players[spec.username] = { username: spec.username, entity, ping: 0 };
    return entity;
  }

  const players: Record<string, { username: string; entity: Entity; ping: number }> = { [options.username]: { username: options.username, entity: self, ping: 0 } };

  /** Drops an item stack at `at`, falling straight down onto the first solid block. */
  function dropItem(item: string, count: number, at: Vec3): void {
    const pos = at.floored();
    while (pos.y > -64 && world.blockAt(pos.offset(0, -1, 0)).boundingBox !== "block") pos.y -= 1;
    spawn({ name: "item", item, count, at: new Vec3(pos.x + 0.5, pos.y + 0.25, pos.z + 0.5) });
  }

  /** Item entities within reach of the bot's feet go into the inventory, as far as they fit. */
  function pickUp(): void {
    for (const entity of Object.values(entities)) {
      const dropped = (entity as Entity & { getDroppedItem?: () => Item }).getDroppedItem?.();
      if (!dropped || !entity.isValid) continue;
      const dx = entity.position.x - self.position.x;
      const dz = entity.position.z - self.position.z;
      const dy = entity.position.y - self.position.y;
      if (Math.hypot(dx, dz) > PICKUP_RADIUS || dy < -1 || dy > 2) continue;
      const left = inventory.add(dropped.type, dropped.count);
      if (left === 0) {
        entity.isValid = false;
        delete entities[entity.id];
        events.emit("entityGone", entity);
      } else dropped.count = left;
    }
  }

  for (const spec of options.entities) spawn(spec);

  /** The items a harvested block drops: the registry's list without its `air` placeholders, plus what it leaves out (a ripe crop's crop item, a bed's head). */
  function dropsOf(block: Block): string[] {
    const names = (registry.blocks[block.type]?.drops ?? []).map(itemName).filter((name) => name !== "air");
    const properties = block.getProperties();
    const ripe = RIPE_CROPS[block.name];
    if (ripe && Number(properties.age) === ripe.age) names.push(ripe.item);
    if (block.name.endsWith("_bed") && properties.part === "head") names.push(block.name);
    return names;
  }

  /** True when the entity's box overlaps the block cell at `cell`. */
  function occupies(entity: Entity, cell: Vec3): boolean {
    return (
      Math.abs(entity.position.x - (cell.x + 0.5)) < entity.width / 2 + 0.5 &&
      Math.abs(entity.position.z - (cell.z + 0.5)) < entity.width / 2 + 0.5 &&
      entity.position.y < cell.y + 1 &&
      entity.position.y + entity.height > cell.y
    );
  }

  // Pathfinding: the nearest standable spot that satisfies the goal.
  const standable = (pos: Vec3) =>
    world.blockAt(pos).boundingBox !== "block" && world.blockAt(pos.offset(0, 1, 0)).boundingBox !== "block" && world.blockAt(pos.offset(0, -1, 0)).boundingBox === "block";

  function goalHint(goal: GoalLike): Vec3 | null {
    const { x, y, z } = goal as { x?: unknown; y?: unknown; z?: unknown };
    if (typeof x === "number" && typeof z === "number") return new Vec3(x, typeof y === "number" ? y : self.position.y, z);
    if (typeof y === "number") return new Vec3(self.position.x, y, self.position.z);
    const entity = goal.entity as { position?: Vec3 } | undefined;
    if (entity?.position) return entity.position;
    if (goal.goal) return goalHint(goal.goal as GoalLike);
    const parts = goal.goals as GoalLike[] | undefined;
    return parts?.[0] ? goalHint(parts[0]) : null;
  }

  function walkTo(goal: GoalLike): void {
    if (typeof goal?.isEnd !== "function") throw new Error(`not supported by minebot-sdk/testing: pathfinder goal ${String((goal as object)?.constructor?.name)}`);
    if (goal.isEnd(feet())) return;
    // A GoalInvert holds anywhere far enough from its inner goal, so its search grows from the
    // bot's feet and stays near the ground, not from the inner goal's position.
    const inverted = goal.constructor.name === "GoalInvert";
    const hint = inverted ? feet() : goalHint(goal);
    if (!hint) throw new Error(`not supported by minebot-sdk/testing: pathfinder goal ${goal.constructor.name}`);
    const center = hint.floored();
    const maxRadius = inverted ? MAX_INVERT_RADIUS : MAX_STAND_RADIUS;
    for (let radius = 0; radius <= maxRadius; radius++) {
      const height = inverted ? Math.min(radius, 3) : radius;
      let best: Vec3 | null = null;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -height; dy <= height; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== radius) continue;
            const cell = center.offset(dx, dy, dz);
            if (!standable(cell) || !goal.isEnd(cell)) continue;
            if (!best || cell.distanceTo(self.position) < best.distanceTo(self.position)) best = cell;
          }
        }
      }
      if (best) {
        self.position = best.offset(0.5, 0, 0.5);
        events.emit("move", self.position);
        pickUp();
        return;
      }
    }
    throw new Error("No path to the goal!");
  }

  const pathfinder = {
    goal: null as GoalLike | null,
    movements: undefined as unknown,
    setMovements(movements: unknown) {
      pathfinder.movements = movements;
    },
    async goto(goal: GoalLike) {
      walkTo(goal);
      events.emit("goal_reached", goal);
    },
    /** Like the plugin: returns at once, and `goal_reached` arrives on a later turn, so `setGoal(g); await once(bot, "goal_reached")` works. A reached goal that is not dynamic is dropped. */
    setGoal(goal: GoalLike | null) {
      pathfinder.goal = goal;
      if (!goal) return;
      try {
        walkTo(goal);
      } catch {
        setImmediate(() => events.emit("path_update", { status: "noPath" }));
        return;
      }
      if (!goal.dynamic) pathfinder.goal = null;
      setImmediate(() => events.emit("goal_reached", goal));
    },
    stop() {
      pathfinder.goal = null;
    },
    isMoving: () => false,
    isMining: () => false,
    isBuilding: () => false,
    /** The inventory item that digs `block` fastest, as the pathfinder plugin picks it. */
    bestHarvestTool(block: Block): Item | null {
      let fastest = Number.MAX_VALUE;
      let best: Item | null = null;
      for (const tool of inventory.items()) {
        const digTime = block.digTime(tool.type, false, false, false, [], self.effects);
        if (digTime < fastest) {
          fastest = digTime;
          best = tool;
        }
      }
      return best;
    },
  };

  // Furnaces.
  function litBlock(entry: FurnaceEntry, lit: boolean): void {
    const block = world.blockAt(entry.pos);
    entry.lit = lit;
    world.setBlock(entry.pos, block.name, { ...block.getProperties(), lit });
  }

  /** Crafted items whose time has come go into the inventory; one that does not fit drops at the bot's feet, as the game does. */
  function deliverArrivals(): void {
    for (const result of arriving.splice(0)) {
      if (result.due > time.age) {
        arriving.push(result);
        continue;
      }
      const left = inventory.add(result.type, result.count);
      if (left > 0) dropItem(itemName(result.type), left, self.position);
    }
  }

  function advance(ticks: number): void {
    time.age += ticks;
    time.timeOfDay = (time.timeOfDay + ticks) % 24000;
    deliverArrivals();
    for (const entry of furnaces.values()) {
      const { state } = entry;
      const active = state.input !== null || state.burnLeft > 0;
      for (let tick = 0; tick < ticks && (state.input !== null || state.burnLeft > 0 || state.cooked > 0); tick++) tickFurnace(state, stackSize);
      const lit = state.burnLeft > 0;
      if (active && lit !== entry.lit) litBlock(entry, lit);
      if (lit) {
        for (const [windowId, update] of state.windows) {
          client.emit("craft_progress_bar", { windowId, property: 0, value: state.burnLeft });
          update();
        }
      }
    }
  }

  function furnaceEntry(block: Block): FurnaceEntry {
    let entry = furnaces.get(keyOf(block.position));
    if (!entry) {
      entry = { pos: block.position.clone(), state: emptyFurnace(), lit: false };
      furnaces.set(keyOf(block.position), entry);
    }
    return entry;
  }

  // Recipes, as Mineflayer's craft plugin answers them.
  const requirementsMet = (recipe: Recipe, minResultCount: number, craftingTable: unknown) => {
    if (recipe.requiresTable && !craftingTable) return false;
    const times = Math.ceil(minResultCount / recipe.result.count);
    return recipe.delta.every((d) => inventory.count(d.id) + d.count * times >= 0);
  };

  const bot = Object.assign(events, {
    registry,
    version: "26.1",
    username: options.username,
    entity: self,
    entities,
    players,
    time,
    game: { dimension: "overworld", gameMode: "survival", difficulty: "normal", minY: -64, height: 384 },
    health: options.health,
    food: options.food,
    foodSaturation: 5,
    oxygenLevel: 20,
    isSleeping: false,
    isRaining: false,
    thunderState: 0,
    controlState: {} as Record<string, boolean>,
    currentWindow: null,
    targetDigBlock: null,
    usingHeldItem: false,
    isAlive: true,
    inventory: strict("bot.inventory", inventory),
    world: strict("bot.world", {}),
    pathfinder: strict("bot.pathfinder", pathfinder),
    _client: strict("bot._client", client),

    blockAt: (pos: Vec3) => world.blockAt(pos),
    findBlocks: (opts: FindOptions) => world.findBlocks({ ...opts, point: opts.point ?? self.position }),
    findBlock(opts: FindOptions) {
      const [pos] = bot.findBlocks({ ...opts, count: 1 });
      return pos ? world.blockAt(pos) : null;
    },
    isABed: (block: Block) => block.name.endsWith("_bed"),

    async equip(item: Item | number, destination: EquipmentSlot | null = "hand") {
      const stack = typeof item === "number" ? inventory.items().find((i) => i.type === item) : item;
      if (!stack || !inventory.slots.includes(stack)) throw new Error(`the item to equip is not in the inventory`);
      inventory.equip(stack, destination ?? "hand");
    },
    getEquipmentDestSlot: (destination: string) => inventory.destSlot(destination),
    async toss(type: number, _metadata: number | null, count: number | null) {
      const have = inventory.count(type);
      // As in Mineflayer, a null count is one item.
      const n = count ?? 1;
      if (have < n || n <= 0) throw new Error(`cannot toss ${n} ${itemName(type)}: the inventory holds ${have}`);
      inventory.remove(type, n);
      const ahead = new Vec3(-Math.sin(self.yaw) * 2, 0, -Math.cos(self.yaw) * 2);
      dropItem(itemName(type), n, self.position.plus(ahead).offset(0, 1, 0));
    },
    async consume() {
      const held = inventory.held;
      const food = held && registry.foodsByName[held.name];
      if (!held || !food) throw new Error("the held item is not food");
      if (bot.food >= 20) throw new Error("the food bar is full");
      inventory.remove(held.type, 1);
      bot.food = Math.min(20, bot.food + food.foodPoints);
      bot.foodSaturation = Math.min(bot.food, bot.foodSaturation + food.saturation);
    },

    recipesFor: (type: number, _metadata: number | null, minResultCount: number | null, craftingTable: unknown) =>
      Recipe.find(type, null).filter((recipe) => requirementsMet(recipe, minResultCount ?? 1, craftingTable)),
    recipesAll: (type: number, _metadata: number | null, craftingTable: unknown) => Recipe.find(type, null).filter((recipe) => !recipe.requiresTable || craftingTable),
    async craft(recipe: Recipe, count: number | null, craftingTable?: Block) {
      if (recipe.requiresTable && !craftingTable) throw new Error(`Recipe requires craftingTable, but one was not supplied: ${JSON.stringify(recipe)}`);
      if (craftingTable && craftingTable.name !== "crafting_table") throw new Error(`crafting: non craftingTable used as craftingTable: ${craftingTable.name}`);
      // Out of reach the server ignores the click, no window opens, and Mineflayer waits for it forever.
      if (craftingTable) requireReach(world.blockAt(craftingTable.position));
      for (let i = 0; i < (count ?? 1); i++) {
        if (!recipe.delta.every((d) => inventory.count(d.id) + d.count >= 0)) throw new Error("missing ingredient");
        for (const d of recipe.delta) if (d.count < 0) inventory.remove(d.id, -d.count);
        for (const d of recipe.delta) {
          if (d.count <= 0) continue;
          if (options.craftResultDelay > 0) arriving.push({ due: time.age + options.craftResultDelay, type: d.id, count: d.count });
          else if (inventory.add(d.id, d.count) > 0) throw new Error("the inventory is full");
        }
      }
    },

    async dig(block: Block, _forceLook?: unknown) {
      const here = world.blockAt(block.position);
      if (here.name !== block.name) throw new Error(`the block at ${block.position} is ${here.name}, not ${block.name}`);
      if (!here.diggable) throw new Error(`${here.name} at ${here.position} cannot be dug`);
      requireReach(here);
      const held = inventory.held;
      advance(Math.ceil(here.digTime(held?.type ?? null, false, false, false, [], self.effects) / 50));
      world.setBlock(here.position, "air");
      if (here.canHarvest(held?.type ?? null)) {
        for (const drop of dropsOf(here)) dropItem(drop, 1, here.position.offset(0.5, 0.5, 0.5));
      }
      events.emit("diggingCompleted", here);
      pickUp();
    },
    stopDigging() {},
    async placeBlock(reference: Block, face: Vec3) {
      const against = world.blockAt(reference.position);
      if (against.boundingBox !== "block") throw new Error(`cannot place against ${against.name} at ${against.position}`);
      requireReach(against);
      const held = inventory.held;
      if (!held) throw new Error("must be holding an item to place a block");
      if (!registry.blocksByName[held.name]) throw new Error(`${held.name} is not a block`);
      const target = against.position.plus(face);
      const current = world.blockAt(target);
      if (!REPLACEABLE.test(current.name)) throw new Error(`cannot place ${held.name} at ${target}: ${current.name} is there`);
      const occupant = Object.values(entities).find((e) => e.name !== "item" && e.isValid !== false && occupies(e, target));
      if (occupant) throw new Error(`cannot place ${held.name} at ${target}: ${occupant.name ?? "an entity"} stands there`);
      inventory.remove(held.type, 1);
      const placed = world.setBlock(target, held.name, FURNACE_BLOCKS.test(held.name) ? { lit: false } : {});
      events.emit("blockPlaced", current, placed);
    },
    async openFurnace(block: Block) {
      if (!FURNACE_BLOCKS.test(block.name)) throw new Error(`${block.name} is not a furnace`);
      requireReach(world.blockAt(block.position));
      const entry = furnaceEntry(block);
      return furnaceWindow({
        id: nextWindowId++,
        state: entry.state,
        inventory,
        makeItem: (name, count) => inventory.make(name, count),
        stackSize,
        itemName,
        onClose: () => {},
      });
    },

    async lookAt(_point: Vec3, _force?: boolean) {},
    setControlState(control: string, state: boolean) {
      bot.controlState[control] = state;
    },
    clearControlStates() {
      bot.controlState = {};
    },
    chat(message: string) {
      chat.push(message);
    },
    async waitForTicks(ticks: number) {
      advance(ticks);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });

  // Object.assign would read the getters once and keep their values.
  Object.defineProperty(bot, "heldItem", { enumerable: true, get: () => inventory.held });
  Object.defineProperty(bot, "quickBarSlot", { enumerable: true, get: () => inventory.quickBarSlot });

  return {
    bot: strict("bot", bot) as unknown as Bot,
    world,
    inventory,
    chat,
    advance,
    spawn,
    others: () => Object.values(entities).filter((entity) => entity !== self),
    furnaceAt: (at) => furnaces.get(keyOf(vec(at).floor()))?.state,
  };
}
