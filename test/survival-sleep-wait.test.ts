import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { Vec3 } from "minebot-sdk/routine";
import { createHarness } from "minebot-sdk/testing";
import * as survival from "../src/routines/survival.ts";

// The harness has no bot.sleep (and does not grow one): these tests give the bot a stub that records when and where it was called.
function bedroom(options: { time: number; bed?: [number, number, number]; clock?: boolean }) {
  const h = createHarness({ time: options.time, blocks: [{ name: "red_bed", at: options.bed ?? [1, 64, 0] }] });
  const slept: { timeOfDay: number; position: Vec3 }[] = [];
  const walked: number[] = [];
  const goto = h.bot.pathfinder.goto;
  Object.assign(h.bot.pathfinder, {
    async goto(goal: never) {
      walked.push(h.bot.time.timeOfDay);
      return goto(goal);
    },
  });
  Object.assign(h.bot, {
    async sleep() {
      slept.push({ timeOfDay: h.bot.time.timeOfDay, position: h.position });
    },
  });
  if (options.clock === false) h.bot.time.doDaylightCycle = false;
  return { h, slept, walked };
}

describe("survival.sleep outside the window (S1)", () => {
  it("names the time of day, the window, the seconds until it opens, and the next step", async () => {
    const { h, slept } = bedroom({ time: 10541 });
    await assert.rejects(h.run(survival.sleep, {}), (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /time of day 10541/);
      assert.match(message, /12541 to 23458/);
      assert.match(message, /opens in 100 s/);
      assert.match(message, /\{ wait: true \}/);
      assert.match(message, /timeout_ms of at least 135000/);
      return true;
    });
    assert.equal(slept.length, 0);
    assert.equal(h.bot.time.timeOfDay, 10541, "it does not wait");
  });

  it("counts the seconds across midnight and rounds up", async () => {
    const { h } = bedroom({ time: 23541 });
    await assert.rejects(h.run(survival.sleep, {}), /opens in 650 s/);
    const late = bedroom({ time: 23459 });
    await assert.rejects(late.h.run(survival.sleep, {}), /opens in 655 s/);
  });

  it("says the clock is stopped, not a count of seconds, when the daylight cycle is off", async () => {
    const { h } = bedroom({ time: 1000, clock: false });
    await assert.rejects(h.run(survival.sleep, {}), (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /time of day 1000/);
      assert.match(message, /clock is stopped \(gamerule advance_time is off\)/);
      assert.doesNotMatch(message, /opens in/);
      return true;
    });
  });
});

