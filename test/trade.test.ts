// trade.offers and trade.buy over the harness's fake bot with a merchant window whose server side behaves
// as the vanilla server's does: `openVillager` asserts the villager entity type (Mineflayer's guard), selecting
// an offer moves the inputs into the trade slots, a click on the output makes one trade at the price charged,
// and what the trade slots and the cursor hold when the window closes goes back to the inventory or onto the
// ground. The harness has no merchant windows of its own, so the window is set up here; walking up to a real
// villager and a real wandering trader is probed on a dev server.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  /** Windows the routine closed. */
  closed: number;
  /** Offers selected in the window, in order: an offer is only traded after it is selected. */
  selected: number[];
  /** What the server dropped on the ground for want of room in the inventory. */
  dropped: Record<string, number>;
}

interface Faults {
  /** The server closes the window once it has made this many trades, as when the merchant is hurt or walks off. */
  closeAfter?: number;
  /** The server closes the window on the click that follows this many answered trades, so no click is left unanswered. */
  closeAfterAnswered?: number;
  /** The server closes the window without syncing anything back, as a connection that drops the close's packets would. */
  noSyncOnClose?: boolean;
  /** The server stops offering the output once it has made this many trades, and says nothing. */
  refuseAfter?: number;
  /** The server takes this much more of an item when the window closes. */
  takesOnClose?: [string, number];
  /** Runs after the server handles each click, with the trades made so far. */
  onClick?: (made: number) => void;
}

/** The inventory the harness keeps, as the fake server moves items through it. */
interface Stock {
  readonly slots: (Item | null)[];
  make(name: string, count: number): Item;
  remove(type: number, count: number): number;
  set(slot: number, item: Item | null): void;
}

/** The merchant window's slots 3-38 are the player's inventory, which the inventory numbers 9-44. */
const INVENTORY_OFFSET = 6;
const PLAYER_START = 3;
const PLAYER_END = 39;

