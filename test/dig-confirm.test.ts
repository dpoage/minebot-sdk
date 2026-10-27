// dig.dig does what it says (mb-9es, mb-4so): it returns success only after the server's block update, digs blocks
// without a collision box, and names the cause and the next step for a dig the server did not carry out. The stub
// `dig`s below play the part of Mineflayer, which resolves bot.dig on its own prediction of air before the server answers.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createHarness, type Harness } from "minebot-sdk/testing";
import type { Block } from "prismarine-block";
import * as dig from "../src/routines/dig.ts";

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Stub {
  /** True once dig.dig has called bot.dig. */
  called: boolean;
}

/**
 * Replaces the harness's bot.dig with Mineflayer's: the client's cell becomes air at once and bot.dig resolves.
 * `answer(block, emit)` is the server: it calls `emit()` (a blockUpdate to air at the cell) when it chooses, or never.
 */
function mineflayerDig(h: Harness, answer: (block: Block, emit: () => void) => void): Stub {
  const stub: Stub = { called: false };
  const bot = h.bot as unknown as { dig(block: Block): Promise<void>; world: { setBlockStateId(pos: Block["position"], stateId: number): void }; emit(event: string, ...args: unknown[]): void };
  bot.dig = async (block) => {
    stub.called = true;
    const before = h.blockAt(block.position);
    const predicted = h.setBlock(block.position, "air");
    // Mineflayer's own prediction is a blockUpdate too, and it lands before bot.dig resolves.
    bot.emit("blockUpdate", before, predicted);
    answer(block, () => bot.emit("blockUpdate", before, h.blockAt(block.position)));
  };
  bot.world.setBlockStateId = (pos, stateId) => {
    const name = h.bot.registry.blocksByStateId[stateId]?.name;
    assert.ok(name, `state ${stateId} is a block`);
    h.setBlock(pos, name);
  };
  return stub;
}

/** Runs `work` while advancing the mocked timers by `stepMs` per macrotask once the stub's dig has run, until it settles. */
async function settle<T>(stub: Stub, work: Promise<T>, stepMs = 1_000): Promise<PromiseSettledResult<T>> {
  let done = false;
  const outcome = work.then(
    (value): PromiseSettledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseSettledResult<T> => ({ status: "rejected", reason }),
  );
  void outcome.then(() => {
    done = true;
  });
  for (let turn = 0; !done && turn < 1_000; turn++) {
    await macrotask();
    if (stub.called) mock.timers.tick(stepMs);
  }
  return outcome;
}

