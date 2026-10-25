// The trade routines: reading and buying the offers of villagers and wandering traders. A trade is
// verified by what the inventory gained and lost, not by what the window claims.
import { type Bot, defineRoutine, type Entity, type Item, type RoutineContext, type Villager, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";

export const description = "List and buy the offers of the nearest villager or wandering trader: walk to it, open its trade window, read its offers or trade, and say what the inventory gained and lost.";
export const uses = ["move"] as const;

const MERCHANTS: Record<string, true> = { villager: true, wandering_trader: true };
/** Interaction with an entity reaches about 3 blocks; walking to within 2 leaves room for the merchant to shuffle. */
const WALK_RANGE = 2;
const OPEN_TIMEOUT_MS = 8_000;
/** How long the server is given to answer one click on the trade window. */
const ANSWER_MS = 3_000;
/** What putting the cursor and the trade slots back into the inventory may take after a stop or a failure: the body gives a stopped run 5 s. */
const CLEANUP_MS = 2_500;
/** The merchant window's slots: two inputs, then the output; the player's inventory follows them. */
const INPUT_SLOTS = [0, 1] as const;
const OUTPUT_SLOT = 2;
/** Window click modes and buttons, as the protocol numbers them. */
const PICKUP = 0;
const QUICK_MOVE = 1;
const QUICK_CRAFT = 5;
/** How long the inventory is given to show the whole outcome after the window closes: the server returns leftover inputs a tick later. */
const SETTLE_MS = 1_500;
const SETTLE_STEP_MS = 100;

type Totals = Record<string, number>;

const Stack = z.object({ item: z.string(), count: z.number() });
const Offer = z.object({
  index: z.number(),
  give: z.array(Stack),
  get: Stack,
  uses: z.number(),
  maxUses: z.number(),
  disabled: z.boolean(),
});
type Offer = z.infer<typeof Offer>;

const totalsOf = (items: readonly (Item | null | undefined)[]): Totals => {
  const totals: Totals = {};
  for (const item of items) if (item) totals[item.name] = (totals[item.name] ?? 0) + item.count;
  return totals;
};

/** `{ wheat: -30, emerald: 1 }` as "-30 wheat, +1 emerald". */
const describeChange = (change: Totals): string => {
  const parts = Object.entries(change).map(([item, n]) => `${n > 0 ? "+" : ""}${n} ${item}`);
  return parts.length === 0 ? "nothing" : parts.join(", ");
};

/** `{ wheat: 30, paper: 24 }` as "30 wheat and 24 paper". */
const listOf = (items: Totals): string => Object.entries(items).map(([item, n]) => `${n} ${item}`).join(" and ");

/** The entity named villager or wandering_trader nearest the bot within `radius`, or undefined. */
function nearestMerchant(ctx: RoutineContext, radius: number): Entity | undefined {
  const { bot } = ctx;
  let nearest: { entity: Entity; distance: number } | undefined;
  for (const entity of Object.values(bot.entities)) {
    if (entity.name === undefined || !MERCHANTS[entity.name]) continue;
    const distance = entity.position.distanceTo(bot.entity.position);
    if (distance <= radius && (nearest === undefined || distance < nearest.distance)) nearest = { entity, distance };
  }
  return nearest?.entity;
}

/** Settles as `work` does, or rejects with `expired()` after `ms`, or with the abort reason once `signal` aborts. */
async function bounded<T>(work: Promise<T>, ms: number, expired: () => Error, signal?: AbortSignal): Promise<T> {
  const stop = Promise.withResolvers<never>();
  const timer = setTimeout(() => stop.reject(expired()), ms);
  const onAbort = () => stop.reject(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await Promise.race([work, stop.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The part of an event emitter that `withListeners` reads: the bot and its protocol client are both one. */
interface Listened {
  eventNames(): (string | symbol)[];
  listeners(event: string | symbol): unknown[];
  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
}

/** Runs `start`, and returns its value with a function that removes every listener `start` added to `emitters`. */
function withListeners<T>(emitters: readonly Listened[], start: () => T): { value: T; remove: () => void } {
  const before = emitters.map((emitter) => new Map(emitter.eventNames().map((event) => [event, new Set(emitter.listeners(event))])));
  const value = start();
  const added = emitters.flatMap((emitter, i) =>
    emitter.eventNames().flatMap((event) =>
      emitter
        .listeners(event)
        .filter((listener) => !before[i]!.get(event)?.has(listener))
        .map((listener) => ({ emitter, event, listener: listener as (...args: unknown[]) => void })),
    ),
  );
  return {
    value,
    remove: () => {
      for (const { emitter, event, listener } of added) emitter.removeListener(event, listener);
    },
  };
}

/**
 * Walks to the nearest merchant within `radius` and opens its trade window. Mineflayer's `openVillager`
 * asserts that the entity's type is the villager's, though a wandering trader opens the same merchant
 * window; it is given a view of the merchant that reports the villager type, and the shared entity is
 * not touched. An open that times out or is stopped leaves nothing behind: Mineflayer's open would keep
 * waiting, and its window and offer listeners would take the next merchant's window and offers as theirs.
 */
async function openMerchant(ctx: RoutineContext, radius: number): Promise<{ merchant: string; window: Villager }> {
  const { bot } = ctx;
  const entity = nearestMerchant(ctx, radius);
  if (!entity) throw new Error(`no villager or wandering trader within ${radius} blocks; walk closer with move.to or pass a larger radius`);
  const { x, y, z: zed } = entity.position;
  const merchant = `${entity.name} at ${Math.floor(x)},${Math.floor(y)},${Math.floor(zed)}`;
  await move.to(ctx, { position: { x, y, z: zed }, range: WALK_RANGE });
  ctx.signal.throwIfAborted();
  const view = Object.create(entity, { entityType: { value: bot.registry.entitiesByName.villager!.id } }) as Entity;
  const before = bot.currentWindow;
  const opening = withListeners([bot as unknown as Listened, bot._client as unknown as Listened], () => bot.openVillager(view));
  try {
    const expired = () =>
      new Error(`the ${merchant} opened no trade window within ${OPEN_TIMEOUT_MS / 1000} s (a nitwit, a baby, a villager without a profession, or one that is asleep or already trading does not trade; one out of reach does not answer); trade works on the nearest merchant, so walk next to another one with move.to to use it`);
    return { merchant, window: await bounded(opening.value, OPEN_TIMEOUT_MS, expired, ctx.signal) };
  } catch (error) {
    opening.remove();
    const late = bot.currentWindow;
    if (late && late !== before) await bot.closeWindow(late);
    throw error;
  }
}

/** An offer as Mineflayer reads it from the merchant's offer list. */
type Trade = Villager["trades"][number];

/** The offer as the window lists it. `give` carries the price the merchant charges this player now: demand and reputation included, not the listed price. */
function offerOf(trade: Trade, index: number): Offer {
  const give = [{ item: trade.inputItem1.name, count: trade.realPrice ?? trade.inputItem1.count }];
  if (trade.hasItem2 && trade.inputItem2) give.push({ item: trade.inputItem2.name, count: trade.inputItem2.count });
  return {
    index,
    give,
    get: { item: trade.outputItem.name, count: trade.outputItem.count },
    uses: trade.nbTradeUses,
    maxUses: trade.maximumNbTradeUses,
    disabled: trade.tradeDisabled || trade.nbTradeUses >= trade.maximumNbTradeUses,
  };
}

/** What one trade of the offer takes from the inventory, by item. */
function costOf(offer: Offer): Totals {
  const cost: Totals = {};
  for (const { item, count } of offer.give) cost[item] = (cost[item] ?? 0) + count;
  return cost;
}

/** What one trade of the offer changes the inventory by: the output gained, the inputs lost; items that net to nothing are left out. */
function changeOf(offer: Offer): Totals {
  const change: Totals = {};
  for (const { item, count } of offer.give) change[item] = (change[item] ?? 0) - count;
  change[offer.get.item] = (change[offer.get.item] ?? 0) + offer.get.count;
  return Object.fromEntries(Object.entries(change).filter(([, n]) => n !== 0));
}

/** What the inventory holds less of, in `held`, than `cost` asks for, as { item: missing }. */
function missing(cost: Totals, held: Totals): Totals {
  return Object.fromEntries(Object.entries(cost).flatMap(([item, n]) => (n > (held[item] ?? 0) ? [[item, n - (held[item] ?? 0)] as const] : [])));
}

/** The number of trades `delta` is, when it is exactly that many times `unit` for a whole number up to `max`; undefined otherwise. */
function wholeTrades(delta: Totals, unit: Totals, max: number): number | undefined {
  const pivot = Object.keys(unit)[0];
  let trades = max;
  if (pivot !== undefined) {
    trades = (delta[pivot] ?? 0) / unit[pivot]!;
    if (!Number.isInteger(trades) || trades < 0 || trades > max) return undefined;
  }
  for (const item of new Set([...Object.keys(delta), ...Object.keys(unit)])) {
    if ((delta[item] ?? 0) !== trades * (unit[item] ?? 0)) return undefined;
  }
  return trades;
}

/** `after` less `before`, by item, without the items that did not change. */
function difference(before: Totals, after: Totals): Totals {
  const delta: Totals = {};
  for (const item of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const n = (after[item] ?? 0) - (before[item] ?? 0);
    if (n !== 0) delta[item] = n;
  }
  return delta;
}

const offersOf = async (ctx: RoutineContext, radius: number): Promise<Offer[]> => {
  const { window } = await openMerchant(ctx, radius);
  try {
    return window.trades.map(offerOf);
  } finally {
    await window.close();
  }
};

/** What `buyOffer` settled before it trades: how many trades to make, and why that is fewer than asked. */
interface Plan {
  offer: Offer;
  trades: number;
  held: Totals;
  /** Set when `trades` is below the `times` asked. */
  limit?: string;
}

/** Throws, naming the cause, unless the offer can be bought at least once; otherwise how many times. */
function planBuy(merchant: string, offers: readonly Offer[], index: number, times: number, held: Totals): Plan {
  const offer = offers[index];
  if (!offer) {
    throw new Error(`the ${merchant} has ${offers.length === 0 ? "no offers (it does not trade)" : offers.length === 1 ? "one offer, numbered 0" : `${offers.length} offers, numbered 0 to ${offers.length - 1}`}, not an offer ${index}; trade.offers lists them`);
  }
  const what = `offer ${index} (${offer.give.map((s) => `${s.count} ${s.item}`).join(" + ")} for ${offer.get.count} ${offer.get.item}) of the ${merchant}`;
  if (offer.uses >= offer.maxUses) {
    throw new Error(`${what} is sold out (${offer.uses} of ${offer.maxUses} uses spent); a villager restocks when it works at its job block, a wandering trader never does`);
  }
  if (offer.disabled) throw new Error(`${what} is disabled by the merchant`);
  const cost = costOf(offer);
  const short = missing(cost, held);
  const affordable = Math.min(...Object.entries(cost).map(([item, n]) => Math.floor((held[item] ?? 0) / n)));
  if (affordable === 0) {
    throw new Error(`${what} needs ${listOf(cost)} per trade, and the inventory lacks ${listOf(short)} (it holds ${Object.keys(cost).map((item) => `${held[item] ?? 0} ${item}`).join(" and ")})`);
  }
  const left = offer.maxUses - offer.uses;
  const trades = Math.min(times, affordable, left);
  const reasons: string[] = [];
  if (affordable < times) reasons.push(`the inventory holds the inputs for ${affordable} trade${affordable === 1 ? "" : "s"} (${listOf(cost)} each)`);
  if (left < times) reasons.push(`the offer had ${left} use${left === 1 ? "" : "s"} left`);
  return { offer, trades, held, ...(reasons.length > 0 && { limit: reasons.join(" and ") }) };
}

/** A slot's contents as the room check sees them: stacks of one `key` merge, up to `max` items. */
interface Cell {
  key: string;
  count: number;
  max: number;
}

/** Items stack when they are the same item with the same components. */
const keyOf = (item: Item): string =>
  `${item.type} ${JSON.stringify((item as Item & { components?: unknown }).components ?? null, (_, value: unknown) => (typeof value === "bigint" ? String(value) : value))}`;

/** Puts `count` of `item` into `cells` as the server's quick move does: onto stacks of it with room, then into empty slots. Returns how many found no room. */
function stowInto(cells: (Cell | null)[], item: Item, count: number): number {
  const key = keyOf(item);
  let left = count;
  for (const cell of cells) {
    if (left === 0) return 0;
    if (cell?.key !== key || cell.count >= cell.max) continue;
    const moved = Math.min(left, cell.max - cell.count);
    cell.count += moved;
    left -= moved;
  }
  for (let i = 0; i < cells.length && left > 0; i++) {
    if (cells[i]) continue;
    const moved = Math.min(left, item.stackSize);
    cells[i] = { key, count: moved, max: item.stackSize };
    left -= moved;
  }
  return left;
}

/** What one trade takes from trade slot `slot`. */
interface Price {
  slot: (typeof INPUT_SLOTS)[number];
  item: Item;
  count: number;
}

/** The part of the bot's event emitter `MerchantWindow` uses for the per-window events Mineflayer's typings leave out. */
interface WindowEvents {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/**
 * The merchant window, driven click by click. Each click goes out with a state id the server never has
 * (-1): the server still makes the click, then answers with the whole window (window_items), so every
 * step waits for the server's own account of the slots instead of predicting it. Mineflayer's
 * `bot.trade` is not used: it waits for the trade slots to show the listed price rather than the one
 * charged, it tosses what finds no room, and nothing stops it.
 */
class MerchantWindow {
  /** Trades the server made: each time the output came onto the cursor. */
  made = 0;
  /** Set when the server closed the window. */
  closed = false;
  readonly window: Villager;
  readonly #bot: Bot;
  /** "35 of 36 slots hold 2240 dirt and 64 emerald": the inventory when the window opened, for the room message. */
  readonly #atOpen: string;
  /** When set, clicks wait for an answer only until then. */
  #deadline: number | undefined;
  readonly #onClose = (window: unknown) => {
    if (window === this.window) this.closed = true;
  };

  constructor(bot: Bot, window: Villager) {
    this.#bot = bot;
    this.window = window;
    const inventory = this.inventory;
    this.#atOpen = `${inventory.filter((item) => item !== null).length} of ${inventory.length} slots hold ${listOf(totalsOf(inventory)) || "nothing"}`;
    bot.on("windowClose", this.#onClose);
  }

  /** The player's inventory as the window shows it. */
  get inventory(): (Item | null)[] {
    return this.window.slots.slice(this.window.inventoryStart, this.window.inventoryEnd);
  }

  /** Clicks `slot` and waits for the server's answer, or until `signal` aborts. */
  async click(slot: number, button: number, mode: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("the merchant closed the trade window");
    const ms = this.#deadline === undefined ? ANSWER_MS : Math.max(1, Math.min(ANSWER_MS, this.#deadline - Date.now()));
    const events = this.#bot as unknown as WindowEvents;
    const answer = Promise.withResolvers<void>();
    const onItems = () => answer.resolve();
    const onClose = () => {
      if (this.closed) answer.reject(new Error("the merchant closed the trade window"));
    };
    events.on(`setWindowItems:${this.window.id}`, onItems);
    events.on("windowClose", onClose);
    try {
      this.#bot._client.write("window_click", { windowId: this.window.id, stateId: -1, slot, mouseButton: button, mode, changedSlots: [], cursorItem: undefined });
      await bounded(answer.promise, ms, () => new Error(`the server did not answer a click on the trade window within ${ms} ms`), signal);
    } finally {
      events.off(`setWindowItems:${this.window.id}`, onItems);
      events.off("windowClose", onClose);
    }
  }

  /** Makes up to `times` trades of offer `index`; returns why it made fewer, or undefined. */
  async trade(index: number, trade: Trade, times: number, signal: AbortSignal): Promise<string | undefined> {
    const { window } = this;
    const prices: Price[] = [{ slot: 0, item: trade.inputItem1, count: trade.realPrice ?? trade.inputItem1.count }];
    if (trade.hasItem2 && trade.inputItem2) prices.push({ slot: 1, item: trade.inputItem2, count: trade.inputItem2.count });
    // Selecting the offer moves up to a stack of each input from the inventory into the trade slots; an empty drag's end changes nothing and brings the server's answer.
    this.#bot._client.write("select_trade", { slot: index });
    await this.click(-999, 2, QUICK_CRAFT, signal);
    while (this.made < times) {
      for (const { slot, item, count } of prices) {
        if (!(await this.#fill(slot, item, count, signal))) return `the inventory ran out of ${item.name}`;
      }
      const output = window.slots[OUTPUT_SLOT];
      if (!output || output.type !== trade.outputItem.type) {
        return `the merchant offered nothing for the ${listOf(totalsOf(INPUT_SLOTS.map((slot) => window.slots[slot]))) || "empty trade slots"} in the trade slots`;
      }
      const full = this.#noRoom(output, prices);
      if (full) return full;
      // A click on the output makes exactly one trade: the output comes onto the cursor and the trade slots pay the price charged.
      await this.click(OUTPUT_SLOT, 0, PICKUP, signal);
      if (window.selectedItem?.type !== output.type) return `the merchant did not hand over the ${output.name}`;
      this.made++;
      await this.#stowCursor(signal);
      if (window.selectedItem) return `the inventory had no room for the ${window.selectedItem.count} ${window.selectedItem.name}`;
    }
    return undefined;
  }

  /**
   * Puts the cursor and the trade slots back into the inventory, taking at most CLEANUP_MS, stopped or
   * not. Returns what is still out of the inventory, and why when a click failed.
   */
  async clear(): Promise<{ left: Totals; cause?: string }> {
    const { window } = this;
    this.#deadline = Date.now() + CLEANUP_MS;
    let cause: string | undefined;
    try {
      // A stop can land between a click and its answer: an empty drag's end brings the window as the server has it now.
      await this.click(-999, 2, QUICK_CRAFT);
      await this.#stowCursor();
      for (const slot of INPUT_SLOTS) if (window.slots[slot]) await this.click(slot, 0, QUICK_MOVE);
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
    }
    return { left: totalsOf([window.selectedItem, ...INPUT_SLOTS.map((slot) => window.slots[slot])]), ...(cause !== undefined && { cause }) };
  }

  /** Closes the window, unless the server did; either way Mineflayer's listeners for it go. */
  async close(): Promise<void> {
    this.#bot.off("windowClose", this.#onClose);
    if (this.closed) this.window.emit("close");
    else await this.window.close();
  }

  /** Tops trade slot `slot` up from the inventory until it holds `count` of `cost`'s item; false when the inventory has too few. */
  async #fill(slot: number, cost: Item, count: number, signal: AbortSignal): Promise<boolean> {
    const { window } = this;
    for (let moves = 0; (window.slots[slot]?.count ?? 0) < count; moves++) {
      const there = window.slots[slot];
      const source = this.inventory.findIndex((item) => item !== null && (there ? keyOf(item) === keyOf(there) : item.type === cost.type));
      if (source < 0 || moves === 3) return false;
      await this.click(window.inventoryStart + source, 0, PICKUP, signal);
      await this.click(slot, 0, PICKUP, signal);
      if (window.selectedItem) await this.click(window.inventoryStart + source, 0, PICKUP, signal);
    }
    return true;
  }

  /** Puts what the cursor holds into the inventory: onto stacks of it with room, then into an empty slot. */
  async #stowCursor(signal?: AbortSignal): Promise<void> {
    const { window } = this;
    for (let clicks = 0; window.selectedItem && clicks < 4; clicks++) {
      const key = keyOf(window.selectedItem);
      const inventory = this.inventory;
      let target = inventory.findIndex((item) => item !== null && keyOf(item) === key && item.count < item.stackSize);
      if (target < 0) target = inventory.indexOf(null);
      if (target < 0) return;
      await this.click(window.inventoryStart + target, 0, PICKUP, signal);
    }
  }

  /** Why the inventory cannot take one more trade's output and then what the trade slots keep after it; undefined when it can. */
  #noRoom(output: Item, prices: readonly Price[]): string | undefined {
    const cells = this.inventory.map((item) => item && { key: keyOf(item), count: item.count, max: item.stackSize });
    const rest: Totals = {};
    let unplaced = stowInto(cells, output, output.count);
    for (const { slot, count } of prices) {
      const there = this.window.slots[slot];
      if (!there || there.count <= count) continue;
      rest[there.name] = (rest[there.name] ?? 0) + there.count - count;
      unplaced += stowInto(cells, there, there.count - count);
    }
    if (unplaced === 0) return undefined;
    const kept = Object.keys(rest).length > 0 ? ` beside the ${listOf(rest)} the trade leaves in the trade slots` : "";
    return `the inventory has no room for the ${output.count} ${output.name} a trade gives${kept} (${this.#atOpen} when the window opened); make room with inventory.toss or by storing items in a chest, then trade again`;
  }
}

async function buyOffer(ctx: RoutineContext, index: number, times: number, radius: number) {
  const { bot } = ctx;
  const { merchant, window } = await openMerchant(ctx, radius);
  const merchantWindow = new MerchantWindow(bot, window);
  let plan: Plan;
  let stop: string | undefined;
  let cleared: { left: Totals; cause?: string };
  try {
    plan = planBuy(merchant, window.trades.map(offerOf), index, times, totalsOf(merchantWindow.inventory));
    try {
      stop = await merchantWindow.trade(index, window.trades[index]!, plan.trades, ctx.signal);
    } catch (error) {
      stop = error instanceof Error ? error.message : String(error);
    }
    cleared = await merchantWindow.clear();
  } finally {
    await merchantWindow.close();
  }

  const what = `offer ${index} of the ${merchant}`;
  const { x, y, z: zed } = bot.entity.position.floored();
  // What stayed in the trade window when it closed: the server returns it, or drops it when the inventory has no room. Only a change that is not whole trades shows a loss.
  const stranded =
    Object.keys(cleared.left).length === 0
      ? ""
      : `; ${listOf(cleared.left)} stayed in the trade window${cleared.cause ? ` (${cleared.cause})` : ""}: the server puts it back into the inventory, or drops it at ${x},${y},${zed} when the inventory is full`;
  if (ctx.signal.aborted) {
    ctx.log(`stopped after ${merchantWindow.made} trade${merchantWindow.made === 1 ? "" : "s"} of ${what}${stranded}`);
    throw ctx.signal.reason;
  }

  // The outcome is what the inventory shows once the window is closed and the server has returned what it keeps in the trade slots.
  // The window confirmed `made` trades; a click whose answer the window's close cut off may have made one more.
  const { offer, trades, held } = plan;
  const { made } = merchantWindow;
  const unit = changeOf(offer);
  let delta = difference(held, totalsOf(bot.inventory.items()));
  let traded = wholeTrades(delta, unit, trades);
  for (let waited = 0; (traded === undefined || traded < made) && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await ctx.sleep(SETTLE_STEP_MS);
    delta = difference(held, totalsOf(bot.inventory.items()));
    traded = wholeTrades(delta, unit, trades);
  }
  if (traded === undefined) {
    throw new Error(`${what} was traded, but the inventory changed by ${describeChange(delta)}, which is not a whole number of its trades (one trade changes it by ${describeChange(unit)})${stranded}; inventory.list shows what it holds now`);
  }
  const why = stop ?? (made === 0 ? "the inventory is unchanged" : `the inventory shows ${traded} of the ${made} trades the window made`);
  if (traded === 0) throw new Error(`${what} did not trade: ${why}`);
  const gave: Totals = {};
  const got: Totals = {};
  for (const [item, n] of Object.entries(delta)) {
    if (n < 0) gave[item] = -n;
    else got[item] = n;
  }
  const reasons = [...(plan.limit ? [plan.limit] : []), ...(traded < trades ? [`only ${traded} of ${trades} trades completed: ${why}`] : [])];
  ctx.log(`traded ${traded} time${traded === 1 ? "" : "s"} for ${what}: gave ${listOf(gave)}, got ${listOf(got)}`);
  return { traded, gave, got, ...(traded < times && { shortfall: reasons.join("; ") }) };
}

export const offers = defineRoutine(
  {
    name: "trade.offers",
    description:
      "Walk to within 2 blocks of the nearest villager or wandering trader within `radius` (default 8), read its offers, and close the window. Returns [{ index, give: [{ item, count }], get: { item, count }, uses, maxUses, disabled }]: `give` is one or two inputs, with the count the merchant charges you now (demand and reputation included), `get` is what you receive, and `disabled` is true when the offer is sold out or switched off by the merchant. Fails when there is no merchant within `radius`, or the nearest opens no window (a nitwit, a baby, or a villager without a profession).",
    args: z.object({ radius: z.number().positive().default(8) }),
    returns: z.array(Offer),
  },
  (ctx, { radius }) => offersOf(ctx, radius),
);

export const buy = defineRoutine(
  {
    name: "trade.buy",
    description:
      "Walk to within 2 blocks of the nearest villager or wandering trader within `radius` (default 8) and make offer number `index` (from trade.offers) up to `times` times (default 1). Returns { traded, gave: { item: count }, got: { item: count }, shortfall? } measured from the inventory, so it is what actually changed. It makes only the trades whose output and leftover inputs fit in the inventory, so nothing is dropped. When fewer than `times` trades happened (the offer ran out of uses, the inventory ran short of inputs or of room), `shortfall` names why. Fails, naming the cause and the counts, when no trade happens (the offer is sold out, an input is missing, the inventory has no room for the output, there is no such offer), and when the inventory changed by anything other than whole trades.",
    args: z.object({ index: z.number().int().nonnegative(), times: z.number().int().positive().default(1), radius: z.number().positive().default(8) }),
    returns: z.object({ traded: z.number(), gave: z.record(z.string(), z.number()), got: z.record(z.string(), z.number()), shortfall: z.string().optional() }),
  },
  (ctx, { index, times, radius }) => buyOffer(ctx, index, times, radius),
);