/** Gives the harness's bot a villager window over `listed`, with a server side that trades as the vanilla server does. */
function merchantWindow(h: Harness, listed: readonly Listed[], faults: Faults = {}): FakeMerchant {
  const stock = h.bot.inventory as unknown as Stock;
  const bot = h.bot as unknown as EventEmitter & Record<string, unknown>;
  const client = h.bot._client as unknown as EventEmitter & { write: (name: string, packet: Record<string, number>) => void };
  const villagerId = h.bot.registry.entitiesByName.villager!.id;
  const seen: FakeMerchant = { opened: [], closed: 0, selected: [], dropped: {} };
  const copy = (item: Item | null | undefined, count = item?.count ?? 0): Item | null => (item && count > 0 ? stock.make(item.name, count) : null);
  const trades = listed.map((offer) => ({
    inputItem1: stock.make(offer.give[0], offer.give[1]),
    inputItem2: offer.give2 ? stock.make(offer.give2[0], offer.give2[1]) : null,
    hasItem2: offer.give2 !== undefined,
    outputItem: stock.make(offer.get[0], offer.get[1]),
    realPrice: offer.charged ?? offer.give[1],
    nbTradeUses: offer.uses ?? 0,
    maximumNbTradeUses: offer.maxUses ?? 8,
    tradeDisabled: offer.disabled ?? false,
  }));

  // The server's side of the open window.
  let slots: (Item | null)[] = [];
  let cursor: Item | null = null;
  let selected = -1;
  let open = false;
  let made = 0;
  let window: (EventEmitter & { id: number; slots: (Item | null)[]; selectedItem: Item | null }) | undefined;
  /** The player slots the server's close moved returned items into: the live server syncs those, and only those, back. */
  let returnedTo: number[] = [];

  const drop = (item: Item) => {
    seen.dropped[item.name] = (seen.dropped[item.name] ?? 0) + item.count;
  };
  /** Moves `item` into the player's slots as a quick move does, onto stacks of it first; returns what found no room. */
  const toPlayer = (item: Item): Item | null => {
    let left = item.count;
    for (let s = PLAYER_START; s < PLAYER_END && left > 0; s++) {
      const there = slots[s];
      if (!there || there.type !== item.type || there.count >= there.stackSize) continue;
      const n = Math.min(left, there.stackSize - there.count);
      there.count += n;
      left -= n;
      returnedTo.push(s);
    }
    for (let s = PLAYER_START; s < PLAYER_END && left > 0; s++) {
      if (slots[s]) continue;
      const n = Math.min(left, item.stackSize);
      slots[s] = copy(item, n);
      left -= n;
      returnedTo.push(s);
    }
    return copy(item, left);
  };
  const refreshOutput = () => {
    const offer = trades[selected];
    const [a, b] = slots;
    const paid = offer && a?.type === offer.inputItem1.type && a.count >= offer.realPrice && (!offer.inputItem2 || (b?.type === offer.inputItem2.type && b.count >= offer.inputItem2.count));
    const selling = offer && !offer.tradeDisabled && offer.nbTradeUses < offer.maximumNbTradeUses && !(faults.refuseAfter !== undefined && made >= faults.refuseAfter);
    slots[2] = paid && selling ? copy(offer.outputItem) : null;
  };
  const pay = (slot: number, count: number) => {
    const item = slots[slot]!;
    item.count -= count;
    if (item.count === 0) slots[slot] = null;
  };
  /** Fills trade slot `slot` with `type` from the player's slots, up to a stack. */
  const fill = (slot: number, type: number) => {
    for (let s = PLAYER_START; s < PLAYER_END; s++) {
      const item = slots[s];
      if (!item || item.type !== type) continue;
      const has = slots[slot]?.count ?? 0;
      const n = Math.min(item.stackSize - has, item.count);
      if (n <= 0) return;
      slots[slot] = copy(item, has + n);
      item.count -= n;
      if (item.count === 0) slots[s] = null;
    }
  };
  const select = (index: number) => {
    seen.selected.push(index);
    selected = index;
    for (const slot of [0, 1]) {
      const item = slots[slot];
      if (!item) continue;
      slots[slot] = toPlayer(item);
      if (slots[slot]) return;
    }
    const offer = trades[index]!;
    fill(0, offer.inputItem1.type);
    if (offer.inputItem2) fill(1, offer.inputItem2.type);
    refreshOutput();
  };
  const click = (slot: number, button: number, mode: number) => {
    if (mode === 5) return; // the end of a drag that never started
    assert.equal(button, 0, `click with button ${button}`);
    if (mode === 1) {
      assert.ok(slot === 0 || slot === 1, `quick move on slot ${slot}`);
      slots[slot] = slots[slot] ? toPlayer(slots[slot]) : null;
      refreshOutput();
      return;
    }
    assert.equal(mode, 0, `click mode ${mode}`);
    if (slot === -999) {
      if (cursor) drop(cursor);
      cursor = null;
      return;
    }
    if (slot === 2) {
      const output = slots[2];
      if (!output || (cursor && (cursor.type !== output.type || cursor.count + output.count > cursor.stackSize))) return;
      cursor = copy(output, (cursor?.count ?? 0) + output.count);
      const offer = trades[selected]!;
      pay(0, offer.realPrice);
      if (offer.inputItem2) pay(1, offer.inputItem2.count);
      offer.nbTradeUses++;
      made++;
      refreshOutput();
      return;
    }
    const there = slots[slot] ?? null;
    if (!cursor) {
      cursor = there;
      slots[slot] = null;
    } else if (!there) {
      slots[slot] = cursor;
      cursor = null;
    } else if (there.type === cursor.type) {
      const n = Math.min(cursor.count, there.stackSize - there.count);
      there.count += n;
      cursor.count -= n;
      if (cursor.count === 0) cursor = null;
    } else {
      slots[slot] = cursor;
      cursor = there;
    }
    if (slot < 2) refreshOutput();
  };
  /**
   * The server ends the session: the trade slots and the cursor go back to the inventory, or onto
   * the ground. What the client learns depends on who closed: its own close copies the window it
   * last saw (Mineflayer's close does) and the server syncs what its close changed; a server close
   * only syncs — Mineflayer's handler for it copies nothing, which is what the routine has to make
   * up for — and the syncs land after the close, as the live server's do.
   */
  const finish = (by: "client" | "server") => {
    open = false;
    returnedTo = [];
    for (const item of [slots[0], slots[1], cursor]) {
      const left = item && toPlayer(item);
      if (left) drop(left);
    }
    slots[0] = slots[1] = slots[2] = cursor = null;
    const sync = () => {
      for (const s of returnedTo) stock.set(s + INVENTORY_OFFSET, copy(slots[s]));
      if (faults.takesOnClose) stock.remove(stock.make(faults.takesOnClose[0], 1).type, faults.takesOnClose[1]);
    };
    if (by === "client") {
      for (let s = PLAYER_START; s < PLAYER_END; s++) stock.set(s + INVENTORY_OFFSET, copy(window?.slots[s] ?? null));
      sync();
    } else if (!faults.noSyncOnClose) {
      setImmediate(sync);
    }
  };
  let closing = false;
  client.write = (name, packet) => {
    assert.ok(open, `${name} sent with no trade window open`);
    if (name === "select_trade") return select(packet.slot!);
    if (closing) {
      finish("server");
      bot.currentWindow = null;
      bot.emit("windowClose", window);
      return;
    }
    assert.equal(name, "window_click", `unexpected packet ${name}`);
    click(packet.slot!, packet.mouseButton!, packet.mode!);
    faults.onClick?.(made);
    if (faults.closeAfter !== undefined && made >= faults.closeAfter) {
      finish("server");
      bot.currentWindow = null;
      bot.emit("windowClose", window);
      return;
    }
    if (faults.closeAfterAnswered !== undefined && made >= faults.closeAfterAnswered) closing = true;
    // The answer to a click whose state id the server does not have: the whole window, a moment later.
    setImmediate(() => {
      if (!open || !window) return;
      window.slots = slots.map((item) => copy(item));
      window.selectedItem = copy(cursor);
      bot.emit(`setWindowItems:${window.id}`);
    });
  };
  bot.openVillager = async (entity: Entity) => {
    // Mineflayer's guard, verbatim in effect.
    assert.strictEqual((entity as Entity & { entityType: number }).entityType, villagerId);
    seen.opened.push(entity);
    slots = [null, null, null];
    for (let s = PLAYER_START; s < PLAYER_END; s++) slots.push(copy(stock.slots[s + INVENTORY_OFFSET]));
    cursor = null;
    selected = -1;
    made = 0;
    closing = false;
    open = true;
    // Mineflayer's offer listener, which only the window's close event removes.
    const onTrades = () => {};
    client.on("trade_list", onTrades);
    const opened = Object.assign(new EventEmitter(), {
      id: 1,
      type: "minecraft:merchant",
      trades,
      slots: slots.map((item) => copy(item)),
      selectedItem: null as Item | null,
      inventoryStart: PLAYER_START,
      inventoryEnd: PLAYER_END,
      close: async () => {
        seen.closed++;
        bot.currentWindow = null;
        if (open) finish("client");
        opened.emit("close");
      },
    });
    opened.once("close", () => client.off("trade_list", onTrades));
    window = opened;
    bot.currentWindow = opened;
    return opened;
  };
  return seen;
}

