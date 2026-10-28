// The idle float (mb-znn.2a): while no run holds the run slot and the player's eyes are in water, the body holds jump,
// and it holds nothing otherwise; a run's controls are never touched, and a run's code never starts with the float's jump held.
// The first half drives `keepAfloat` over a fake player and a fake slot; the second half runs the whole body over a fake
// player (fixtures/host/fake-body.ts), where only the real Body can say whether it lets go before a run starts.
import assert from "node:assert/strict";
import { afterEach, after, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { FLOAT_CHECK_MS, keepAfloat } from "../src/host/autonomic.ts";
import { removeScratch, startFakeBody, type FakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

interface FakeBlock {
  name: string;
  waterlogged?: boolean;
}

/** A player over a map of blocks by cell; every cell not in the map is air. `calls` is every control change made, in order. */
function player(feet: Vec3, cells: Record<string, FakeBlock> = {}) {
  const calls: [string, boolean][] = [];
  const state = {
    entity: { position: feet } as { position: Vec3 } | undefined,
    controlState: {} as Record<string, boolean>,
    cells,
    blockAt(at: Vec3) {
      const block = state.cells[`${at.x},${at.y},${at.z}`] ?? { name: "air" };
      return { name: block.name, getProperties: () => (block.waterlogged === undefined ? {} : { waterlogged: block.waterlogged }) };
    },
    setControlState(control: string, held: boolean) {
      calls.push([control, held]);
      state.controlState[control] = held;
    },
  };
  // The float reads only these members of a Mineflayer bot.
  const bot = state as unknown as Bot;
  return { bot, state, calls };
}

/** Feet at y 60: the eyes are at 61.62, in the cell y 61. */
const FEET = new Vec3(0.5, 60, 0.5);
const EYE_CELL = "0,61,0";

describe("keepAfloat", () => {
  afterEach(() => mock.timers.reset());

  /** Starts a float with the clock under the test's control; `tick()` is one physics tick. */
  function floating(getBot: () => Bot | undefined, slot: { busy: boolean }) {
    mock.timers.reset();
    mock.timers.enable({ apis: ["setInterval"] });
    const afloat = keepAfloat(getBot, slot);
    return { afloat, tick: (n = 1) => mock.timers.tick(FLOAT_CHECK_MS * n) };
  }

  it("holds jump while the slot is free and the eyes are in water", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const { tick } = floating(() => p.bot, { busy: false });
    tick();
    assert.deepEqual(p.calls, [["jump", true]]);
    tick(5);
    assert.deepEqual(p.calls, [["jump", true]], "pressed again");
  });

  for (const name of ["kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column", "water"]) {
    it(`counts ${name} at the eyes as water`, () => {
      const p = player(FEET, { [EYE_CELL]: { name } });
      floating(() => p.bot, { busy: false }).tick();
      assert.deepEqual(p.calls, [["jump", true]]);
    });
  }

  it("counts a waterlogged block at the eyes as water, and a dry one of the same name as air", () => {
    const wet = player(FEET, { [EYE_CELL]: { name: "oak_slab", waterlogged: true } });
    floating(() => wet.bot, { busy: false }).tick();
    assert.deepEqual(wet.calls, [["jump", true]]);
    const dry = player(FEET, { [EYE_CELL]: { name: "oak_slab", waterlogged: false } });
    floating(() => dry.bot, { busy: false }).tick();
    assert.deepEqual(dry.calls, []);
  });

  it("holds nothing for a 1-deep puddle: the feet in water, the eyes in air", () => {
    const p = player(FEET, { "0,60,0": { name: "water" }, "0,59,0": { name: "water" } });
    floating(() => p.bot, { busy: false }).tick(3);
    assert.deepEqual(p.calls, []);
  });

  it("reads the cell at the eyes (feet + 1.62, floored), not the feet's", () => {
    // Feet at 60.5: the eyes are at 62.12, in the cell y 62.
    const p = player(new Vec3(0.5, 60.5, 0.5), { "0,61,0": { name: "water" } });
    const { tick } = floating(() => p.bot, { busy: false });
    tick();
    assert.deepEqual(p.calls, []);
    p.state.cells["0,62,0"] = { name: "water" };
    tick();
    assert.deepEqual(p.calls, [["jump", true]]);
  });

  it("holds nothing while the slot is taken, and lets go once it is", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const slot = { busy: true };
    const { tick } = floating(() => p.bot, slot);
    tick(3);
    assert.deepEqual(p.calls, [], "pressed while a run held the slot");
    slot.busy = false;
    tick();
    assert.deepEqual(p.calls, [["jump", true]]);
    slot.busy = true;
    tick();
    assert.deepEqual(p.calls, [["jump", true], ["jump", false]]);
  });

  it("lets go when the eyes leave the water, and presses again when they are back in it", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const { tick } = floating(() => p.bot, { busy: false });
    tick();
    delete p.state.cells[EYE_CELL];
    tick();
    p.state.cells[EYE_CELL] = { name: "kelp" };
    tick();
    assert.deepEqual(p.calls, [["jump", true], ["jump", false], ["jump", true]]);
  });

  it("presses again after a halt cleared its jump", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const { tick } = floating(() => p.bot, { busy: false });
    tick();
    p.state.controlState.jump = false;
    tick();
    assert.equal(p.state.controlState.jump, true);
  });

  it("release() lets go at once, so a run's code starts with jump false, and the float does not press while the run holds the slot", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const slot = { busy: false };
    const { afloat, tick } = floating(() => p.bot, slot);
    tick();
    assert.equal(p.state.controlState.jump, true);
    // What the body does for a run: the slot is taken, then the float lets go, then the code starts.
    slot.busy = true;
    afloat.release();
    assert.equal(p.state.controlState.jump, false, "the run's code would start with the float's jump held");
    tick(3);
    assert.equal(p.state.controlState.jump, false);
  });

  it("never touches the controls of a run that dives: its jump, set by itself, is neither released nor pressed over", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const slot = { busy: false };
    const { afloat, tick } = floating(() => p.bot, slot);
    tick();
    slot.busy = true;
    afloat.release();
    const mark = p.calls.length;
    // The run sets its own jump, holds it through many ticks, and clears it only at its end.
    p.bot.setControlState("jump", true);
    tick(10);
    afloat.release();
    assert.deepEqual(p.calls.slice(mark), [["jump", true]], "the float changed a control while the run held the slot");
    assert.equal(p.state.controlState.jump, true);
  });

  it("does not release a jump a run left held when it ends: it never pressed that one", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const slot = { busy: true };
    const { afloat, tick } = floating(() => p.bot, slot);
    p.bot.setControlState("jump", true);
    slot.busy = false;
    tick();
    delete p.state.cells[EYE_CELL];
    tick(2);
    afloat.release();
    assert.deepEqual(p.calls, [["jump", true]]);
    assert.equal(p.state.controlState.jump, true);
  });

  it("forgets a bot that was replaced and floats the new one", () => {
    const old = player(FEET, { [EYE_CELL]: { name: "water" } });
    const next = player(FEET, { [EYE_CELL]: { name: "water" } });
    let current = old.bot;
    const { afloat, tick } = floating(() => current, { busy: false });
    tick();
    current = next.bot;
    tick();
    assert.deepEqual(old.calls, [["jump", true]], "touched the bot that was replaced");
    assert.deepEqual(next.calls, [["jump", true]]);
    afloat.release();
    assert.deepEqual(next.calls, [["jump", true], ["jump", false]]);
  });

  it("holds nothing before the player has spawned or while there is no bot", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    p.state.entity = undefined;
    let present: Bot | undefined = p.bot;
    const { tick } = floating(() => present, { busy: false });
    tick(3);
    present = undefined;
    tick(3);
    assert.deepEqual(p.calls, []);
  });

  it("close() lets go of its jump and stops looking", () => {
    const p = player(FEET, { [EYE_CELL]: { name: "water" } });
    const { afloat, tick } = floating(() => p.bot, { busy: false });
    tick();
    afloat.close();
    assert.deepEqual(p.calls, [["jump", true], ["jump", false]]);
    tick(5);
    assert.equal(p.calls.length, 2);
  });
});

