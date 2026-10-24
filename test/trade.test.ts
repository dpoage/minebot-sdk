// trade.offers and trade.buy over the harness's fake bot with a merchant window that behaves as Mineflayer's
// does: `openVillager` asserts the villager entity type, `trade` moves the inventory trade by trade. The harness
// has no merchant windows of its own, so the window is set up here; walking up to a real villager and a real
// wandering trader is probed on a dev server.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import type { Entity, Item } from "minebot-sdk/routine";
import { createHarness, type Harness } from "minebot-sdk/testing";
import * as trade from "../src/routines/trade.ts";

/** An offer as the server lists it: the listed first input, and what the merchant charges now when demand or reputation moved it. */
interface Listed {
  give: [string, number];
  give2?: [string, number];
  get: [string, number];
  /** The price charged for the first input: mineflayer's `realPrice`; the listed count when absent. */
  charged?: number;
  uses?: number;
  maxUses?: number;
  disabled?: boolean;
}

interface FakeMerchant {
  /** What `bot.openVillager` was given, in order. */
  opened: Entity[];
  closed: number;
  /** Trades the fake window performs, by call. */
  tradeCalls: { index: number; times: number | undefined }[];
}

interface Faults {
  /** The window throws after this many trades of a call, as a server that closes the window mid-way does. */
  failAfter?: number;
  /** The server takes this much more of an item than the offer says, after the trades. */
  alsoTakes?: [string, number];
}

/** The inventory the harness keeps, as the fake window moves items through it. */
interface Stock {
  make(name: string, count: number): Item;
  add(type: number, count: number): number;
  remove(type: number, count: number): number;
  items(): Item[];
}

/** Gives the harness's bot a villager window over `listed`, with Mineflayer's own checks on the entity type and on `trade`. */
function merchantWindow(h: Harness, listed: readonly Listed[], faults: Faults = {}): FakeMerchant {
  const stock = h.bot.inventory as unknown as Stock;
  const villagerId = h.bot.registry.entitiesByName.villager!.id;
  const seen: FakeMerchant = { opened: [], closed: 0, tradeCalls: [] };
  const stack = (name: string, count: number) => stock.make(name, count);
  const trades = listed.map((offer) => {
    const input = stack(offer.give[0], offer.give[1]);
    return {
      inputItem1: input,
      inputItem2: offer.give2 ? stack(offer.give2[0], offer.give2[1]) : null,
      hasItem2: offer.give2 !== undefined,
      outputItem: stack(offer.get[0], offer.get[1]),
      realPrice: offer.charged ?? offer.give[1],
      nbTradeUses: offer.uses ?? 0,
      maximumNbTradeUses: offer.maxUses ?? 8,
      tradeDisabled: offer.disabled ?? false,
    };
  });
  const bot = h.bot as unknown as Record<string, unknown>;
  bot.openVillager = async (entity: Entity) => {
    // Mineflayer's guard, verbatim in effect.
    assert.strictEqual((entity as Entity & { entityType: number }).entityType, villagerId);
    seen.opened.push(entity);
    const player = stock.items();
    return {
      id: 1,
      trades,
      slots: [null, null, null, ...player, ...Array<null>(36 - player.length).fill(null)],
      inventoryStart: 3,
      inventoryEnd: 39,
      close: async () => {
        seen.closed++;
      },
    };
  };
  bot.trade = async (_window: unknown, index: number, times: number | undefined) => {
    seen.tradeCalls.push({ index, times });
    const chosen = trades[index]!;
    const count = times || chosen.maximumNbTradeUses - chosen.nbTradeUses;
    assert.ok(chosen.maximumNbTradeUses - chosen.nbTradeUses > 0, "trade blocked");
    assert.ok(chosen.maximumNbTradeUses - chosen.nbTradeUses >= count);
    for (let i = 0; i < count; i++) {
      if (i === faults.failAfter) throw new Error("the window was closed by the server");
      const inputs: [Item, number][] = [[chosen.inputItem1, chosen.realPrice]];
      if (chosen.inputItem2) inputs.push([chosen.inputItem2, chosen.inputItem2.count]);
      for (const [item, n] of inputs) assert.equal(stock.remove(item.type, n), n, `Not enough ${item.name} to trade`);
      stock.add(chosen.outputItem.type, chosen.outputItem.count);
      chosen.nbTradeUses++;
    }
    if (faults.alsoTakes) stock.remove(stack(faults.alsoTakes[0], 1).type, faults.alsoTakes[1]);
  };
  return seen;
}