/** A merchant of `kind`, as a running bot knows it: its entity type is the registry id of the kind. */
function spawnMerchant(h: Harness, kind: "villager" | "wandering_trader", at: [number, number, number]): Entity {
  const entity = h.spawn({ name: kind, at });
  return Object.assign(entity, { entityType: h.bot.registry.entitiesByName[kind]!.id });
}

/** A merchant whose window never opens, as a nitwit's: Mineflayer's open waits for a window and for an offer list. Resolves once the open starts. */
function silentMerchant(h: Harness): Promise<void> {
  const bot = h.bot as unknown as EventEmitter & Record<string, unknown>;
  const started = Promise.withResolvers<void>();
  bot.openVillager = () => {
    bot.on("windowOpen", () => {});
    (h.bot._client as unknown as EventEmitter).on("trade_list", () => {});
    started.resolve();
    return Promise.withResolvers().promise;
  };
  return started.promise;
}

/** The listeners an open leaves on the bot and its client: Mineflayer's window and offer listeners. */
const openListeners = (h: Harness) => ({ windowOpen: h.bot.listenerCount("windowOpen"), trade_list: (h.bot._client as unknown as EventEmitter).listenerCount("trade_list") });

/** The entity's state, for a comparison before and after. */
const stateOf = (entity: Entity): string => JSON.stringify(entity);

