// The combat kit: hitting creatures, fighting hostiles until none are left, backing away.
// Attacks use the pathfinder to close in and the held weapon's cooldown to pace each hit.
import { action, defineKit, type Entity, goals, isHostile, type KitContext, nameMatcher, NamePattern, Point, Position, toVec3, Vec3, z } from "minebot-sdk/kit";

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

function eyeDistance(ctx: KitContext, entity: Entity): number {
  return ctx.bot.entity.position.offset(0, ctx.bot.entity.height * 0.9, 0).distanceTo(entity.position.offset(0, entity.height / 2, 0));
}

/** Entities, nearest first, that pass `accept` within `radius` blocks of the player. */
function nearby(ctx: KitContext, accept: (e: Entity) => boolean, radius: number): Entity[] {
  const here = ctx.bot.entity.position;
  return Object.values(ctx.bot.entities)
    .filter((e) => e !== ctx.bot.entity && e.isValid !== false && accept(e) && e.position.distanceTo(here) <= radius)
    .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
}

/** An entity by id, or the nearest one whose name (or player username) matches `target`. */
export function findEntity(ctx: KitContext, target: number | string): Entity | undefined {
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
  close(): void;
}

/** Equips the best weapon in the inventory and starts counting kills and damage taken. */
async function openFight(ctx: KitContext): Promise<Fight> {
  const { bot } = ctx;
  const stacks = bot.inventory.items();
  const name = bestWeapon(stacks.map((i) => i.name));
  if (name) await bot.equip(stacks.find((i) => i.name === name)!, "hand");
  else ctx.log("combat: no sword or axe in the inventory; fighting bare-handed");
  const fight: Fight = { kills: 0, damage: 0, weapon: name, dead: new Set(), close: () => {} };
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
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  };
  return fight;
}

/** Closes in on `target` and hits it on every weapon cooldown until it dies, `deadline` passes, or the target limit does. Returns true when it died. */
async function engage(ctx: KitContext, fight: Fight, target: Entity, deadline: number): Promise<boolean> {
  const { bot } = ctx;
  const give = Math.min(deadline, Date.now() + TARGET_TIMEOUT_MS);
  const cooldown = attackCooldownMs(fight.weapon);
  let nextHit = 0;
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  while (Date.now() < give) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (bot.health <= 0) throw new Error("died while fighting");
    if (fight.dead.has(target.id)) {
      fight.kills++;
      return true;
    }
    if (!bot.entities[target.id]) return false;
    if (eyeDistance(ctx, target) <= REACH && Date.now() >= nextHit) {
      await bot.lookAt(target.position.offset(0, target.height * 0.6, 0), true);
      bot.attack(target);
      nextHit = Date.now() + cooldown;
    }
    await ctx.sleep(TICK_MS);
  }
  return false;
}

/** Fights hostiles (or the creatures matching `targets`) within `radius` of the player, nearest first, until none are left or `timeoutMs` passes. */
export async function fightAll(ctx: KitContext, radius: number, targets: NamePattern | undefined, timeoutMs: number) {
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
      if (!(await engage(ctx, fight, target, deadline))) given.add(target.id);
    }
  } finally {
    fight.close();
  }
  const remaining = nearby(ctx, (e) => wanted(e) && !fight.dead.has(e.id), radius).length;
  return { kills: fight.kills, damageTaken: fight.damage, weapon: fight.weapon, remaining, timedOut: remaining > 0 && Date.now() >= deadline };
}

/** Walks until the player is more than `distance` blocks from `from`. Returns where it stopped and how far that is from `from`. */
export async function retreatFrom(ctx: KitContext, from: Vec3, distance: number, timeoutMs: number) {
  const { bot } = ctx;
  const goal = new goals.GoalInvert(new goals.GoalNear(from.x, from.y, from.z, distance));
  try {
    await ctx.within(timeoutMs, "retreating", bot.pathfinder.goto(goal), () => bot.pathfinder.setGoal(null));
  } finally {
    bot.pathfinder.setGoal(null);
  }
  const position = bot.entity.position;
  return { position: position.floored(), distance: Math.round(position.distanceTo(from) * 10) / 10 };
}

