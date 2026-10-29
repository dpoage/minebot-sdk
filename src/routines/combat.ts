// The combat routines: hitting creatures, fighting hostiles until none are left, backing away.
// Attacks use the pathfinder to close in and the held weapon's cooldown to pace each hit.
import { defineRoutine, type Entity, goals, isHostile, Movements, nameMatcher, NamePattern, Point, Position, type RoutineContext, toVec3, Vec3, within, z } from "minebot-sdk/routine";

export const description = "Attack creatures with the best weapon, fight hostiles until none are near, and back away.";
export const uses = [] as const;

// The server accepts melee hits within 3 blocks of the target's hitbox; aim from the eyes to its middle.
const REACH = 3;
const TICK_MS = 50;
// A target that is not dead after this long is skipped: it may be out of reach (across water, in a wall).
const TARGET_TIMEOUT_MS = 20_000;
const DEFAULT_RADIUS = 16;
const DEFAULT_RETREAT_DISTANCE = 16;
const RETREAT_TIMEOUT_MS = 20_000;
// How long after a kill to wait for the pieces a slime or magma cube splits into.
const SPLIT_WAIT_MS = 1200;
// An attack that gives up after the target has covered this many blocks in the last 5 seconds lost a race.
const OUTRUN_WINDOW_MS = 5_000;
const OUTRUN_BLOCKS = 6;

/** A distance at one decimal place, as the give-up reasons report it. */
function blocks(distance: number): number {
  return Math.round(distance * 10) / 10;
}

/** How an engage ended: killed, or the one line that tells the agent why it gave up and what to do next. */
type Engaged = { killed: true } | { killed: false; reason: string };

// Attack damage by tool material. The registry has no damage values.
const SWORD_DAMAGE: Record<string, number> = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 };
const AXE_DAMAGE: Record<string, number> = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 };
// Attack speed (hits per second) of axes by material; swords all hit at 1.6 per second.
const AXE_SPEED: Record<string, number> = { wooden: 0.8, stone: 0.8, copper: 0.8, iron: 0.9, golden: 1, diamond: 1, netherite: 1 };
const SWORD_COOLDOWN_MS = 625;
const FIST_COOLDOWN_MS = 500;

/** Which weapon material a tool name carries: `iron_sword` is `iron`. Null for names that are not `<material>_<kind>`. */
function material(name: string, kind: "sword" | "axe"): string | null {
  const match = new RegExp(`^(\\w+)_${kind}$`).exec(name.replace(/^minecraft:/, ""));
  return match?.[1] ?? null;
}

/** How good an item is as a weapon: swords by damage, always above axes, axes by damage. Null when it is no weapon. */
export function weaponScore(item: string): number | null {
  const sword = material(item, "sword");
  if (sword && sword in SWORD_DAMAGE) return 100 + SWORD_DAMAGE[sword]!;
  const axe = material(item, "axe");
  if (axe && axe in AXE_DAMAGE) return AXE_DAMAGE[axe]!;
  return null;
}

