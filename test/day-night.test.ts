// P1.1 (revised): a wait with no cursor is answered at once from the phase that holds only when its
// `types` name exactly one of day/night and that phase holds now (other types may accompany it). A
// wait naming both, neither, or no types is answered only by events pushed after the call. The
// connection announces the phase a body joins in on its first time packet, then each transition.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { EventLog } from "../src/body/events.ts";
import { announceDayNight } from "../src/host/connection.ts";

describe("EventLog.wait on day and night", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("answers at once with the day event when the wait names day and day already holds", async () => {
    const log = new EventLog();
    // A body that joined in the day: the log holds the phase and never saw a transition.
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["day"], timeoutMs: 1000 });
    // A wait that only saw new events would need this timeout; the phase already answers.
    mock.timers.tick(1000);
    const got = await pending;
    assert.deepEqual([got.event?.type, got.timedOut], ["day", false]);
  });

  it("answers at once with a repeated phase type, which is still exactly that phase", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["day", "day"], timeoutMs: 1000 });
    mock.timers.tick(1000);
    const got = await pending;
    assert.deepEqual([got.event?.type, got.timedOut], ["day", false]);
  });

  it("answers at once with the night event when night already holds", async () => {
    const log = new EventLog();
    log.push("night", { timeOfDay: 13000 });
    const pending = log.wait({ types: ["night"], timeoutMs: 1000 });
    mock.timers.tick(1000);
    const got = await pending;
    assert.deepEqual([got.event?.type, got.timedOut], ["night", false]);
  });

  it("waits for the next transition when the other phase holds", async () => {
    const log = new EventLog();
    log.push("night", { timeOfDay: 13000 });
    const pending = log.wait({ types: ["day"], timeoutMs: 1000 });
    log.push("day", { timeOfDay: 1 });
    const got = await pending;
    assert.deepEqual([got.event?.type, got.timedOut], ["day", false]);
  });

  it("times out with no types: an old phase is not an event", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ timeoutMs: 1000 });
    mock.timers.tick(1000);
    assert.equal((await pending).timedOut, true);
  });

  it("times out when the types name both day and night, holding phase first", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["day", "night"], timeoutMs: 1000 });
    mock.timers.tick(1000);
    assert.equal((await pending).timedOut, true);
  });

  it("times out when the types name both day and night, other phase first", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["night", "day"], timeoutMs: 1000 });
    mock.timers.tick(1000);
    assert.equal((await pending).timedOut, true);
  });

  it("times out when a holding phase is mixed with other types", async () => {
    for (const [at, types] of [
      [1000, ["chat", "day"]],
      [13000, ["chat", "whisper", "night"]],
    ] as const) {
      const log = new EventLog();
      log.push(at < 12542 ? "day" : "night", { timeOfDay: at });
      const pending = log.wait({ types: [...types], timeoutMs: 1000 });
      mock.timers.tick(1000);
      assert.equal((await pending).timedOut, true, types.join(","));
    }
  });

  it("times out when the types name neither phase", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["chat"], timeoutMs: 1000 });
    mock.timers.tick(1000);
    assert.equal((await pending).timedOut, true);
  });

  it("keeps the cursor semantics for a wait after a cursor: a holding phase is not a new event", async () => {
    const log = new EventLog();
    log.push("day", { timeOfDay: 1000 });
    const latest = log.since().latest;
    const pending = log.wait({ types: ["day"], since: latest, timeoutMs: 1000 });
    mock.timers.tick(1000);
    assert.equal((await pending).timedOut, true);
  });
});

describe("the connection's phase announcement", () => {
  /** A player whose time packets the test emits by hand. */
  function phaseBot(timeOfDay: number) {
    return Object.assign(new EventEmitter(), { time: { timeOfDay } });
  }

  it("announces the phase the body joined in on the first time packet, then only transitions", () => {
    const bot = phaseBot(1000);
    const log = new EventLog();
    announceDayNight(bot, log);
    bot.emit("time");
    bot.emit("time"); // the same phase again is not an event
    bot.time.timeOfDay = 13000;
    bot.emit("time");
    bot.time.timeOfDay = 1;
    bot.emit("time");
    assert.deepEqual(log.since(0).events.map((event) => [event.type, event.data.timeOfDay]), [
      ["day", 1000],
      ["night", 13000],
      ["day", 1],
    ]);
  });
});