describe("a body's idle float, over a fake player", { timeout: 60_000 }, () => {
  /** What a run reads of the player when its code starts. */
  const PROBE = "export default (ctx) => ({ atStart: ctx.bot.controlState.jump ?? false, pressedBefore: ctx.bot.jumps.filter((held) => held).length });\n";
  /** Puts the player's eyes in water: a run that returns at once; the slot frees and the float takes over. */
  const DIVE_IN = "export default (ctx) => { ctx.bot.eye.name = 'kelp'; };\n";

  async function withBody(test: (body: FakeBody) => Promise<void>): Promise<void> {
    const body = await startFakeBody();
    try {
      await test(body);
    } finally {
      await body.close();
    }
  }

  /** The result a run's or call's answer carries. */
  function resultOf(answer: unknown): unknown {
    assert.ok(typeof answer === "object" && answer !== null && "result" in answer, JSON.stringify(answer));
    return answer.result;
  }

  const run = async (body: FakeBody, code: string): Promise<unknown> => {
    const answer = await body.request("POST", "/run", { code });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  };

  /** The float looks every FLOAT_CHECK_MS of real time, in the host's own process: this is the one wait the test cannot replace with an event. */
  const floatSettles = () => sleep(FLOAT_CHECK_MS * 4);

  it("floats while idle, and every run it interrupts starts with jump false (a module run)", async () => {
    await withBody(async (body) => {
      await run(body, DIVE_IN);
      for (let i = 1; i <= 8; i++) {
        await floatSettles();
        assert.deepEqual(resultOf(await run(body, PROBE)), { atStart: false, pressedBefore: i }, `run ${i}: the float's jump was held when the run's code started, or the float never pressed`);
      }
    });
  });

  it("and a call, and a reflex's firing (the second run path)", async () => {
    await withBody(async (body) => {
      body.writeRoutines({ probe: PROBE, spy: PROBE });
      await body.ok("POST", "/bind", { kind: "action", name: "probe", routine: "probe" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "rfx", routine: "spy", on: ["chat"], cooldownMs: 0 });
      await run(body, DIVE_IN);
      let seen = 0;
      for (let i = 1; i <= 6; i++) {
        await floatSettles();
        assert.deepEqual(resultOf(await body.ok("POST", "/call", { name: "probe" })), { atStart: false, pressedBefore: 2 * i - 1 }, `call ${i}`);
        await floatSettles();
        body.events.push("chat", { from: "ana", message: "go" });
        seen = (await body.waitFor("reflex_finished", seen)).seq;
        const fired = body.history().filter((line) => line.trigger === "rfx");
        assert.deepEqual(fired.at(-1)?.result, { atStart: false, pressedBefore: 2 * i }, `firing ${i}`);
      }
    });
  });

  it("does not float while a run holds the slot, even one that dives on purpose with jump of its own", async () => {
    await withBody(async (body) => {
      const answer = await run(
        body,
        "export default async (ctx) => {\n  ctx.bot.eye.name = 'water';\n  const before = ctx.bot.jumps.length;\n  ctx.bot.setControlState('jump', true);\n  await ctx.sleep(400);\n  return { changes: ctx.bot.jumps.slice(before), held: ctx.bot.controlState.jump };\n};\n",
      );
      assert.deepEqual(resultOf(answer), { changes: [true], held: true });
    });
  });

  it("does not press for a run whose eyes are in water while it holds the slot, with no jump of its own", async () => {
    await withBody(async (body) => {
      const answer = await run(body, "export default async (ctx) => {\n  ctx.bot.eye.name = 'water';\n  await ctx.sleep(400);\n  return ctx.bot.jumps;\n};\n");
      assert.deepEqual(resultOf(answer), []);
    });
  });

  it("holds nothing once the eyes are out of water, with nothing exported", async () => {
    await withBody(async (body) => {
      await run(body, DIVE_IN);
      await floatSettles();
      await run(body, "export default (ctx) => { ctx.bot.eye.name = null; };\n");
      await floatSettles();
      const answer = await run(body, "export default (ctx) => ({ held: ctx.bot.controlState.jump ?? false, jumps: ctx.bot.jumps });\n");
      assert.deepEqual(resultOf(answer), { held: false, jumps: [true, false] });
    });
  });
});