/** The best weapon among `names`, or null when none is a weapon. */
export function bestWeapon(names: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const name of names) {
    const score = weaponScore(name);
    if (score !== null && score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

/** Milliseconds between full-strength hits with `item` held (null for bare hands). */
export function attackCooldownMs(item: string | null): number {
  if (!item) return FIST_COOLDOWN_MS;
  if (material(item, "sword")) return SWORD_COOLDOWN_MS;
  const axe = material(item, "axe");
  if (axe && axe in AXE_SPEED) return Math.round(1000 / AXE_SPEED[axe]!);
  return FIST_COOLDOWN_MS;
}

function eyeDistance(ctx: RoutineContext, entity: Entity): number {
  return ctx.bot.entity.position.offset(0, ctx.bot.entity.height * 0.9, 0).distanceTo(entity.position.offset(0, entity.height / 2, 0));
}

/** Entities, nearest first, that pass `accept` within `radius` blocks of the player. */
function nearby(ctx: RoutineContext, accept: (e: Entity) => boolean, radius: number): Entity[] {
  const here = ctx.bot.entity.position;
  return Object.values(ctx.bot.entities)
    .filter((e) => e !== ctx.bot.entity && e.isValid !== false && accept(e) && e.position.distanceTo(here) <= radius)
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
}

/** An entity by id, or the nearest one whose name (or player username) matches `target`. */
function findEntity(ctx: RoutineContext, target: number | string): Entity | undefined {
  if (typeof target === "number") return ctx.bot.entities[target];
  const matches = nameMatcher(target);
  return nearby(ctx, (e) => matches(e.name ?? "") || matches(e.username ?? ""), Infinity)[0];
}

/** Counts what a fight costs and wins while it runs. */
interface Fight {
  kills: number;
  damage: number;
  weapon: string | null;
  dead: Set<number>;
  /** The movement rules a chase runs on: the player's own, with digging and building off; undefined for a bot with no registry (a test stub) to build them from. */
  chase: InstanceType<typeof Movements> | undefined;
  close(): void;
}

/**
 * The chase's movement rules: a copy of the player's own (exclusions, fall height, doors) with
 * digging and building switched off, so a chase never breaks a fence or leaves a block behind.
 * A target a pen or a wall keeps out then ends as the blocked reason instead.
 */
function chaseMovements(bot: RoutineContext["bot"]): InstanceType<typeof Movements> | undefined {
  if (!bot.registry) return undefined;
  const movements = new Movements(bot);
  const from = bot.pathfinder.movements;
  if (from) {
    movements.canOpenDoors = from.canOpenDoors;
    movements.maxDropDown = from.maxDropDown;
    movements.infiniteLiquidDropdownDistance = from.infiniteLiquidDropdownDistance;
    movements.dontCreateFlow = from.dontCreateFlow;
    movements.dontMineUnderFallingBlock = from.dontMineUnderFallingBlock;
    movements.allowParkour = from.allowParkour;
    movements.allowSprinting = from.allowSprinting;
    movements.exclusionAreasStep = from.exclusionAreasStep;
    movements.exclusionAreasBreak = from.exclusionAreasBreak;
    movements.exclusionAreasPlace = from.exclusionAreasPlace;
  }
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  return movements;
}

/** Equips the best weapon in the inventory and starts counting kills and damage taken. */
async function openFight(ctx: RoutineContext): Promise<Fight> {
  const { bot } = ctx;
  const stacks = bot.inventory.items();
  const name = bestWeapon(stacks.map((i) => i.name));
  if (name) await bot.equip(stacks.find((i) => i.name === name)!, "hand");
  else ctx.log("combat: no sword or axe in the inventory; fighting bare-handed");
  const normal = bot.pathfinder.movements;
  const fight: Fight = { kills: 0, damage: 0, weapon: name, dead: new Set(), chase: chaseMovements(bot), close: () => {} };
  let last = bot.health;
  const onHealth = () => {
    if (bot.health < last) fight.damage += last - bot.health;
    last = bot.health;
  };
  const onDead = (entity: Entity) => {
    fight.dead.add(entity.id);
  };
  bot.on("health", onHealth);
  bot.on("entityDead", onDead);
  fight.close = () => {
    bot.off("health", onHealth);
    bot.off("entityDead", onDead);
    try {
      bot.pathfinder.setGoal(null);
    } finally {
      // Whatever ended the fight, the pathfinder walks on the player's own movements again.
      if (bot.pathfinder.movements !== normal) bot.pathfinder.setMovements(normal);
      bot.clearControlStates();
    }
  };
  return fight;
}

/**
 * Closes in on `target` and hits it on every weapon cooldown until it dies, `deadline` passes, or the target limit does.
 * When it gives up, says why in one line, checked in this order: the target vanished; it is still in reach (out of time);
 * it outran the player; the way is blocked.
 */
async function engage(ctx: RoutineContext, fight: Fight, target: Entity, deadline: number): Promise<Engaged> {
  const { bot } = ctx;
  const give = Math.min(deadline, Date.now() + TARGET_TIMEOUT_MS);
  const cooldown = attackCooldownMs(fight.weapon);
  let nextHit = 0;
  let hits = 0;
  let closest = eyeDistance(ctx, target);
  // Where the target has been while the attack ran: the last five seconds of it say whether it outran the player.
  const trail: { at: number; position: Vec3; distance: number }[] = [];
  const sample = () => {
    const distance = eyeDistance(ctx, target);
    closest = Math.min(closest, distance);
    trail.push({ at: Date.now(), position: target.position.clone(), distance });
    while (trail.length > 2 && trail[1]!.at <= Date.now() - OUTRUN_WINDOW_MS) trail.shift();
  };
  /** The target left `bot.entities` without dying: the first category, since nothing else can be measured afterwards. */
  const gone = (): Engaged => {
    const last = trail[trail.length - 1];
    return { killed: false, reason: `the target is gone (last seen ${blocks(last?.distance ?? eyeDistance(ctx, target))} blocks away); find it again with sense.look or pick another` };
  };
  if (fight.chase !== undefined && bot.pathfinder.movements !== fight.chase) bot.pathfinder.setMovements(fight.chase);
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  while (Date.now() < give) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (bot.health <= 0) throw new Error("died while fighting");
    if (fight.dead.has(target.id)) {
      fight.kills++;
      return { killed: true };
    }
    if (!bot.entities[target.id]) return gone();
    if (eyeDistance(ctx, target) <= REACH && Date.now() >= nextHit) {
      await bot.lookAt(target.position.offset(0, target.height * 0.6, 0), true);
      bot.attack(target);
      hits++;
      nextHit = Date.now() + cooldown;
    }
    sample();
    await ctx.sleep(TICK_MS);
  }
  if (!bot.entities[target.id]) return gone();
  const now = eyeDistance(ctx, target);
  if (now <= REACH) return { killed: false, reason: `still in reach after the time ran out (hits landed: ${hits}); call again to keep hitting` };
  const since = trail.find((point) => point.at >= Date.now() - OUTRUN_WINDOW_MS) ?? trail[0];
  const moved = since && trail.length > 0 ? since.position.distanceTo(trail[trail.length - 1]!.position) : 0;
  if (moved >= OUTRUN_BLOCKS) return { killed: false, reason: `it outran you (closest ${blocks(closest)} blocks, now ${blocks(now)}); it moves faster than you follow; corner it or wait until it stops` };
  return { killed: false, reason: `could not get within reach (closest ${blocks(closest)} blocks, now ${blocks(now)}); the way is blocked: water, a wall, a fence or a drop; walk around it or pick another target` };
}

/** Fights hostiles (or the creatures matching `targets`) within `radius` of the player, nearest first, until none are left or `timeoutMs` passes. */
async function fightAll(ctx: RoutineContext, radius: number, targets: NamePattern | undefined, timeoutMs: number) {
  const matches = targets === undefined ? null : nameMatcher(targets);
  const wanted = (e: Entity) => (matches ? matches(e.name ?? "") : isHostile(e));
  const deadline = Date.now() + timeoutMs;
  const given = new Set<number>();
  const fight = await openFight(ctx);
  try {
    let settledAt = 0;
    while (Date.now() < deadline) {
      const target = nearby(ctx, (e) => wanted(e) && !given.has(e.id) && !fight.dead.has(e.id), radius)[0];
      if (!target) {
        // Slimes and magma cubes split into smaller ones when their death animation ends: look again before calling it clear.
        if (fight.kills === settledAt) break;
        settledAt = fight.kills;
        await ctx.sleep(SPLIT_WAIT_MS);
        continue;
      }
      if (!(await engage(ctx, fight, target, deadline)).killed) given.add(target.id);
    }
  } finally {
    fight.close();
  }
  const remaining = nearby(ctx, (e) => wanted(e) && !fight.dead.has(e.id), radius).length;
  return { kills: fight.kills, damageTaken: fight.damage, weapon: fight.weapon, remaining, timedOut: remaining > 0 && Date.now() >= deadline };
}

/** Walks until the player is more than `distance` blocks from `from`. Returns where it stopped and how far that is from `from`. */
async function retreatFrom(ctx: RoutineContext, from: Vec3, distance: number, timeoutMs: number) {
  const { bot } = ctx;
  const goal = new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, distance));
  try {
    await within(timeoutMs, "retreating", bot.pathfinder.goto(goal), () => bot.pathfinder.setGoal(null));
  } finally {
    bot.pathfinder.setGoal(null);
  }
  const position = bot.entity.position;
  return { position: position.floored(), distance: Math.round(position.distanceTo(from) * 10) / 10 };
}

