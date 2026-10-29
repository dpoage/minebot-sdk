// The items routines: item knowledge — recipes, and the item drops lying on the ground — and renaming an item at an anvil.
import { type Block, type Bot, defineRoutine, droppedStack, type Item, type RoutineContext, within, z } from "minebot-sdk/routine";

/** What `bot.openBlock` opens: the anvil's window, with its slots and the player's inventory in them. */
type AnvilWindow = Awaited<ReturnType<Bot["openBlock"]>>;

export const description = "Look up recipes, find the items lying on the ground, and rename an item at an anvil.";
export const uses = [] as const;

function itemId(ctx: RoutineContext, name: string): number {
  const item = ctx.bot.registry.itemsByName[name.replace(/^minecraft:/, "")];
  if (!item) throw new Error(`unknown item "${name}"`);
  return item.id;
}

/** One way to craft an item, as agents see it. */
interface RecipeSummary {
  makes: number;
  requiresTable: boolean;
  ingredients: Record<string, number>;
}

function summarize(ctx: RoutineContext, recipe: { delta: { id: number; count: number }[]; result: { count: number }; requiresTable: boolean }): RecipeSummary {
  const ingredients: Record<string, number> = {};
  for (const d of recipe.delta) {
    if (d.count < 0) ingredients[ctx.bot.registry.items[d.id]?.name ?? `#${d.id}`] = -d.count;
  }
  return { makes: recipe.result.count, requiresTable: recipe.requiresTable, ingredients };
}

/** The dropped stacks within `radius`, nearest first: the floored position of each entity with the item it holds. */
function droppedItems(ctx: RoutineContext, radius: number) {
  const at = ctx.bot.entity.position;
  return Object.values(ctx.bot.entities)
    .filter((e) => e.name === "item" && e.position.distanceTo(at) < radius)
    .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at))
    .flatMap((e) => {
      const stack = droppedStack(e);
      if (!stack) return [];
      const { x, y, z } = e.position.floored();
      return [{ x, y, z, name: stack.name, count: stack.count }];
    });
}

export const recipes = defineRoutine(
  {
    name: "items.recipes",
    description: "Every recipe for `item`, one per variant (a tagged ingredient such as planks or logs gives one recipe per wood, so stick lists 13): [{ makes, requiresTable, ingredients: { name: count } }]. Fails for an unknown item. To see what you still need to gather for it, call crafter.plan.",
    args: z.object({ item: z.string().min(1) }),
    returns: z.array(z.object({ makes: z.number(), requiresTable: z.boolean(), ingredients: z.record(z.string(), z.number()) })),
  },
  (ctx, { item }): RecipeSummary[] => ctx.bot.recipesAll(itemId(ctx, item), null, true).map((r) => summarize(ctx, r)),
);

export const drops = defineRoutine(
  {
    name: "items.drops",
    description: "Dropped item stacks within `radius` (default 8), nearest first: [{ x, y, z, name, count }], where x, y, z is the floored position of the stack and name and count are the item it holds, e.g. { x: 3, y: 64, z: 0, name: 'oak_log', count: 2 } — what a dig has left to pick up. An entry works wherever a position {x,y,z} is taken.",
    args: z.object({ radius: z.number().positive().default(8) }),
    returns: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), name: z.string(), count: z.number().int().positive() })),
  },
  (ctx, { radius }) => droppedItems(ctx, radius),
);

/** Survival players interact with blocks up to 4.5 blocks from the eyes. */
const REACH = 4.5;
const EYE_HEIGHT = 1.62;
/** How far out the error looks for an anvil to name. */
const ANVIL_SEARCH_RADIUS = 16;
const ANVIL_BLOCKS = ["anvil", "chipped_anvil", "damaged_anvil"];
/** The longest name 26.1 accepts; mineflayer's own anvil.rename stops at 35, so the rename writes the packet itself. */
const MAX_NAME_LENGTH = 50;
const OPEN_TIMEOUT_MS = 8_000;
/** The anvil's slots: the item to rename goes in 0, the renamed item comes out of 2. */
const INPUT_SLOT = 0;
const OUTPUT_SLOT = 2;
/** The window property that carries the level cost of the anvil's current output. */
const COST_PROPERTY = 0;
/** The server answers within a tick or two; a poll waits this long between looks, for at most POLLS looks. */
const POLL_MS = 50;
const OFFER_POLLS = 60;
const SETTLE_POLLS = 20;

/** The text of a stack's custom name: the component reads as `{ type: "string", value }`, not as a string. */
function customNameOf(stack: Item | null | undefined): string | null {
  const raw: unknown = stack?.customName;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null && "value" in raw && typeof raw.value === "string") return raw.value;
  return null;
}