/** A merchant of `kind`, as a running bot knows it: its entity type is the registry id of the kind. */
function spawnMerchant(h: Harness, kind: "villager" | "wandering_trader", at: [number, number, number]): Entity {
  const entity = h.spawn({ name: kind, at });
  return Object.assign(entity, { entityType: h.bot.registry.entitiesByName[kind]!.id });
}

/** The entity's state, for a comparison before and after. */
const stateOf = (entity: Entity): string => JSON.stringify(entity);

const EMERALD_FOR_BREAD: Listed = { give: ["emerald", 1], get: ["bread", 3] };
const WHEAT_FOR_EMERALD: Listed = { give: ["wheat", 20], get: ["emerald", 1] };

describe("trade.offers", () => {
  it("lists the offers of a villager: inputs at the price charged, the output, the uses, and whether it is sold out", async () => {
    const h = createHarness({ inventory: { emerald: 3 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [
      EMERALD_FOR_BREAD,
      { give: ["wheat", 20], charged: 30, get: ["emerald", 1], uses: 2, maxUses: 16 },
      { give: ["emerald", 5], give2: ["paper", 24], get: ["bookshelf", 1], uses: 7, maxUses: 7, disabled: true },
      { give: ["emerald", 1], get: ["clock", 1], uses: 1, maxUses: 1 },
    ]);
    assert.deepEqual(await h.run(trade.offers), [
      { index: 0, give: [{ item: "emerald", count: 1 }], get: { item: "bread", count: 3 }, uses: 0, maxUses: 8, disabled: false },
      { index: 1, give: [{ item: "wheat", count: 30 }], get: { item: "emerald", count: 1 }, uses: 2, maxUses: 16, disabled: false },
      { index: 2, give: [{ item: "emerald", count: 5 }, { item: "paper", count: 24 }], get: { item: "bookshelf", count: 1 }, uses: 7, maxUses: 7, disabled: true },
      { index: 3, give: [{ item: "emerald", count: 1 }], get: { item: "clock", count: 1 }, uses: 1, maxUses: 1, disabled: true },
    ]);
    assert.equal(window.closed, 1, "the window is closed");
    assert.deepEqual(window.tradeCalls, []);
    assert.equal(h.count("emerald"), 3, "reading offers changes nothing");
  });

  it("opens a wandering trader without changing the shared entity: the opener gets a villager-typed view, the entity keeps its own type and fields", async () => {
    const h = createHarness();
    const trader = spawnMerchant(h, "wandering_trader", [2.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    const before = stateOf(trader);
    const type = (trader as Entity & { entityType: number }).entityType;
    assert.notEqual(type, h.bot.registry.entitiesByName.villager!.id);
    assert.equal((await h.run(trade.offers)).length, 1);
    assert.equal(stateOf(trader), before);
    assert.equal((trader as Entity & { entityType: number }).entityType, type);
    assert.equal(window.opened.length, 1);
    const view = window.opened[0] as Entity & { entityType: number };
    assert.equal(view.id, trader.id);
    assert.equal(view.entityType, h.bot.registry.entitiesByName.villager!.id);
    assert.equal(view.position, trader.position, "the view reads the merchant's own position");
  });

  it("opens the nearest merchant within the radius, walking to within 2 blocks of it", async () => {
    const h = createHarness();
    spawnMerchant(h, "villager", [9.5, 64, 0.5]);
    const near = spawnMerchant(h, "wandering_trader", [6.5, 64, 0.5]);
    spawnMerchant(h, "villager", [-7.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    await h.run(trade.offers);
    assert.deepEqual(window.opened.map((entity) => entity.id), [near.id]);
    assert.ok(h.position.distanceTo(near.position) <= 3, `stands ${h.position.distanceTo(near.position)} blocks from the trader`);
  });

  it("fails naming the radius when no merchant is within it, and for a creature that is not one", async () => {
    const h = createHarness({ entities: [{ name: "cow", at: [1.5, 64, 0.5] }] });
    spawnMerchant(h, "villager", [20.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    await assert.rejects(h.run(trade.offers), /no villager or wandering trader within 8 blocks/);
    await assert.rejects(h.run(trade.buy, { index: 0, radius: 12 }), /no villager or wandering trader within 12 blocks/);
    assert.equal((await h.run(trade.offers, { radius: 25 })).length, 1);
    assert.equal(window.opened.length, 1);
  });

  it("fails naming the merchant and why when it opens no trade window, as a nitwit does", async (t) => {
    const h = createHarness();
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    (h.bot as unknown as Record<string, unknown>).openVillager = () => Promise.withResolvers().promise;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assert.rejects(h.run(trade.offers), /^Error: the villager at 3,64,0 opened no trade window within 8 s \(a nitwit, a baby, .* does not trade;.*\); trade works on the nearest merchant/);
    for (let i = 0; i < 20; i++) {
      await nextTick();
      t.mock.timers.tick(1_000);
    }
    await result;
  });
});

describe("trade.buy", () => {
  it("trades `times` times and reports what the inventory gained and lost", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), { traded: 3, gave: { emerald: 3 }, got: { bread: 9 } });
    assert.deepEqual(h.inventory, { emerald: 7, bread: 9 });
    assert.deepEqual(window.tradeCalls, [{ index: 0, times: 3 }]);
    assert.equal(window.closed, 1);
    assert.deepEqual(await h.run(trade.buy, { index: 0 }), { traded: 1, gave: { emerald: 1 }, got: { bread: 3 } });
  });

  it("reports both inputs of a two-input offer", async () => {
    const h = createHarness({ inventory: { emerald: 12, paper: 30 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [{ give: ["emerald", 5], give2: ["paper", 24], get: ["bookshelf", 1] }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0 }), { traded: 1, gave: { emerald: 5, paper: 24 }, got: { bookshelf: 1 } });
    assert.deepEqual(h.inventory, { emerald: 7, paper: 6, bookshelf: 1 });
  });

  it("trades a wandering trader's offer", async () => {
    const h = createHarness({ inventory: { emerald: 4 } });
    spawnMerchant(h, "wandering_trader", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 2 }), { traded: 2, gave: { emerald: 2 }, got: { bread: 6 } });
  });

  it("fails without trading, naming the missing inputs and what the inventory holds, when it cannot afford one trade", async () => {
    const h = createHarness({ inventory: { wheat: 12 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [WHEAT_FOR_EMERALD, { give: ["emerald", 5], give2: ["paper", 24], get: ["bookshelf", 1] }]);
    await assert.rejects(h.run(trade.buy, { index: 0 }), /offer 0 .*needs 20 wheat per trade, and the inventory lacks 8 wheat \(it holds 12 wheat\)/);
    await assert.rejects(h.run(trade.buy, { index: 1 }), /needs 5 emerald and 24 paper per trade, and the inventory lacks 5 emerald and 24 paper \(it holds 0 emerald and 0 paper\)/);
    assert.deepEqual(window.tradeCalls, [], "nothing was offered to the server");
    assert.equal(window.closed, 2, "the window is closed on a refusal too");
    assert.deepEqual(h.inventory, { wheat: 12 });
  });

  it("checks the inputs against the price charged, not the listed one: a demand-priced offer trades at 30 wheat and is refused at 25", async () => {
    const demand: Listed = { give: ["wheat", 20], charged: 30, get: ["emerald", 1] };
    const poor = createHarness({ inventory: { wheat: 25 } });
    spawnMerchant(poor, "villager", [3.5, 64, 0.5]);
    merchantWindow(poor, [demand]);
    await assert.rejects(poor.run(trade.buy, { index: 0 }), /needs 30 wheat per trade, and the inventory lacks 5 wheat \(it holds 25 wheat\)/);

    const h = createHarness({ inventory: { wheat: 64 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [demand]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 2 }), { traded: 2, gave: { wheat: 60 }, got: { emerald: 2 } });
    assert.deepEqual(h.inventory, { wheat: 4, emerald: 2 });
  });

  it("returns the trades it made with a shortfall when the offer runs out of uses first", async () => {
    const h = createHarness({ inventory: { emerald: 20 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [{ ...EMERALD_FOR_BREAD, uses: 6, maxUses: 8 }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 5 }), { traded: 2, gave: { emerald: 2 }, got: { bread: 6 }, shortfall: "the offer had 2 uses left" });
    assert.deepEqual(window.tradeCalls, [{ index: 0, times: 2 }]);
    await assert.rejects(h.run(trade.buy, { index: 0 }), /offer 0 .* is sold out \(8 of 8 uses spent\); a villager restocks .* a wandering trader never does/);
  });

  it("returns the trades it made with a shortfall when the inputs run short", async () => {
    const h = createHarness({ inventory: { emerald: 7 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [{ give: ["emerald", 3], get: ["bread", 1] }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 4 }), { traded: 2, gave: { emerald: 6 }, got: { bread: 2 }, shortfall: "the inventory holds the inputs for 2 trades (3 emerald each)" });
  });

  it("names both reasons when both limit the trades", async () => {
    const h = createHarness({ inventory: { emerald: 2 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [{ ...EMERALD_FOR_BREAD, uses: 7 }]);
    const result = await h.run(trade.buy, { index: 0, times: 3 });
    assert.deepEqual(result, { traded: 1, gave: { emerald: 1 }, got: { bread: 3 }, shortfall: "the inventory holds the inputs for 2 trades (1 emerald each) and the offer had 1 use left" });
  });

  it("refuses a disabled offer, and an offer that does not exist, naming the numbers that do", async () => {
    const h = createHarness({ inventory: { emerald: 9 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD, { ...EMERALD_FOR_BREAD, disabled: true }]);
    await assert.rejects(h.run(trade.buy, { index: 1 }), /offer 1 .* is disabled by the merchant/);
    await assert.rejects(h.run(trade.buy, { index: 2 }), /has 2 offers, numbered 0 to 1, not an offer 2; trade\.offers lists them/);
    await assert.rejects(h.run(trade.buy, { index: -1 }), /arguments/);
    assert.deepEqual(window.tradeCalls, []);
    assert.equal(window.closed, 2);
  });

  it("keeps the trades that happened when the window fails part way: a shortfall carrying the cause", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD], { failAfter: 2 });
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 4 }), {
      traded: 2,
      gave: { emerald: 2 },
      got: { bread: 6 },
      shortfall: "only 2 of 4 trades completed: the window was closed by the server",
    });
  });

  it("fails naming the cause when no trade happened despite the window's answer", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD], { failAfter: 0 });
    await assert.rejects(h.run(trade.buy, { index: 0, times: 2 }), /offer 0 of the villager at .* did not trade: the window was closed by the server/);
    assert.equal(window.closed, 1);
    assert.equal(h.count("emerald"), 10);
  });

  it("fails with the measured change when the inventory changed by anything but whole trades", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD], { alsoTakes: ["emerald", 1] });
    await assert.rejects(
      h.run(trade.buy, { index: 0, times: 2 }),
      /was traded, but the inventory changed by -3 emerald, \+6 bread, which is not a whole number of its trades \(one trade changes it by -1 emerald, \+3 bread\)/,
    );
  });

  it("reads the outcome from the inventory, not from the number of trades it asked for", async () => {
    // A server that completes 1 of the 3 trades and says nothing: the window call returns, the inventory shows one.
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    const tradeOnce = h.bot.trade;
    (h.bot as unknown as Record<string, unknown>).trade = (w: never, index: number) => tradeOnce(w, index, 1);
    const result = await h.run(trade.buy, { index: 0, times: 3 });
    assert.deepEqual(result, { traded: 1, gave: { emerald: 1 }, got: { bread: 3 }, shortfall: "only 1 of 3 trades completed (the inventory may be full)" });
    assert.equal(window.tradeCalls.length, 1);
  });
});