describe("dig.dig confirms the break with the server", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("D1: throws when bot.dig resolves with the cell air on the client and the server sends no update, and puts the cell back", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, blocks: [{ name: "stone", at: [2, 64, 0] }] });
    const stub = mineflayerDig(h, () => {});
    const before = h.blockAt([2, 64, 0]).stateId;
    const result = await settle(stub, h.run(dig.dig, { at: [2, 64, 0] }));
    assert.equal(result.status, "rejected");
    assert.match(String((result as PromiseRejectedResult).reason), /the server did not break stone at \(2, 64, 0\) within 3 s/);
    assert.equal(h.blockAt([2, 64, 0]).name, "stone", "the client's view is the server's again, not phantom air");
    assert.equal(h.blockAt([2, 64, 0]).stateId, before);
  });

  it("D1: returns the block once the server's update arrives after bot.dig resolved, and not before", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, blocks: [{ name: "stone", at: [2, 64, 0] }] });
    const stub = mineflayerDig(h, (_block, emit) => void setTimeout(emit, 2_000));
    const result = await settle(stub, h.run(dig.dig, { at: [2, 64, 0] }), 500);
    assert.deepEqual(result, { status: "fulfilled", value: { block: "stone" } });
    assert.equal(h.blockAt([2, 64, 0]).name, "air");
  });

  it("D1: the client's own prediction does not count: an update that arrives before bot.dig resolves confirms nothing", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, blocks: [{ name: "stone", at: [2, 64, 0] }] });
    const stub = mineflayerDig(h, () => {});
    // mineflayerDig emits the prediction's blockUpdate before resolving, and answer() sends nothing after it.
    const result = await settle(stub, h.run(dig.dig, { at: [2, 64, 0] }));
    assert.equal(result.status, "rejected");
  });

  it("D1: an update that leaves the dug block in place is no confirmation", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, blocks: [{ name: "stone", at: [2, 64, 0] }] });
    const stub = mineflayerDig(h, (block) => {
      // The server answers with the stone it still holds (a refusal's resync).
      const bot = h.bot as unknown as { emit(event: string, ...args: unknown[]): void };
      setTimeout(() => bot.emit("blockUpdate", null, block), 100);
    });
    const result = await settle(stub, h.run(dig.dig, { at: [2, 64, 0] }));
    assert.equal(result.status, "rejected");
  });

  it("D3: a dig the server refuses past its reach names the block, the box distance, the 5.5 reach and move.to, and the cell is back", async () => {
    // Eyes at (0.5, 65.62, 0.5); the stone's box starts at x 6: 5.5 blocks across and 0.62 down.
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, blocks: [{ name: "stone", at: [6, 64, 0] }] });
    const stub = mineflayerDig(h, () => {});
    const result = await settle(stub, h.run(dig.dig, { at: [6, 64, 0] }));
    assert.equal(result.status, "rejected");
    const message = String((result as PromiseRejectedResult).reason);
    assert.match(message, /the server refused to dig stone at \(6, 64, 0\)/);
    assert.match(message, /its box is 5\.53 blocks from your eyes/);
    assert.match(message, /digs only closer than 5\.5/);
    assert.match(message, /move\.to\(\{ position: \{ x: 6, y: 64, z: 0 \}, range: 3 \}\)/);
    assert.equal(h.blockAt([6, 64, 0]).name, "stone");
  });

  it("D3: a dig the server accepts is not refused: a box 5.4 blocks from the eyes (5.9 to its centre) is dug", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, position: [0.6, 64, 0.5], blocks: [{ name: "stone", at: [6, 65, 0] }] });
    const stub = mineflayerDig(h, (_block, emit) => void setTimeout(emit, 50));
    const result = await settle(stub, h.run(dig.dig, { at: [6, 65, 0] }));
    assert.deepEqual(result, { status: "fulfilled", value: { block: "stone" } });
    assert.equal(h.blockAt([6, 65, 0]).name, "air");
  });

  it("D3: a block in reach that the server leaves standing says so, with its distance, and does not blame the reach", async () => {
    const h = createHarness({ inventory: { wooden_pickaxe: 1 }, position: [0.6, 64, 0.5], blocks: [{ name: "stone", at: [6, 65, 0] }] });
    const stub = mineflayerDig(h, () => {});
    const result = await settle(stub, h.run(dig.dig, { at: [6, 65, 0] }));
    assert.equal(result.status, "rejected");
    const message = String((result as PromiseRejectedResult).reason);
    assert.match(message, /the server did not break stone at \(6, 65, 0\) within 3 s although it is in reach \(5\.40 blocks from your eyes; limit 5\.5\)/);
    assert.match(message, /it is still there/);
    assert.match(message, /move\.to\(/);
  });
});

describe("dig.dig on blocks without a collision box", () => {
  for (const name of ["torch", "oak_sign", "dandelion", "short_grass"]) {
    it(`D2: digs ${name} and leaves the cell clear`, async () => {
      const h = createHarness({ blocks: [{ name, at: [1, 64, 0] }] });
      assert.notEqual(h.blockAt([1, 64, 0]).boundingBox, "block");
      assert.deepEqual(await h.run(dig.dig, { at: [1, 64, 0] }), { block: name });
      assert.equal(h.blockAt([1, 64, 0]).name, "air");
    });
  }

  it("D2: a clear cell, air or a fluid, is already dug: { block: null }", async () => {
    const h = createHarness({ blocks: [{ name: "water", at: [1, 64, 0] }, { name: "lava", at: [2, 64, 0] }] });
    for (const x of [1, 2, 3]) assert.deepEqual(await h.run(dig.dig, { at: [x, 64, 0] }), { block: null }, `x ${x}`);
  });

  it("D2: a block that cannot be dug still throws", async () => {
    const h = createHarness({ blocks: [{ name: "bedrock", at: [1, 64, 0] }] });
    await assert.rejects(h.run(dig.dig, { at: [1, 64, 0] }), /bedrock at .* cannot be dug/);
  });
});

describe("the harness's dig answers the way a server does", () => {
  it("D4: bot.dig sends a blockUpdate to the new state after it resolves, not before", async () => {
    const h = createHarness({ blocks: [{ name: "dirt", at: [1, 64, 0] }] });
    const seen: (string | undefined)[] = [];
    h.bot.on("blockUpdate", (_old, next) => {
      seen.push(next?.name);
    });
    await h.bot.dig(h.blockAt([1, 64, 0]), true);
    assert.deepEqual(seen, [], "mineflayer resolves on its prediction; the server's update comes after");
    await macrotask();
    assert.deepEqual(seen, ["air"]);
  });

  it("D4: dig.dig through the harness confirms and returns the block", async () => {
    const h = createHarness({ blocks: [{ name: "dirt", at: [1, 64, 0] }] });
    assert.deepEqual(await h.run(dig.dig, { at: [1, 64, 0] }), { block: "dirt" });
    assert.equal(h.count("dirt"), 1);
  });
});