function levels(n: number): string {
  return `${n} level${n === 1 ? "" : "s"}`;
}

/** The anvils within ANVIL_SEARCH_RADIUS, nearest first, with the distance from the eyes to the block's center. */
function anvilsAround(ctx: RoutineContext): { block: Block; distance: number }[] {
  const { bot } = ctx;
  const ids = ANVIL_BLOCKS.flatMap((name) => bot.registry.blocksByName[name]?.id ?? []);
  const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  return bot
    .findBlocks({ matching: ids, maxDistance: ANVIL_SEARCH_RADIUS + 2, count: 64 })
    .flatMap((pos) => {
      const block = bot.blockAt(pos);
      return block ? [{ block, distance: eyes.distanceTo(pos.offset(0.5, 0.5, 0.5)) }] : [];
    })
    .filter((anvil) => anvil.distance <= ANVIL_SEARCH_RADIUS)
    .sort((a, b) => a.distance - b.distance);
}

/** The anvil within reach; throws, naming the nearest one and the way to it, when there is none. */
function anvilWithinReach(ctx: RoutineContext): Block {
  const nearest = anvilsAround(ctx)[0];
  if (!nearest) throw new Error(`no anvil within ${ANVIL_SEARCH_RADIUS} blocks: place one (place.place with item "anvil") or walk to one (move.to), then call items.rename again`);
  if (nearest.distance > REACH) {
    throw new Error(
      `no anvil within reach (${REACH} blocks): the nearest is the ${nearest.block.name} at ${nearest.block.position}, ${nearest.distance.toFixed(1)} blocks away; walk within reach first (for example move.to to a spot next to it), then call items.rename again`,
    );
  }
  return nearest.block;
}

/** Looks every POLL_MS until `done` holds, at most `polls` times; whether it held. */
async function poll(ctx: RoutineContext, polls: number, done: () => boolean): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    if (done()) return true;
    await ctx.sleep(POLL_MS);
  }
  return done();
}

/** Sends `name`, waits until the output slot carries it, and returns the level cost the server sent with it. The output can show an older name first. */
async function offerRename(ctx: RoutineContext, window: AnvilWindow, stack: Item, name: string, costs: { level: number | undefined }): Promise<number | undefined> {
  ctx.bot._client.write("name_item", { name });
  if (!(await poll(ctx, OFFER_POLLS, () => customNameOf(window.slots[OUTPUT_SLOT]) === name))) {
    const offered = window.slots[OUTPUT_SLOT];
    if (offered) {
      throw new Error(`the anvil kept the name ${JSON.stringify(customNameOf(offered))} instead of ${JSON.stringify(name)}: the server drops characters it does not allow in names (such as §); use plain text`);
    }
    throw new Error(`the anvil offered no renamed ${stack.name}: it offers nothing when the item already has that name, so pick a different name`);
  }
  // The slot update and the cost property arrive together; one more look covers a split.
  await ctx.sleep(POLL_MS);
  return costs.level;
}

/**
 * Puts the stack in the anvil and takes the renamed one out; whatever the anvil still holds goes back to
 * the inventory before the window closes, and the inventory is read back from the server, whether or not
 * that went well. Resolves with the level cost the anvil showed.
 */