const Target = z.union([z.number().int(), z.string().min(1)]);

export const attack = defineRoutine(
  {
    name: "combat.attack",
    description: "Hit one creature until it dies. `target` is an entity id or a name ('zombie'; the nearest match, a player's username works too). Walks up to it on movement rules that never break or place a block (a fence, a wall, or water stops the chase instead), holds the best sword or axe from the inventory, and hits once per weapon cooldown. Gives up after `timeoutMs` (default 20000). Returns { target, killed, damageTaken, weapon, reason }; when `killed` is false, `reason` is one line that names why it gave up (gone, still in reach, outran, blocked) and what to do next.",
    args: z.object({ target: Target, timeoutMs: z.number().int().positive().default(TARGET_TIMEOUT_MS) }),
    returns: z.object({ target: z.string(), killed: z.boolean(), damageTaken: z.number(), weapon: z.string().nullable(), reason: z.string().optional() }),
  },
  async (ctx, { target, timeoutMs }) => {
    const entity = findEntity(ctx, target);
    if (!entity) throw new Error(`no entity matches ${JSON.stringify(target)}`);
    const fight = await openFight(ctx);
    try {
      const engaged = await engage(ctx, fight, entity, Date.now() + timeoutMs);
      const result = { target: entity.name ?? entity.username ?? String(entity.id), killed: engaged.killed, damageTaken: fight.damage, weapon: fight.weapon };
      return engaged.killed ? result : { ...result, reason: engaged.reason };
    } finally {
      fight.close();
    }
  },
);