const EMERALD_FOR_BREAD: Listed = { give: ["emerald", 1], get: ["bread", 3] };
const WHEAT_FOR_EMERALD: Listed = { give: ["wheat", 20], get: ["emerald", 1] };
const SWORD: Listed = { give: ["emerald", 3], get: ["iron_sword", 1] };

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
    assert.deepEqual(window.selected, []);
    assert.equal(h.count("emerald"), 3, "reading offers changes nothing");
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 });
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

  it("fails naming the merchant and why when it opens no trade window, as a nitwit does, and leaves no listener behind for the next merchant", async (t) => {
    const h = createHarness();
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    silentMerchant(h);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assert.rejects(h.run(trade.offers), /^Error: the villager at 3,64,0 opened no trade window within 8 s \(a nitwit, a baby, .* does not trade;.*\); trade works on the nearest merchant/);
    for (let i = 0; i < 20; i++) {
      await nextTick();
      t.mock.timers.tick(1_000);
    }
    await result;
    t.mock.timers.reset();
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 }, "the open's window and offer listeners are gone");
    merchantWindow(h, [EMERALD_FOR_BREAD]);
    assert.deepEqual(await h.run(trade.offers), [{ index: 0, give: [{ item: "emerald", count: 1 }], get: { item: "bread", count: 3 }, uses: 0, maxUses: 8, disabled: false }]);
  });

  it("stops waiting for the window when the run is stopped, and leaves no listener behind once its late-window watch ends", async (t) => {
    const h = createHarness();
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const opening = silentMerchant(h);
    const stopped = new Error("stopped by the test");
    const run = h.run(trade.offers);
    await opening;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    h.abort(stopped);
    await assert.rejects(run, (error) => error === stopped);
    // The open's own listeners go at once; the watch for a window the server may still send lasts past the run, then goes too.
    assert.equal((h.bot._client as unknown as EventEmitter).listenerCount("trade_list"), 0);
    assert.equal(h.bot.listenerCount("windowOpen"), 1, "still watching for a late window");
    t.mock.timers.tick(2_000);
    t.mock.timers.reset();
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 });
  });

  it("closes a merchant window that opens after a stopped open, and stops watching once it has", async () => {
    const h = createHarness();
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const opening = silentMerchant(h);
    const stopped = new Error("stopped by the test");
    const run = h.run(trade.offers);
    await opening;
    h.abort(stopped);
    await assert.rejects(run, (error) => error === stopped);
    const bot = h.bot as unknown as EventEmitter & Record<string, unknown>;
    const watching = h.bot.listenerCount("windowOpen");
    // The window the server sends after the open was stopped: Mineflayer's open_window handler takes it, and nothing of the run is waiting for it.
    let closed = 0;
    const late = Object.assign(new EventEmitter(), {
      type: "minecraft:merchant",
      close: async () => {
        closed++;
        bot.currentWindow = null;
        late.emit("close");
      },
    });
    bot.currentWindow = late;
    bot.emit("windowOpen", late);
    await nextTick();
    assert.equal(closed, 1, "the late window is closed, or the server keeps the trade session and the merchant will not open again");
    assert.equal(bot.currentWindow, null);
    assert.equal(h.bot.listenerCount("windowOpen"), watching - 1, "the watch ends with the window it closed");
  });

  it("closes a merchant window a stopped call left open before opening its own", async () => {
    const h = createHarness();
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const bot = h.bot as unknown as EventEmitter & Record<string, unknown>;
    let closed = 0;
    const stray = Object.assign(new EventEmitter(), {
      type: "minecraft:merchant",
      close: async () => {
        closed++;
        bot.currentWindow = null;
        stray.emit("close");
      },
    });
    bot.currentWindow = stray;
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    assert.equal((await h.run(trade.offers)).length, 1);
    assert.equal(closed, 1, "the stray window is closed first, or the server will not open another over it");
    assert.equal(window.opened.length, 1);
    assert.equal(bot.currentWindow, null);
  });
});