async function renameAtAnvil(ctx: RoutineContext, anvil: Block, stack: Item, name: string, levelBefore: number, creative: boolean): Promise<number | undefined> {
  const { bot } = ctx;
  const window = await within(OPEN_TIMEOUT_MS, `opening the ${anvil.name}`, bot.openBlock(anvil), () => {});
  // The server closes the window itself when the anvil breaks; it then returns what the anvil held.
  const open = () => bot.currentWindow === window;
  const costs: { level: number | undefined } = { level: undefined };
  const onBar = (packet: { windowId: number; property: number; value: number }) => {
    if (packet.windowId === window.id && packet.property === COST_PROPERTY) costs.level = packet.value;
  };
  bot._client.on("craft_progress_bar", onBar);
  let failure: { error: unknown } | undefined;
  let cost: number | undefined;
  try {
    if (!/anvil/.test(String(window.type))) throw new Error(`the block opened a ${window.type} window, not an anvil's`);
    // The chosen stack itself, by its slot: a transfer by item type would take the first stack of the type, which may already have the name.
    await bot.moveSlotItem(stack.slot - bot.inventory.inventoryStart + window.inventoryStart, INPUT_SLOT);
    cost = await offerRename(ctx, window, stack, name, costs);
    if (!creative && cost !== undefined && levelBefore < cost) {
      throw new Error(`renaming the ${stack.name} costs ${levels(cost)} and you have ${levels(levelBefore)}: earn ${levels(cost - levelBefore)} more, then call items.rename again`);
    }
    if (!open()) throw new Error(`the ${anvil.name} closed before the renamed ${stack.name} could be taken; was it broken?`);
    await within(OPEN_TIMEOUT_MS, `taking the renamed ${stack.name}`, bot.putAway(OUTPUT_SLOT), () => {});
  } catch (error) {
    failure = { error };
  }
  let cleanup: unknown;
  try {
    if (open() && window.slots[INPUT_SLOT]) await within(OPEN_TIMEOUT_MS, `returning the ${stack.name} from the anvil`, bot.putAway(INPUT_SLOT), () => {});
  } catch (error) {
    cleanup = error;
  }
  bot._client.off("craft_progress_bar", onBar);
  if (open()) bot.closeWindow(window);
  // Mineflayer's copy at close is not what the server holds: it takes a stack that differs from the old one
  // only in its name for unchanged, and when the server closed the anvil itself (it broke) the stack can sit
  // elsewhere than the window showed. `_syncWindow` (Mineflayer 4.39, untyped) sends a click the server
  // always answers with the full inventory, which replaces `bot.inventory`.
  try {
    const sync = (bot as typeof bot & { _syncWindow(window: typeof bot.inventory): Promise<void> })._syncWindow(bot.inventory);
    await within(OPEN_TIMEOUT_MS, "reading the inventory back from the server", sync, () => {});
  } catch (error) {
    cleanup ??= error;
  }
  if (failure) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    if (cleanup) throw new Error(`${message}; then ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
    throw failure.error;
  }
  if (cleanup) throw cleanup;
  return cost;
}

export const rename = defineRoutine(
  {
    name: "items.rename",
    description: `Rename the first stack of \`item\` in the inventory that does not already have \`name\` to \`name\` (1-${MAX_NAME_LENGTH} characters; spaces are fine) at an anvil within reach (${REACH} blocks; this never walks, so go there first, for example move.to). The cost is experience levels, usually 1 or more; an error names the cost and your level. Returns { item, name, count, levelsSpent }: count is how many items were renamed and levelsSpent is the levels it cost. When every stack of \`item\` already has \`name\`, nothing is renamed and no anvil is needed: this returns at once with count set to the size of the first stack of \`item\` and levelsSpent 0.`,
    args: z.object({
      item: z.string().min(1),
      name: z
        .string()
        .min(1, `name must be 1-${MAX_NAME_LENGTH} characters`)
        .max(MAX_NAME_LENGTH, `name must be 1-${MAX_NAME_LENGTH} characters: an anvil accepts at most ${MAX_NAME_LENGTH}`)
        .refine((name) => name.trim().length > 0, "name must contain more than spaces"),
    }),
    returns: z.object({ item: z.string(), name: z.string(), count: z.number(), levelsSpent: z.number() }),
  },
  async (ctx, { item, name }) => {
    const { bot } = ctx;
    const itemName = item.replace(/^minecraft:/, "");
    if (!bot.registry.itemsByName[itemName]) throw new Error(`unknown item "${item}": give an item name such as "diamond_sword" (inventory.list shows what you carry)`);
    const stacks = bot.inventory.items().filter((i) => i.name === itemName);
    if (stacks.length === 0) throw new Error(`no ${itemName} in the inventory (inventory.list shows what you carry)`);
    const stack = stacks.find((i) => customNameOf(i) !== name);
    if (!stack) return { item: itemName, name, count: stacks[0]!.count, levelsSpent: 0 };
    const anvil = anvilWithinReach(ctx);
    const creative = bot.game.gameMode === "creative";
    const levelBefore = bot.experience.level;
    const named = () =>
      bot.inventory
        .items()
        .filter((i) => i.name === itemName && customNameOf(i) === name)
        .reduce((n, i) => n + i.count, 0);
    const namedBefore = named();
    const cost = await renameAtAnvil(ctx, anvil, stack, name, levelBefore, creative);
    // The inventory is the server's now: the renamed items may have joined a stack that had the name, or split.
    const count = named() - namedBefore;
    if (count <= 0) throw new Error(`the ${itemName} did not come out of the anvil renamed to ${JSON.stringify(name)}: the inventory holds no more ${itemName} with that name than before, so nothing was renamed`);
    // The experience packet comes with the taken item; levelsSpent is what the level shows once it has.
    if (!creative && cost) await poll(ctx, SETTLE_POLLS, () => bot.experience.level !== levelBefore);
    return { item: itemName, name, count, levelsSpent: levelBefore - bot.experience.level };
  },
);