const Target = z.union([z.number().int(), z.string().min(1)]);

export const combat = defineKit(
  { name: "combat", description: "Attack creatures with the best weapon, fight hostiles until none are near, and back away." },
  {
    attack: action({
      doc: "Hit one creature until it dies. `target` is an entity id or a name ('zombie'; the nearest match, a player's username works too). Walks up to it, holds the best sword or axe from the inventory, and hits once per weapon cooldown. Gives up after `timeoutMs` (default 20000). Returns { target, killed, damageTaken, weapon }.",
      args: z.object({ target: Target, timeoutMs: z.number().int().positive().default(TARGET_TIMEOUT_MS) }),
      returns: z.object({ target: z.string(), killed: z.boolean(), damageTaken: z.number(), weapon: z.string().nullable() }),
      run: async (ctx, { target, timeoutMs }) => {
        const entity = findEntity(ctx, target);
        if (!entity) throw new Error(`no entity matches ${JSON.stringify(target)}`);
        const fight = await openFight(ctx);
        try {
          const killed = await engage(ctx, fight, entity, Date.now() + timeoutMs);
          return { target: entity.name ?? entity.username ?? String(entity.id), killed, damageTaken: fight.damage, weapon: fight.weapon };
        } finally {
          fight.close();
        }
      },
    }),
    fight: action({
      doc: "Fight until no target is left within `radius` (default 16) or `timeoutMs` (default 60000) passes. Targets default to hostile mobs: the registry category 'Hostile mobs', which includes slimes, magma cubes, phantoms, and ghasts, minus endermen, zombified piglins, striders, and end crystals, which are no threat until provoked. `targets` ('zombie', '*_skeleton', or a list) names others, endermen included. Takes the nearest first, holds the best sword or axe from the inventory, skips a target it cannot kill in 20 seconds, and fails if the player dies. Creepers explode when close: retreat from them first. Returns { kills, damageTaken, weapon, remaining, timedOut }.",
      args: z.object({
        radius: z.number().positive().default(DEFAULT_RADIUS),
        targets: NamePattern.optional(),
        timeoutMs: z.number().int().positive().default(60_000),
      }),
      returns: z.object({ kills: z.number(), damageTaken: z.number(), weapon: z.string().nullable(), remaining: z.number(), timedOut: z.boolean() }),
      run: (ctx, { radius, targets, timeoutMs }) => fightAll(ctx, radius, targets, timeoutMs),
    }),
    retreat: action({
      doc: "Walk away until more than `distance` (default 16) blocks from `from`: a position ({x,y,z} or [x,y,z]), an entity id, or a creature name. Without `from`, away from the nearest hostile mob within 32 blocks; fails when there is none. Gives up after `timeoutMs` (default 20000). Returns { position, distance } — where the player stopped and how far that is from `from`.",
      args: z.object({
        from: z.union([Position, Target]).optional(),
        distance: z.number().positive().default(DEFAULT_RETREAT_DISTANCE),
        timeoutMs: z.number().int().positive().default(RETREAT_TIMEOUT_MS),
      }),
      returns: z.object({ position: Point, distance: z.number() }),
      run: (ctx, { from, distance, timeoutMs }) => {
        let source: Vec3 | undefined;
        if (from === undefined) source = nearby(ctx, isHostile, 32)[0]?.position.clone();
        else if (typeof from === "number" || typeof from === "string") source = findEntity(ctx, from)?.position.clone();
        else source = toVec3(from);
        if (!source) throw new Error(from === undefined ? "no hostile mob within 32 blocks to retreat from" : `no entity matches ${JSON.stringify(from)}`);
        return retreatFrom(ctx, source, distance, timeoutMs);
      },
    }),
  },
);