describe("trade.buy", () => {
  it("trades `times` times and reports what the inventory gained and lost", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), { traded: 3, gave: { emerald: 3 }, got: { bread: 9 } });
    assert.deepEqual(h.inventory, { emerald: 7, bread: 9 });
    assert.deepEqual(window.selected, [0]);
    assert.equal(window.closed, 1);
    assert.deepEqual(await h.run(trade.buy, { index: 0 }), { traded: 1, gave: { emerald: 1 }, got: { bread: 3 } });
    assert.deepEqual(window.dropped, {});
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 });
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
    assert.deepEqual(window.selected, [], "nothing was offered to the server");
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

  it("tops the trade slots up to the price charged when it is above the listed one, so every planned trade happens", async () => {
    // Listed 20, charged 40: after one trade the 24 wheat left in the trade slot covers the listed price but not the charged one.
    const h = createHarness({ inventory: { wheat: 128 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [{ give: ["wheat", 20], charged: 40, get: ["emerald", 1] }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), { traded: 3, gave: { wheat: 120 }, got: { emerald: 3 } });
    assert.deepEqual(h.inventory, { wheat: 8, emerald: 3 });
    assert.deepEqual(window.dropped, {});
  });

  it("fills the trade slot from as many small stacks as it takes: 27 stacks of 5 at a price of 30 all trade", async () => {
    // The server's select fills the slot with a whole stack; after two trades of 30, 4 remain and
    // topping up to the charged price takes six moves of five, not three.
    const h = createHarness();
    const stock = h.bot.inventory as unknown as Stock;
    for (let slot = 9; slot < 36; slot++) stock.set(slot, stock.make("wheat", 5));
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [{ give: ["wheat", 20], charged: 30, get: ["emerald", 1] }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 4 }), { traded: 4, gave: { wheat: 120 }, got: { emerald: 4 } });
    assert.deepEqual(h.inventory, { wheat: 15, emerald: 4 });
    assert.deepEqual(window.dropped, {});
  });

  it("refuses up front, naming the full inventory, when one trade's output and the inputs it leaves cannot fit; nothing is traded or dropped", async () => {
    const h = createHarness({ inventory: { dirt: 35 * 64, emerald: 64 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [SWORD]);
    await assert.rejects(
      h.run(trade.buy, { index: 0, times: 3 }),
      /^Error: offer 0 of the villager at 3,64,0 did not trade: the inventory has no room for the 1 iron_sword a trade gives beside the 61 emerald the trade leaves in the trade slots \(36 of 36 slots hold 2240 dirt and 64 emerald when the window opened\); make room with inventory\.toss or by storing items in a chest, then trade again$/,
    );
    assert.deepEqual(h.inventory, { dirt: 2240, emerald: 64 });
    assert.deepEqual(window.dropped, {});
  });

  it("makes the trades that fit and names the room as the shortfall, dropping nothing", async () => {
    const h = createHarness({ inventory: { dirt: 34 * 64, emerald: 9 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [SWORD]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), {
      traded: 1,
      gave: { emerald: 3 },
      got: { iron_sword: 1 },
      shortfall:
        "only 1 of 3 trades completed: the inventory has no room for the 1 iron_sword a trade gives beside the 3 emerald the trade leaves in the trade slots (35 of 36 slots hold 2176 dirt and 9 emerald when the window opened); make room with inventory.toss or by storing items in a chest, then trade again",
    });
    assert.deepEqual(h.inventory, { dirt: 2176, emerald: 6, iron_sword: 1 });
    assert.deepEqual(window.dropped, {});
  });

  it("reports every trade of a nearly full inventory as completed when the outputs fit, counting room on stacks of the output", async () => {
    const h = createHarness({ inventory: { dirt: 31 * 64, emerald: 4 } });
    spawnMerchant(h, "wandering_trader", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [{ give: ["emerald", 1], get: ["blue_ice", 1] }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 2 }), { traded: 2, gave: { emerald: 2 }, got: { blue_ice: 2 } });
    assert.deepEqual(h.inventory, { dirt: 1984, emerald: 2, blue_ice: 2 });
    assert.deepEqual(window.dropped, {});

    // Every slot full: the outputs go onto the blue ice stack, the emeralds left over back into their own slot.
    const full = createHarness({ inventory: { dirt: 34 * 64, blue_ice: 10, emerald: 4 } });
    spawnMerchant(full, "wandering_trader", [3.5, 64, 0.5]);
    const fullWindow = merchantWindow(full, [{ give: ["emerald", 1], get: ["blue_ice", 1] }]);
    assert.deepEqual(await full.run(trade.buy, { index: 0, times: 2 }), { traded: 2, gave: { emerald: 2 }, got: { blue_ice: 2 } });
    assert.deepEqual(full.inventory, { dirt: 2176, blue_ice: 12, emerald: 2 });
    assert.deepEqual(fullWindow.dropped, {});
  });

  it("stops trading when the run is stopped, puts the cursor and the trade slots back, and closes the window", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const stopped = new Error("stopped by the test");
    let aborted = false;
    const window = merchantWindow(h, [EMERALD_FOR_BREAD], {
      onClick: (made) => {
        if (made === 2 && !aborted) {
          aborted = true;
          h.abort(stopped);
        }
      },
    });
    await assert.rejects(h.run(trade.buy, { index: 0, times: 6 }), (error) => error === stopped);
    assert.deepEqual(h.inventory, { emerald: 8, bread: 6 }, "two trades, and everything back in the inventory");
    assert.deepEqual(window.dropped, {});
    assert.equal(window.closed, 1);
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 });
  });

  it("returns the trades it made with a shortfall when the offer runs out of uses first", async () => {
    const h = createHarness({ inventory: { emerald: 20 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [{ ...EMERALD_FOR_BREAD, uses: 6, maxUses: 8 }]);
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 5 }), { traded: 2, gave: { emerald: 2 }, got: { bread: 6 }, shortfall: "the offer had 2 uses left" });
    assert.deepEqual(window.selected, [0]);
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
    assert.deepEqual(window.selected, []);
    assert.equal(window.closed, 2);
  });

  it("keeps the trades that happened when the merchant closes the window part way: a shortfall carrying the cause", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [EMERALD_FOR_BREAD], { closeAfter: 2 });
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 4 }), {
      traded: 2,
      gave: { emerald: 2 },
      got: { bread: 6 },
      shortfall: "only 2 of 4 trades completed: the merchant closed the trade window",
    });
    assert.deepEqual(h.inventory, { emerald: 8, bread: 6 });
    assert.deepEqual(window.dropped, {});
    assert.deepEqual(openListeners(h), { windowOpen: 0, trade_list: 0 }, "a window the server closed lets Mineflayer's listener go too");
  });

  it("leaves the inventory exactly as the server has it after the server closes the window: the trades' outputs are in the model, not only what the close synced", async () => {
    // The server syncs the slots its close touched (the returned inputs); the outputs the trades
    // stowed before the close reach the model only through the routine's resync from the window.
    const h = createHarness({ inventory: { wheat: 90 } }); // a full stack the select takes, and a partial one the close returns onto
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    const window = merchantWindow(h, [WHEAT_FOR_EMERALD], { closeAfter: 2 });
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 4 }), {
      traded: 2,
      gave: { wheat: 40 },
      got: { emerald: 2 },
      shortfall: "only 2 of 4 trades completed: the merchant closed the trade window",
    });
    assert.deepEqual(h.inventory, { wheat: 50, emerald: 2 });
    assert.deepEqual(window.dropped, {});
  });

  it("models the return itself when the server closes the window without syncing anything back", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    // Two trades are answered and stowed; the close lands on the next click, so nothing is left mid-trade, and no sync follows the close.
    merchantWindow(h, [EMERALD_FOR_BREAD], { closeAfterAnswered: 2, noSyncOnClose: true });
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), {
      traded: 2,
      gave: { emerald: 2 },
      got: { bread: 6 },
      shortfall: "only 2 of 3 trades completed: the merchant closed the trade window",
    });
    assert.deepEqual(h.inventory, { emerald: 8, bread: 6 }, "the cursor's output and the trade slots' remainder are modeled back in");
  });

  it("fails naming the cause when no trade happened", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD], { closeAfter: 0 });
    await assert.rejects(h.run(trade.buy, { index: 0, times: 2 }), /^Error: offer 0 of the villager at .* did not trade: the merchant closed the trade window$/);
    assert.equal(h.count("emerald"), 10);
  });

  it("fails with the measured change when the inventory changed by anything but whole trades", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD], { takesOnClose: ["emerald", 1] });
    await assert.rejects(
      h.run(trade.buy, { index: 0, times: 2 }),
      /was traded, but the inventory changed by -3 emerald, \+6 bread, which is not a whole number of its trades \(one trade changes it by -1 emerald, \+3 bread\); inventory\.list shows/,
    );
  });

  it("returns the trades the server made when it stops offering the output, not the number asked for", async () => {
    const h = createHarness({ inventory: { emerald: 10 } });
    spawnMerchant(h, "villager", [3.5, 64, 0.5]);
    merchantWindow(h, [EMERALD_FOR_BREAD], { refuseAfter: 1 });
    assert.deepEqual(await h.run(trade.buy, { index: 0, times: 3 }), {
      traded: 1,
      gave: { emerald: 1 },
      got: { bread: 3 },
      shortfall: "only 1 of 3 trades completed: the merchant offered nothing for the 9 emerald in the trade slots",
    });
    assert.deepEqual(h.inventory, { emerald: 9, bread: 3 });
  });
});
