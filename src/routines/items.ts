// The items routines: item knowledge — recipes, and the item drops lying on the ground — and renaming an item at an anvil.
import { type Block, type Bot, defineRoutine, type Item, Point, type RoutineContext, within, z } from "minebot-sdk/routine";

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

/** Positions of dropped items within `radius`, nearest first. */
function droppedItems(ctx: RoutineContext, radius: number) {
  return Object.values(ctx.bot.entities)
    .filter((e) => e.name === "item" && e.position.distanceTo(ctx.bot.entity.position) < radius)
    .sort((a, b) => a.position.distanceTo(ctx.bot.entity.position) - b.position.distanceTo(ctx.bot.entity.position))
    .map((e) => e.position.floored());
}

export const recipes = defineRoutine(
  {
    name: "items.recipes",
    description: "Up to 3 recipes for `item`: [{ makes, requiresTable, ingredients: { name: count } }]. Fails for an unknown item.",
    args: z.object({ item: z.string().min(1) }),
    returns: z.array(z.object({ makes: z.number(), requiresTable: z.boolean(), ingredients: z.record(z.string(), z.number()) })),
  },
  (ctx, { item }): RecipeSummary[] => ctx.bot.recipesAll(itemId(ctx, item), null, true).slice(0, 3).map((r) => summarize(ctx, r)),
);

export const drops = defineRoutine(
  {
    name: "items.drops",
    description: "Positions ({x,y,z}) of dropped item entities within `radius`, nearest first — what a dig has left to pick up.",
    args: z.object({ radius: z.number().positive().default(8) }),
    returns: z.array(Point),
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

/**
 * What the anvil window shows for `name`, and what that costs: sends the name, waits for the output
 * slot to carry it, and takes the cost from the window property the server sent with it. The
 * output can show an older name first, so this looks until the wanted one is there.
 */
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

/** The stacks in the player's part of the anvil window: what the server says the inventory holds while the window is open. */
function stacksIn(window: AnvilWindow): Item[] {
  return window.slots.slice(window.inventoryStart, window.inventoryEnd).filter((slot): slot is Item => slot !== null);
}

/**
 * Mineflayer copies the window's inventory part into `bot.inventory` at close, but it takes a stack that
 * differs from the old one only in its name for unchanged, so a renamed stack that lands where a stack of
 * the same item and count was keeps its old name there. This applies what the window showed.
 */
function syncNames(bot: RoutineContext["bot"], window: AnvilWindow): void {
  const offset = window.inventoryStart - bot.inventory.inventoryStart;
  for (let i = window.inventoryStart; i < window.inventoryEnd; i++) {
    const shown = window.slots[i];
    const slot = i - offset;
    if (!shown || customNameOf(shown) === customNameOf(bot.inventory.slots[slot])) continue;
    shown.slot = slot;
    bot.inventory.updateSlot(slot, shown);
  }
}

/**
 * Puts the stack in the anvil, takes the renamed one out, and checks the window shows it in the inventory;
 * whatever the anvil still holds goes back to the inventory before the window closes, whether or not that
 * went well. Resolves with the level cost the anvil showed and the count of the renamed stack.
 */
async function renameAtAnvil(ctx: RoutineContext, anvil: Block, stack: Item, name: string, levelBefore: number, creative: boolean): Promise<{ cost: number | undefined; count: number }> {
  const { bot } = ctx;
  const count = stack.count;
  const window = await within(OPEN_TIMEOUT_MS, `opening the ${anvil.name}`, bot.openBlock(anvil), () => {});
  const costs: { level: number | undefined } = { level: undefined };
  const onBar = (packet: { windowId: number; property: number; value: number }) => {
    if (packet.windowId === window.id && packet.property === COST_PROPERTY) costs.level = packet.value;
  };
  bot._client.on("craft_progress_bar", onBar);
  const renamed = () => stacksIn(window).filter((i) => i.name === stack.name && customNameOf(i) === name);
  const before = renamed().length;
  let failure: { error: unknown } | undefined;
  let result: { cost: number | undefined; count: number } | undefined;
  try {
    if (!/anvil/.test(String(window.type))) throw new Error(`the block opened a ${window.type} window, not an anvil's`);
    await bot.transfer({ window, itemType: stack.type, metadata: stack.metadata, count, sourceStart: window.inventoryStart, sourceEnd: window.inventoryEnd, destStart: INPUT_SLOT, destEnd: INPUT_SLOT + 1 });
    const cost = await offerRename(ctx, window, stack, name, costs);
    if (!creative && cost !== undefined && levelBefore < cost) {
      throw new Error(`renaming the ${stack.name} costs ${levels(cost)} and you have ${levels(levelBefore)}: earn ${levels(cost - levelBefore)} more, then call items.rename again`);
    }
    await within(OPEN_TIMEOUT_MS, `taking the renamed ${stack.name}`, bot.putAway(OUTPUT_SLOT), () => {});
    await poll(ctx, SETTLE_POLLS, () => !window.slots[INPUT_SLOT] && renamed().length > before);
    // The server answers a click it refused after the click resolves; one more look catches that.
    await ctx.sleep(POLL_MS);
    const after = renamed();
    if (after.length <= before) throw new Error(`the ${stack.name} did not come out of the anvil renamed to ${JSON.stringify(name)}: the inventory holds no ${stack.name} with that name, so nothing was renamed`);
    const whole = after.find((i) => i.count === count);
    if (!whole) throw new Error(`the renamed ${stack.name} holds ${after.map((i) => i.count).join(", ")}, not the ${count} it had before`);
    result = { cost, count: whole.count };
  } catch (error) {
    failure = { error };
  }
  let returned: unknown;
  try {
    if (window.slots[INPUT_SLOT]) await within(OPEN_TIMEOUT_MS, `returning the ${stack.name} from the anvil`, bot.putAway(INPUT_SLOT), () => {});
  } catch (error) {
    returned = error;
  } finally {
    bot._client.off("craft_progress_bar", onBar);
    bot.closeWindow(window);
    syncNames(bot, window);
  }
  if (failure) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    if (returned) throw new Error(`${message}; the ${stack.name} could not be taken back out of the anvil either: ${returned instanceof Error ? returned.message : String(returned)}`);
    throw failure.error;
  }
  if (returned || !result) throw returned ?? new Error(`the ${stack.name} was not renamed`);
  return result;
}

export const rename = defineRoutine(
  {
    name: "items.rename",
    description: `Rename the first stack of \`item\` in the inventory to \`name\` (1-${MAX_NAME_LENGTH} characters; spaces are fine) at an anvil within reach (${REACH} blocks; this never walks, so go there first, for example move.to). The cost is experience levels, usually 1 or more; an error names the cost and your level. Returns { item, name, count, levelsSpent }.`,
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
    const stack = bot.inventory.items().find((i) => i.name === itemName);
    if (!stack) throw new Error(`no ${itemName} in the inventory (inventory.list shows what you carry)`);
    const anvil = anvilWithinReach(ctx);
    if (customNameOf(stack) === name) return { item: itemName, name, count: stack.count, levelsSpent: 0 };
    const creative = bot.game.gameMode === "creative";
    const levelBefore = bot.experience.level;
    const { cost, count } = await renameAtAnvil(ctx, anvil, stack, name, levelBefore, creative);
    // The experience packet comes with the taken item; levelsSpent is what the level shows once it has.
    if (!creative && cost) await poll(ctx, SETTLE_POLLS, () => bot.experience.level !== levelBefore);
    return { item: itemName, name, count, levelsSpent: levelBefore - bot.experience.level };
  },
);