describe("survival.sleep with wait (S2, S3)", () => {
  it("behaves as without wait inside the window: sleeps at once, no wait line", async () => {
    const { h, slept } = bedroom({ time: 13000 });
    assert.deepEqual(await h.run(survival.sleep, { wait: true }), { sleeping: true, at: { x: 1, y: 64, z: 0 } });
    assert.deepEqual(
      slept.map((s) => s.timeOfDay),
      [13000],
    );
    assert.deepEqual(h.logs, []);
  });

  it("walks to the bed, waits, and is asleep within 2 s of the window opening", async () => {
    const { h, slept, walked } = bedroom({ time: 10541, bed: [8, 64, 0] });
    assert.deepEqual(await h.run(survival.sleep, { wait: true }), { sleeping: true, at: { x: 8, y: 64, z: 0 } });
    assert.equal(slept.length, 1);
    assert.ok(slept[0]!.timeOfDay >= 12541 && slept[0]!.timeOfDay <= 12541 + 40, `slept at ${slept[0]!.timeOfDay}`);
    assert.ok(slept[0]!.position.distanceTo(h.bot.entity.position) < 0.01 && slept[0]!.position.x > 5, "it slept at the bed");
    assert.deepEqual(walked, [10541], "it walked before it waited");
  });

  it("sleeps when a thunderstorm starts before night", async () => {
    const { h, slept } = bedroom({ time: 1000 });
    let ticks = 0;
    let clock = 1000;
    Object.defineProperty(h.bot.time, "timeOfDay", {
      get: () => clock,
      set: (value: number) => {
        clock = value;
        if (++ticks === 40) Object.assign(h.bot, { isRaining: true, thunderState: 1 });
      },
    });
    await h.run(survival.sleep, { wait: true });
    assert.equal(slept.length, 1);
    assert.ok(slept[0]!.timeOfDay > 1000 && slept[0]!.timeOfDay < 12541, `slept at ${slept[0]!.timeOfDay}, in the storm`);
  });

  it("throws at once when the window opens after timeoutMs, naming the wait and the retry", async () => {
    const { h, slept } = bedroom({ time: 1000 });
    await assert.rejects(h.run(survival.sleep, { wait: true, timeoutMs: 100_000 }), (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /opens in 578 s, which is after timeoutMs 100000/);
      assert.match(message, /timeoutMs: 582050/);
      assert.match(message, /timeout_ms of at least 613000/);
      return true;
    });
    assert.equal(h.bot.time.timeOfDay, 1000, "it did not wait");
    assert.equal(slept.length, 0);
  });

  it("throws at once when the clock is stopped", async () => {
    const { h, slept } = bedroom({ time: 1000, clock: false });
    await assert.rejects(h.run(survival.sleep, { wait: true }), /clock is stopped \(gamerule advance_time is off\)/);
    assert.equal(h.bot.time.timeOfDay, 1000);
    assert.equal(slept.length, 0);
  });

  it("throws when the clock stops during the wait", async () => {
    const { h, slept } = bedroom({ time: 1000 });
    let ticks = 0;
    let clock = 1000;
    Object.defineProperty(h.bot.time, "timeOfDay", {
      get: () => clock,
      set: (value: number) => {
        clock = value;
        if (++ticks === 40) h.bot.time.doDaylightCycle = false;
      },
    });
    await assert.rejects(h.run(survival.sleep, { wait: true }), /clock is stopped/);
    assert.equal(slept.length, 0);
  });

  it("gives up at timeoutMs when the window has not opened by then (a lagging server)", async () => {
    const { h, slept } = bedroom({ time: 1000 });
    // The server's clock runs slow: it passes game ticks, but the wall clock outruns them.
    let wall = 0;
    mock.method(Date, "now", () => (wall += 10_000));
    try {
      await assert.rejects(h.run(survival.sleep, { wait: true, timeoutMs: 600_000 }), /did not open within timeoutMs 600000 \(time of day \d+/);
    } finally {
      mock.restoreAll();
    }
    assert.equal(slept.length, 0);
  });

  it("ends the wait when the run is stopped", async () => {
    const { h, slept } = bedroom({ time: 1000 });
    let ticks = 0;
    let clock = 1000;
    const stopping = new Error("stop now");
    Object.defineProperty(h.bot.time, "timeOfDay", {
      get: () => clock,
      set: (value: number) => {
        clock = value;
        if (++ticks === 40) h.abort(stopping);
      },
    });
    await assert.rejects(h.run(survival.sleep, { wait: true }), /stop now/);
    assert.ok(clock < 2000, "it stopped waiting at once");
    assert.equal(slept.length, 0);
  });

  it("reports a missing bed before it waits", async () => {
    const h = createHarness({ time: 1000 });
    await assert.rejects(h.run(survival.sleep, { wait: true }), /no bed within 16 blocks/);
    assert.equal(h.bot.time.timeOfDay, 1000);
  });

  it("tells the agent the call timeout to pass, in a line the call's answer keeps (S3)", async () => {
    const { h } = bedroom({ time: 10541 });
    await h.run(survival.sleep, { wait: true });
    assert.deepEqual(h.logs, ["survival.sleep: waiting 100 s for the bed window (time of day 10541, opens at 12541). If this call's timeout_ms is shorter, it is cut off first: call again with timeout_ms >= 135000"]);
  });
});
