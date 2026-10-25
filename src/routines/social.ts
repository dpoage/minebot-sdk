// The social routines: talk to, wait for, follow, and hand items to other players, speak with the body (look, nod, shake, wave, crouch,
// jump, present), and leave words in the world (write a sign, write or sign a book) — calling the move and inventory primitives, with the pathfinder's follow goal for tagging along.
import { type Block, type Bot, defineRoutine, type Entity, goals, type Item, Point, Position, type RoutineContext, toVec3, type Vec3, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";
import * as inventory from "minebot-sdk/routines/inventory";

export const description = "Talk to, wait for, follow, and hand items to other players, gesture at them (look, nod, shake, wave, crouch, jump, hold an item out), and write words in the world (text on a sign, pages in a book).";
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

const SIDES = ["front", "back"] as const;
type Side = (typeof SIDES)[number];

/** The server's limit per sign line, which Mineflayer's `updateSign` enforces by emitting an error on the bot and sending nothing. */
const SIGN_LINE_MAX = 45;
/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const EYE_HEIGHT = 1.62;
const HOTBAR_START = 36;
/** How long the server gets to open the sign's editor after the bot uses the sign. */
const EDITOR_WAIT_MS = 3_000;
/** How long the server gets to show an edit back to the bot, whether a sign's text or a book's contents. */
const READBACK_MS = 2_000;
/** A string the server caps at `limit` characters as it counts them: UTF-16 code units, where a character outside the BMP (an emoji) counts as 2. Zod's `.max` counts code points and passes a 46-unit line of 23 emoji, which the write then fails on. */
const serverChars = (limit: number, message: string) => z.string().max(limit, message).refine((text) => text.length <= limit, message);

/** The member `key` of `value` when it is an object that has one, else undefined: how the NBT the server sends is read without trusting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The text of one NBT text component: a plain string, a tagged string `{ type, value }`, or a compound with a `text` child. */
function componentText(component: unknown): string {
  if (typeof component === "string") return component;
  const payload = field(component, "value");
  if (typeof payload === "string") return payload;
  const text = field(field(payload, "text"), "value");
  return typeof text === "string" ? text : JSON.stringify(payload ?? component);
}

/** The four lines on one side of a sign as the client holds them, or undefined when the client holds no text for it. */
function signLines(block: Block, side: Side): string[] | undefined {
  const messages = field(field(field(field(field(block.entity, "value"), `${side}_text`), "value"), "messages"), "value");
  const list = field(messages, "value");
  if (!Array.isArray(list)) return undefined;
  return Array.from({ length: 4 }, (_, i) => (i < list.length ? componentText(list[i]) : ""));
}

function isWaxed(block: Block): boolean {
  const flags = field(field(block.entity, "value"), "is_waxed") ?? field(field(block.entity, "value"), "isWaxed");
  const flag = field(flags, "value");
  return flag === 1 || flag === true;
}

const where = (pos: Point) => `(${pos.x}, ${pos.y}, ${pos.z})`;

/** Mineflayer decodes the NBT the server sends as plain UTF-8, but NBT keeps a character outside the BMP (an emoji) as two surrogates of three bytes each, which it reads as six replacement characters. This is what a correct write of `text` reads as. */
const asNbtRead = (text: string) => text.replace(/[\u{10000}-\u{10FFFF}]/gu, "\uFFFD".repeat(6));

/**
 * The sign at `pos` that the bot can reach, with its editor state checked, or a thrown error that names the cause and the fix.
 * Nothing here touches the world.
 */
function signToEdit(ctx: RoutineContext, pos: Vec3): Block {
  const { bot } = ctx;
  const block = bot.blockAt(pos);
  if (!block) throw new Error(`the block at ${where(pos)} is not loaded: walk closer with move.to, then call again.`);
  if (!/_sign$/.test(block.name)) {
    throw new Error(`there is no sign at ${where(pos)}: the block there is ${block.name}. Place one first with place.place({ at: { x: ${pos.x}, y: ${pos.y}, z: ${pos.z} }, item: "oak_sign" }), then call social.sign again.`);
  }
  if (isWaxed(block)) {
    throw new Error(`the ${block.name} at ${where(pos)} is waxed, and a waxed sign can never be edited. Replace it with a fresh sign and call social.sign on that one instead.`);
  }
  const distance = bot.entity.position.offset(0, EYE_HEIGHT, 0).distanceTo(pos.offset(0.5, 0.5, 0.5));
  if (distance > REACH) {
    throw new Error(`the ${block.name} at ${where(pos)} is ${distance.toFixed(1)} blocks from the bot's eyes, and signs can be edited from ${REACH} blocks at most. Walk within reach first with move.to, then call again.`);
  }
  return block;
}

/** Whether right-clicking a sign with `item` in the main hand acts on the sign instead of opening its editor: honeycomb waxes it for good, dyes and ink sacs recolor or glow its text, and a hanging sign item on a wall hanging sign tries to hang another sign there. A ceiling hanging sign opens its editor for the same click a bot sends, and an empty hand or any other item opens every sign's editor. */
function actsOnSign(item: string | undefined, block: string): boolean {
  return item !== undefined && (item === "honeycomb" || item === "ink_sac" || item === "glow_ink_sac" || /_dye$/.test(item) || (/_hanging_sign$/.test(item) && /_wall_hanging_sign$/.test(block)));
}

/**
 * Runs `work` with a main hand the 26.1 server will open the editor of `block` for. The hand that works is used as it is: first the current one, then
 * a hotbar slot that is empty or holds a stack that does not act on the sign, and otherwise the held stack moved into an empty main-grid slot and
 * back. Every path restores the selected hotbar slot and every stack to where it was, and the sign is never waxed or recolored.
 */
async function withWritableHand<T>(ctx: RoutineContext, block: Block, work: () => Promise<T>): Promise<T> {
  const { bot } = ctx;
  if (!actsOnSign(bot.heldItem?.name, block.name)) return work();
  const hotbar = Array.from({ length: 9 }, (_, i) => bot.inventory.slots[HOTBAR_START + i]);
  const usable = hotbar.findIndex((stack, i) => i !== bot.quickBarSlot && (!stack || !actsOnSign(stack.name, block.name)));
  if (usable >= 0) {
    const original = bot.quickBarSlot;
    bot.setQuickBarSlot(usable);
    try {
      return await work();
    } finally {
      bot.setQuickBarSlot(original);
    }
  }
  const heldSlot = HOTBAR_START + bot.quickBarSlot;
  const mainGridFree = bot.inventory.slots.slice(9, HOTBAR_START).findIndex((stack) => !stack);
  if (mainGridFree < 0) {
    const held = [...new Set(hotbar.filter((stack): stack is Item => stack !== null).map((stack) => stack.name))];
    throw new Error(`every hotbar stack holds one of ${JSON.stringify(held)}, which acts on the ${block.name} instead of opening its editor, and the inventory has no free slot to set one aside in. Free one hotbar slot (inventory.toss), then call again.`);
  }
  await bot.moveSlotItem(heldSlot, 9 + mainGridFree);
  try {
    return await work();
  } finally {
    await bot.moveSlotItem(9 + mainGridFree, heldSlot);
  }
}

/** Uses the sign so that the server opens its editor for the bot, and resolves once it has. */
async function openEditor(ctx: RoutineContext, block: Block): Promise<void> {
  const { bot } = ctx;
  let open = false;
  const onOpen = (opened: Block | null) => {
    if (opened?.position.equals(block.position)) open = true;
  };
  bot.on("signOpen", onOpen);
  try {
    await bot.activateBlock(block);
    for (let waited = 0; !open; waited += 50) {
      if (waited >= EDITOR_WAIT_MS) {
        throw new Error(`the server did not open the ${block.name} at ${where(block.position)} for editing within ${EDITOR_WAIT_MS / 1000} s: another player may be editing it, the sign may have just been waxed, or this bot may not build here (adventure mode or a protected area). Try again, or choose another sign.`);
      }
      await ctx.sleep(50);
    }
  } finally {
    bot.off("signOpen", onOpen);
  }
}

export const sign = defineRoutine(
  {
    name: "social.sign",
    description:
      "Write `lines` (1 to 4 strings, each at most 45 characters as the server counts them — an emoji counts as 2; about 15 characters show per line, so keep lines short) on the existing sign at `at` ({x,y,z} or [x,y,z]). `side`: \"front\" (default) or \"back\". The sign must already stand there (place it with place.place, e.g. item \"oak_sign\") and be within 4.5 blocks of the bot; walk closer first with move.to. A waxed sign cannot be written. Lines you leave out end up empty. The write uses a main hand the server will open the editor for: an ordinary held item or an empty hand is used as it is, while honeycomb, a dye, an ink sac, or a hanging sign item on a wall hanging sign — each of which would act on the sign instead of opening its editor — is set aside for the write and the hotbar is put back exactly as it was, so the sign is never waxed or recolored. It throws only when every hotbar stack is one of those and no inventory slot is free, naming the stacks. Returns { at, side, lines } with the four lines read back from the sign, and throws if the sign does not show what was written.",
    args: z.object({
      at: Position,
      lines: z
        .array(
          serverChars(
            SIGN_LINE_MAX,
            `a sign line holds at most ${SIGN_LINE_MAX} characters as the server counts them (an emoji counts as 2): shorten this line (about 15 show per line), or move text onto another line`,
          ).refine((line) => !/[\r\n]/.test(line), "a sign line cannot contain a line break: put each line as its own entry of `lines`"),
        )
        .min(1, "give 1 to 4 lines: pass `lines` as an array of strings, e.g. [\"Welcome\", \"to the shop\"]")
        .max(4, "a sign holds 4 lines at most: pass 4 or fewer entries in `lines`, or write another sign"),
      side: z.enum(SIDES).default("front"),
    }),
    returns: z.object({ at: Point, side: z.enum(SIDES), lines: z.array(z.string()) }),
  },
  async (ctx, { at, lines, side }) => {
    const { bot } = ctx;
    const pos = toVec3(at).floored();
    const block = signToEdit(ctx, pos);
    await withWritableHand(ctx, block, async () => {
      await openEditor(ctx, block);
      bot.updateSign(block, lines.join("\n"), side === "back");
    });

    const wanted = Array.from({ length: 4 }, (_, i) => lines[i] ?? "");
    for (let waited = 0; ; waited += 50) {
      const read = bot.blockAt(pos);
      const kept = read && /_sign$/.test(read.name) ? signLines(read, side) : undefined;
      if (kept?.every((line, i) => line === asNbtRead(wanted[i] ?? ""))) return { at: { x: pos.x, y: pos.y, z: pos.z }, side, lines: wanted };
      if (waited >= READBACK_MS) {
        throw new Error(`the ${side} of the sign at ${where(pos)} shows ${kept ? JSON.stringify(kept) : "no text the bot can read"} instead of ${JSON.stringify(wanted)}: the server kept something else (it may filter some characters) or did not take the edit. Change the text and call again.`);
      }
      await ctx.sleep(50);
    }
  },
);

const BOOK_PAGES_MAX = 100;
const BOOK_PAGE_MAX = 1024;
const BOOK_TITLE_MAX = 32;
/** The slots `book: "first"` searches, in order: the main grid (window slots 9-35), then the hotbar (36-44). The off-hand (45) is not searched. */
const BOOK_SLOTS_FROM = 9;
const BOOK_SLOTS_TO = 45;

/** Mineflayer implements `bot.signBook` but leaves it out of its typings. */
type SigningBot = Bot & { signBook(slot: number, pages: string[], author: string, title: string): Promise<void> };

interface BookContents {
  item: string;
  title?: string;
  author?: string;
  pages: string[];
}

/** What a book stack holds, as the server reported it (the two item components keep their pages in different shapes), or undefined for any other item. */
function bookContents(stack: Item | null | undefined): BookContents | undefined {
  if (!stack || (stack.name !== "writable_book" && stack.name !== "written_book")) return undefined;
  const components = field(stack, "componentMap");
  const data = components instanceof Map ? field(components.get(`${stack.name}_content`), "data") : undefined;
  const list = field(data, "pages");
  const pages = Array.isArray(list) ? list.map((page) => componentText(field(page, "content"))) : [];
  if (stack.name === "writable_book") return { item: stack.name, pages };
  const [title, author] = [field(data, "rawTitle"), field(data, "author")];
  return { item: stack.name, ...(typeof title === "string" && { title }), ...(typeof author === "string" && { author }), pages };
}

function describeBook(contents: BookContents | undefined): string {
  if (!contents) return "no book";
  const signed = contents.item === "written_book" ? ` titled ${JSON.stringify(contents.title)} by ${JSON.stringify(contents.author)}` : "";
  return `a ${contents.item}${signed} with ${contents.pages.length} page${contents.pages.length === 1 ? "" : "s"} ${JSON.stringify(contents.pages).slice(0, 200)}`;
}

/** The custom name a stack carries (the component reads as `{ type: "string", value }`), or undefined when it has none. */
function bookName(stack: Item): string | undefined {
  const raw: unknown = stack.customName;
  const name = typeof raw === "string" ? raw : field(raw, "value");
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** Every writable_book in the inventory in the order `book: "first"` counts them: the main grid before the hotbar. */
function writableBooks(bot: Bot): { stack: Item; slot: number }[] {
  const found: { stack: Item; slot: number }[] = [];
  for (let slot = BOOK_SLOTS_FROM; slot < BOOK_SLOTS_TO; slot++) {
    const stack = bot.inventory.slots[slot];
    if (stack?.name === "writable_book") found.push({ stack, slot });
  }
  return found;
}

/** A book as the errors name it: by the custom name it carries when it has one, with how many pages it holds. */
function bookLabel(stack: Item): string {
  const name = bookName(stack);
  const pages = bookContents(stack)?.pages.length ?? 0;
  return `${name === undefined ? "the unnamed book and quill" : `the book and quill named ${JSON.stringify(name)}`} (${pages} page${pages === 1 ? "" : "s"})`;
}

export const book = defineRoutine(
  {
    name: "social.book",
    description:
      "Write `pages` (1 to 100 strings, each 1 to 1024 characters as the server counts them — an emoji counts as 2) into a writable_book (book and quill) in the inventory, replacing what it held. A writable_book is made from a book, an ink_sac and a feather. `book`: \"new\" (default) writes into a BLANK writable_book (no pages, or only empty pages) and never touches one that holds writing: if none is blank it throws and names the fix (craft a book and quill, or pass book: \"first\") and which book \"first\" would rewrite. \"first\" rewrites the first unsigned writable_book in slot order — the main inventory grid first, then the hotbar (the off-hand is not searched); e.g. a renamed 'Ledger' in the main grid and a blank book in the hotbar: \"first\" picks 'Ledger', \"new\" picks the blank one. Without `title` the book stays a writable_book that can be written again (a ledger). With `title` (1 to 32 characters, counted the same way) the book is signed: it becomes a written_book with you as the author, and can never be edited again. Returns { item, title?, name?, pages } where pages is the count read back and name is the custom name of the book that was written, when it had one, and throws if the book does not hold what was written.",
    args: z.object({
      pages: z
        .array(serverChars(BOOK_PAGE_MAX, `a book page holds at most ${BOOK_PAGE_MAX} characters as the server counts them (an emoji counts as 2): split this text over more pages`).min(1, "a book page cannot be empty: give every page some text"))
        .min(1, "a book needs at least 1 page: pass `pages` as an array of strings, e.g. [\"First page\", \"Second page\"]")
        .max(BOOK_PAGES_MAX, `a book holds at most ${BOOK_PAGES_MAX} pages: pass fewer entries in \`pages\``),
      title: serverChars(BOOK_TITLE_MAX, `a book title holds at most ${BOOK_TITLE_MAX} characters as the server counts them (an emoji counts as 2): shorten the title`)
        .refine((title) => title.trim() !== "", "the book title is blank: give a title of 1 to 32 characters, or leave `title` out to keep the book editable")
        .optional(),
      book: z.enum(["new", "first"]).default("new"),
    }),
    returns: z.object({ item: z.enum(["writable_book", "written_book"]), title: z.string().optional(), name: z.string().optional(), pages: z.number().int() }),
  },
  async (ctx, { pages, title, book: which }) => {
    const { bot } = ctx;
    const books = writableBooks(bot);
    const first = books[0];
    if (!first) {
      throw new Error("the inventory holds no writable_book (book and quill) to write in. Craft one first (craft.craft: book + ink_sac + feather), or pick one up, then call social.book again.");
    }
    const chosen = which === "first" ? first : books.find(({ stack }) => (bookContents(stack)?.pages ?? []).every((text) => text === ""));
    if (!chosen) {
      throw new Error(
        `no blank book and quill to write in: all ${books.length} writable_book${books.length === 1 ? "" : "s"} in the inventory hold writing, and book: "new" never overwrites writing. Craft a new book and quill (craft.craft: book + ink_sac + feather) and call again, or pass book: "first" to rewrite one — "first" would rewrite ${bookLabel(first.stack)} in slot ${first.slot} (slot order: the main inventory grid, then the hotbar; the off-hand is not searched).`,
      );
    }
    const { stack, slot } = chosen;
    const name = bookName(stack);
    const wanted = title === undefined ? ("writable_book" as const) : ("written_book" as const);
    const done = { item: wanted, ...(title !== undefined && { title }), ...(name !== undefined && { name }), pages: pages.length };
    const holdsWritten = (contents: BookContents | undefined) =>
      contents?.item === wanted && contents.pages.length === pages.length && contents.pages.every((text, i) => text === (title === undefined ? pages[i] : asNbtRead(pages[i] ?? ""))) && (title === undefined || (contents.title === title && contents.author === bot.username));

    // A server sends nothing back for an edit that changes nothing, so a book that already holds these pages is done.
    if (title === undefined && holdsWritten(bookContents(stack))) return done;

    // Mineflayer moves the book to the hotbar to edit it and back afterwards, and updates the stack's own `slot` on the way: the slot to read back is where it started.
    // Mineflayer 4.39 always implements signBook; only its typings leave it out.
    const signer = bot as SigningBot;
    try {
      if (title === undefined) await bot.writeBook(slot, pages);
      else await signer.signBook(slot, pages, bot.username, title);
    } catch (error) {
      throw new Error(`the server did not confirm the book edit (${error instanceof Error ? error.message : String(error)}): the book was not written. Try again.`, { cause: error });
    }

    for (let waited = 0; ; waited += 50) {
      const kept = bookContents(bot.inventory.slots[slot]);
      if (holdsWritten(kept)) return done;
      if (waited >= READBACK_MS) {
        throw new Error(`slot ${slot} holds ${describeBook(kept)} instead of the ${wanted} that was written: the server kept something else or did not take the edit. Check the inventory and call again.`);
      }
      await ctx.sleep(50);
    }
  },
);
