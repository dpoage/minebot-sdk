// The social routines: talk to, wait for, follow, and hand items to other players, and speak with the body (look, nod, shake, wave, crouch,
// jump, present) — calling the move and inventory primitives, with the pathfinder's follow goal for tagging along.
import { defineRoutine, type Entity, goals, type Item, Point, type RoutineContext, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as inventory from "minebot-sdk/routines/inventory";

export const description = "Talk to, wait for, follow, and hand items to other players, and gesture at them (look, nod, shake, wave, crouch, jump, hold an item out).";
export const uses = ["move", "sense", "inventory"] as const;

function playerEntity(ctx: RoutineContext, username: string): Entity {
  const entity = ctx.bot.players[username]?.entity;
  if (!entity) throw new Error(`player "${username}" is not in view`);
  return entity;
}

interface ChatMessage {
  from: string;
  message: string;
}

/** Resolves with the next chat message from another player that matches the filters. */
async function awaitChat(
  ctx: RoutineContext,
  options: { from?: string; match?: string; timeoutMs?: number } = {},
): Promise<ChatMessage> {
  const pattern = options.match ? new RegExp(options.match, "i") : null;
  const received = Promise.withResolvers<ChatMessage>();
  ctx.on("chat", (...args: unknown[]) => {
    const [from, message] = args;
    if (typeof from !== "string" || typeof message !== "string" || from === ctx.bot.username) return;
    if (options.from && from !== options.from) return;
    if (pattern && !pattern.test(message)) return;
    received.resolve({ from, message });
  });
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => received.reject(new Error(`no matching chat message within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => received.reject(ctx.signal.reason);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await received.promise;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export const say = defineRoutine(
  {
    name: "social.say",
    description: "Send a public chat `message`. Other players and agents read chat.",
    args: z.object({ message: z.string().min(1).max(256) }),
    returns: z.void(),
  },
  (ctx, { message }) => ctx.bot.chat(message),
);

export const waitForChat = defineRoutine(
  {
    name: "social.waitForChat",
    description: "Wait for the next chat message from another player. `from` (username), `match` (regex, case-insensitive), `timeoutMs` (default 60000).",
    args: z.object({
      from: z.string().optional(),
      match: z.string().optional(),
      timeoutMs: z.number().int().positive().default(60_000),
    }),
    returns: z.object({ from: z.string(), message: z.string() }),
  },
  (ctx, options) => awaitChat(ctx, options),
);

export const players = defineRoutine(
  {
    name: "social.players",
    description: "Other online players: [{ username, distance, position }] (distance and position are null when out of view).",
    args: z.object({}),
    returns: z.array(z.object({ username: z.string(), distance: z.number().nullable(), position: Point.nullable() })),
  },
  (ctx) =>
    Object.values(ctx.bot.players)
      .filter((p) => p.username !== ctx.bot.username)
      .map((p) => ({
        username: p.username,
        distance: p.entity ? Math.round(p.entity.position.distanceTo(ctx.bot.entity.position)) : null,
        position: p.entity ? p.entity.position.floored() : null,
      })),
);

export const follow = defineRoutine(
  {
    name: "social.follow",
    description: "Follow a `player` for `durationMs` (default 30000), staying within `distance` (default 2) blocks.",
    args: z.object({
      player: z.string().min(1),
      distance: z.number().positive().default(2),
      durationMs: z.number().int().positive().default(30_000),
    }),
    returns: z.void(),
  },
  async (ctx, { player, distance, durationMs }) => {
    ctx.bot.pathfinder.setGoal(new goals.GoalFollow(playerEntity(ctx, player), distance), true);
    try {
      await ctx.sleep(durationMs);
    } finally {
      ctx.bot.pathfinder.setGoal(null);
    }
  },
);

export const give = defineRoutine(
  {
    name: "social.give",
    description: "Walk to a `player` and toss them `count` (default 1) of `item`.",
    args: z.object({ player: z.string().min(1), item: z.string().min(1), count: z.number().int().positive().default(1) }),
    returns: z.void(),
  },
  async (ctx, { player, item, count }) => {
    const target = playerEntity(ctx, player);
    await move.to(ctx, { position: target.position.floored(), range: 1, timeoutMs: 30_000 });
    // A tossed stack flies about two blocks; aim low so it lands at the recipient's feet.
    await ctx.bot.lookAt(playerEntity(ctx, player).position.offset(0, 0.2, 0), true);
    await inventory.toss(ctx, { item, count });
  },
);

const GESTURES = ["look", "nod", "shake", "wave", "crouch", "jump", "present"] as const;
type Gesture = (typeof GESTURES)[number];

/** One tick-aligned beat of a gesture: forced looks land on the next physics tick, so a step must outlast a few ticks for an onlooker to see it. */
const BEAT_MS = 150;
/** How far a nod or a shake swings the head from where it faced: about 26 degrees, enough that each swing reads as a movement. */
const SWING = 0.45;

/** The entity of the player `username` that this bot can see, or a thrown error that names the cause and the fix. */
function viewedPlayer(ctx: RoutineContext, username: string): Entity {
  const { bot } = ctx;
  if (username === bot.username) throw new Error(`toward "${username}" is this bot itself: name another player`);
  const inView = Object.values(bot.entities).filter((e) => typeof e.username === "string" && e.username !== bot.username);
  const seen = inView.find((e) => e.username === username);
  if (seen) return seen;
  const others = inView.map((e) => e.username);
  const cause = bot.players[username] ? "is online but not in view (too far away or not loaded): walk closer with move.to" : "is not online";
  const choices = others.length > 0 ? `players in view: ${others.join(", ")}. Pass \`toward\` as one of them, or leave it out` : "no other players are in view. Leave `toward` out, or call again when a player is close";
  throw new Error(`cannot turn toward "${username}": that player ${cause}; ${choices}.`);
}

/** The stack `present` will hold out, or a thrown error that names the cause and the fix. `item` is undefined for "whatever is in the main hand". */
function itemToPresent(ctx: RoutineContext, item: string | undefined): Item {
  const { bot } = ctx;
  if (item === undefined) {
    if (bot.heldItem) return bot.heldItem;
    throw new Error(`present needs something to hold out: the main hand is empty and no \`item\` was given. Pass \`item\` (an item name from the inventory), e.g. { kind: "present", item: "bread" }.`);
  }
  const name = item.replace(/^minecraft:/, "");
  // `inventory.items()` leaves out the off-hand slot, which still holds something the bot carries.
  const offHand = bot.inventory.slots[bot.getEquipmentDestSlot("off-hand")];
  const carriedStacks = offHand ? [...bot.inventory.items(), offHand] : bot.inventory.items();
  const found = carriedStacks.find((i) => i.name === name);
  if (found) return found;
  const carried = [...new Set(carriedStacks.map((i) => i.name))];
  throw new Error(`cannot present "${name}": the inventory holds none of it (${carried.length > 0 ? `it holds ${carried.join(", ")}` : "the inventory is empty"}). Pass \`item\` as a name from the inventory, or leave it out to show what is in hand.`);
}

/** A swing of the head from where it faced: yaw and pitch offsets, one forced look per beat, ending back where it started. */
async function swingHead(ctx: RoutineContext, offsets: readonly (readonly [yaw: number, pitch: number])[]): Promise<void> {
  const { bot } = ctx;
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  for (const [dYaw, dPitch] of offsets) {
    await bot.look(yaw + dYaw, pitch + dPitch, true);
    await ctx.sleep(BEAT_MS);
  }
}

/** Holds `control` down while `during` runs, and always lets go of it. */
async function holding(ctx: RoutineContext, control: "sneak" | "jump", during: () => Promise<void>): Promise<void> {
  ctx.bot.setControlState(control, true);
  try {
    await during();
  } finally {
    ctx.bot.setControlState(control, false);
  }
}

/** Hops once: jump is held until the feet have risen half a block, then let go, and the hop is waited out so the gesture ends on the ground. */
async function hop(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const from = bot.entity.position.y;
  await holding(ctx, "jump", async () => {
    for (let waited = 0; bot.entity.position.y < from + 0.5; waited += 50) {
      if (waited >= 600) throw new Error("the jump did not leave the ground (a ceiling above, or something is holding the bot): clear the space above it, or use kind \"nod\" or \"wave\" instead");
      await ctx.sleep(50);
    }
  });
  for (let waited = 0; bot.entity.onGround === false && waited < 1000; waited += 50) await ctx.sleep(50);
}

/** Holds `wanted` in the main hand, equipping it from wherever the inventory keeps it, and waits until the hand shows it. */
async function holdOut(ctx: RoutineContext, wanted: Item): Promise<void> {
  const { bot } = ctx;
  if (bot.heldItem?.name !== wanted.name) await bot.equip(wanted, "hand");
  for (let waited = 0; bot.heldItem?.name !== wanted.name; waited += 50) {
    if (waited >= 1000) throw new Error(`could not hold ${wanted.name} out: it is not in the main hand after equipping it. Try again, or free a hotbar slot first.`);
    await ctx.sleep(50);
  }
}

export const gesture = defineRoutine(
  {
    name: "social.gesture",
    description:
      "Body language toward a player; takes about a second or two, and the controls are released afterwards. `kind`: look (turn to face `toward` and hold their gaze), nod (the head dips three times: yes), shake (the head turns side to side: no), wave (the right arm swings three times), crouch (sneak for a moment, then stand), jump (one hop), present (hold `item` out in the main hand, taken from anywhere in the inventory, and it stays held; without `item`, show what is already in hand). `toward`: a username in view; the head turns to face that player first (required for look).",
    args: z.object({
      kind: z.enum(GESTURES),
      toward: z.string().min(1).optional(),
      item: z.string().min(1).optional(),
    }),
    returns: z.object({ kind: z.enum(GESTURES), toward: z.string().optional(), item: z.string().optional() }),
  },
  async (ctx, { kind, toward, item }) => {
    const { bot } = ctx;
    // Everything that can be refused is refused before the body moves.
    if (kind === "look" && toward === undefined) throw new Error(`gesture "look" needs \`toward\`: the username of the player to look at, e.g. { kind: "look", toward: "Steve" }.`);
    if (item !== undefined && kind !== "present") throw new Error(`\`item\` only goes with kind "present" (this call is "${kind}"): drop \`item\`, or use { kind: "present", item: "${item}" }.`);
    const target = toward === undefined ? undefined : viewedPlayer(ctx, toward);
    const wanted = kind === "present" ? itemToPresent(ctx, item) : undefined;
    const aimAtHead = (entity: Entity) => bot.lookAt(entity.position.offset(0, entity.height * 0.9, 0), true);

    if (target) {
      await aimAtHead(target);
      await ctx.sleep(BEAT_MS);
    }
    const pitchDown = bot.entity.pitch > -1 ? -1 : 1;
    const beats: Record<Gesture, () => Promise<void>> = {
      // Their head, re-aimed each beat so the gaze follows a player who moves.
      look: async () => {
        for (let beat = 0; beat < 5; beat++) {
          if (target) await aimAtHead(target);
          await ctx.sleep(BEAT_MS);
        }
      },
      nod: () => swingHead(ctx, [[0, pitchDown * SWING], [0, 0], [0, pitchDown * SWING], [0, 0], [0, pitchDown * SWING], [0, 0]]),
      shake: () => swingHead(ctx, [[-SWING, 0], [SWING, 0], [-SWING, 0], [SWING, 0], [0, 0]]),
      wave: async () => {
        for (let swing = 0; swing < 3; swing++) {
          bot.swingArm("right");
          await ctx.sleep(2 * BEAT_MS);
        }
      },
      crouch: async () => {
        await holding(ctx, "sneak", () => ctx.sleep(4 * BEAT_MS));
        await ctx.sleep(BEAT_MS);
      },
      jump: () => hop(ctx),
      present: async () => {
        if (wanted) await holdOut(ctx, wanted);
        await ctx.sleep(5 * BEAT_MS);
      },
    };
    await beats[kind]();
    return { kind, ...(toward !== undefined && { toward }), ...(wanted && { item: wanted.name }) };
  },
);
