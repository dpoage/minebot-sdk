// The trade routines: reading and buying the offers of villagers and wandering traders. A trade is
// verified by what the inventory gained and lost, not by what the window claims.
import { defineRoutine, type Entity, type Item, type RoutineContext, type Villager, within, z } from "minebot-sdk/routine";
import * as move from "minebot-sdk/routines/move";

export const description = "List and buy the offers of the nearest villager or wandering trader: walk to it, open its trade window, read its offers or trade, and say what the inventory gained and lost.";
export const uses = ["move"] as const;

const MERCHANTS: Record<string, true> = { villager: true, wandering_trader: true };
/** Interaction with an entity reaches about 3 blocks; walking to within 2 leaves room for the merchant to shuffle. */
const WALK_RANGE = 2;
const OPEN_TIMEOUT_MS = 8_000;
const TRADE_BASE_MS = 10_000;
const TRADE_EACH_MS = 2_000;
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

/**
 * Walks to the nearest merchant within `radius` and opens its trade window. Mineflayer's `openVillager`
 * asserts that the entity's type is the villager's, though a wandering trader opens the same merchant
 * window; it is given a view of the merchant that reports the villager type, and the shared entity is
 * not touched.
 */
async function openMerchant(ctx: RoutineContext, radius: number): Promise<{ merchant: string; window: Villager }> {
  const { bot } = ctx;
  const entity = nearestMerchant(ctx, radius);
  if (!entity) throw new Error(`no villager or wandering trader within ${radius} blocks; walk closer with move.to or pass a larger radius`);
  const { x, y, z: zed } = entity.position;
  const merchant = `${entity.name} at ${Math.floor(x)},${Math.floor(y)},${Math.floor(zed)}`;
  await move.to(ctx, { position: { x, y, z: zed }, range: WALK_RANGE });
  const view = Object.create(entity, { entityType: { value: bot.registry.entitiesByName.villager!.id } }) as Entity;
  let expired = false;
  try {
    const window = await within(OPEN_TIMEOUT_MS, `opening the ${merchant}`, bot.openVillager(view), () => {
      expired = true;
    });
    return { merchant, window };
  } catch (error) {
    if (!expired) throw error;
    throw new Error(`the ${merchant} opened no trade window within ${OPEN_TIMEOUT_MS / 1000} s (a nitwit, a baby, a villager without a profession, or one that is asleep or already trading does not trade; one out of reach does not answer); trade works on the nearest merchant, so walk next to another one with move.to to use it`);
  }
}

/** The offer as the window lists it. `give` carries the price the merchant charges this player now: demand and reputation included, not the listed price. */
function offerOf(trade: Villager["trades"][number], index: number): Offer {
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

async function buyOffer(ctx: RoutineContext, index: number, times: number, radius: number) {
  const { bot } = ctx;
  const { merchant, window } = await openMerchant(ctx, radius);
  let plan: Plan;
  let failure: Error | undefined;
  try {
    plan = planBuy(merchant, window.trades.map(offerOf), index, times, totalsOf(window.slots.slice(window.inventoryStart, window.inventoryEnd)));
    try {
      await within(TRADE_BASE_MS + TRADE_EACH_MS * plan.trades, `trading with the ${merchant}`, bot.trade(window, index, plan.trades), () => {});
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      failure = error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    await window.close();
  }

  // The outcome is what the inventory shows once the window is closed and the server has returned what it keeps in the trade slots.
  const { offer, trades, held } = plan;
  const unit = changeOf(offer);
  let delta = difference(held, totalsOf(bot.inventory.items()));
  let traded = wholeTrades(delta, unit, trades);
  for (let waited = 0; traded !== trades && waited < SETTLE_MS; waited += SETTLE_STEP_MS) {
    await ctx.sleep(SETTLE_STEP_MS);
    delta = difference(held, totalsOf(bot.inventory.items()));
    traded = wholeTrades(delta, unit, trades);
  }
  const what = `offer ${index} of the ${merchant}`;
  if (traded === undefined) {
    throw new Error(`${what} was traded, but the inventory changed by ${describeChange(delta)}, which is not a whole number of its trades (one trade changes it by ${describeChange(unit)}); inventory.list shows what it holds now`);
  }
  if (traded === 0) {
    throw new Error(`${what} did not trade${failure ? `: ${failure.message}` : "; the inventory is unchanged (it may be full)"}`);
  }
  const gave: Totals = {};
  const got: Totals = {};
  for (const [item, n] of Object.entries(delta)) {
    if (n < 0) gave[item] = -n;
    else got[item] = n;
  }
  const reasons = [...(plan.limit ? [plan.limit] : []), ...(traded < trades ? [`only ${traded} of ${trades} trades completed${failure ? `: ${failure.message}` : " (the inventory may be full)"}`] : [])];
  ctx.log(`traded ${traded} time${traded === 1 ? "" : "s"} for ${what}: gave ${listOf(gave)}, got ${listOf(got)}`);
  return { traded, gave, got, ...(traded < times && { shortfall: reasons.join("; ") }) };
}

export const offers = defineRoutine(
  {
    name: "trade.offers",
    description:
      "Walk to within 2 blocks of the nearest villager or wandering trader within `radius` (default 8), read its offers, and close the window. Returns [{ index, give: [{ item, count }], get: { item, count }, uses, maxUses, disabled }]: `give` is one or two inputs, with the count the merchant charges you now (demand and reputation included), `get` is what you receive, and `disabled` is true when the offer is sold out. Fails when there is no merchant within `radius`, or the nearest opens no window (a nitwit, a baby, or a villager without a profession).",
    args: z.object({ radius: z.number().positive().default(8) }),
    returns: z.array(Offer),
  },
  (ctx, { radius }) => offersOf(ctx, radius),
);

export const buy = defineRoutine(
  {
    name: "trade.buy",
    description:
      "Walk to within 2 blocks of the nearest villager or wandering trader within `radius` (default 8) and make offer number `index` (from trade.offers) up to `times` times (default 1). Returns { traded, gave: { item: count }, got: { item: count }, shortfall? } measured from the inventory, so it is what actually changed. When fewer than `times` trades happened (the offer ran out of uses, or the inventory ran short of inputs), `shortfall` names why. Fails, naming the cause and the counts, when no trade happens (the offer is sold out, an input is missing, there is no such offer), and when the inventory changed by anything other than whole trades.",
    args: z.object({ index: z.number().int().nonnegative(), times: z.number().int().positive().default(1), radius: z.number().positive().default(8) }),
    returns: z.object({ traded: z.number(), gave: z.record(z.string(), z.number()), got: z.record(z.string(), z.number()), shortfall: z.string().optional() }),
  },
  (ctx, { index, times, radius }) => buyOffer(ctx, index, times, radius),
);