export const fight = defineRoutine(
  {
    name: "combat.fight",
    description: "Fight until no target is left within `radius` (default 16) or `timeoutMs` (default 60000) passes. Targets default to hostile mobs: the registry category 'Hostile mobs', which includes slimes, magma cubes, phantoms, and ghasts, minus endermen, zombified piglins, striders, and end crystals, which are no threat until provoked. `targets` ('zombie', '*_skeleton', or a list) names others, endermen included. Takes the nearest first, holds the best sword or axe from the inventory, skips a target it cannot kill in 20 seconds, and fails if the player dies. A chase never breaks or places a block. Creepers explode when close: retreat from them first. Returns { kills, damageTaken, weapon, remaining, timedOut }.",
    args: z.object({
      radius: z.number().positive().default(DEFAULT_RADIUS),
      targets: NamePattern.optional(),
      timeoutMs: z.number().int().positive().default(60_000),
    }),
    returns: z.object({ kills: z.number(), damageTaken: z.number(), weapon: z.string().nullable(), remaining: z.number(), timedOut: z.boolean() }),
  },
  (ctx, { radius, targets, timeoutMs }) => fightAll(ctx, radius, targets, timeoutMs),
);

export const retreat = defineRoutine(
  {
    name: "combat.retreat",
    description: "Walk away until more than `distance` (default 16) blocks from `from`: a position ({x,y,z} or [x,y,z]), an entity id, or a creature name. Without `from`, away from the nearest hostile mob within 32 blocks; fails when there is none. Gives up after `timeoutMs` (default 20000). Returns { position, distance } — where the player stopped and how far that is from `from`.",
    args: z.object({
      from: z.union([Position, Target]).optional(),
      distance: z.number().positive().default(DEFAULT_RETREAT_DISTANCE),
      timeoutMs: z.number().int().positive().default(RETREAT_TIMEOUT_MS),
    }),
    returns: z.object({ position: Point, distance: z.number() }),
  },
  (ctx, { from, distance, timeoutMs }) => {
    let source: Vec3 | undefined;
    if (from === undefined) source = nearby(ctx, isHostile, 32)[0]?.position.clone();
    else if (typeof from === "number" || typeof from === "string") source = findEntity(ctx, from)?.position.clone();
    else source = toVec3(from);
    if (!source) throw new Error(from === undefined ? "no hostile mob within 32 blocks to retreat from" : `no entity matches ${JSON.stringify(from)}`);
    return retreatFrom(ctx, source, distance, timeoutMs);
  },
);
