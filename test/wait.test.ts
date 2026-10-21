import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { EventLog } from "../src/body/events.ts";
import { eventMatches } from "../src/protocol/event-filter.ts";
import { WaitInput } from "../src/protocol/index.ts";

const chat = (from: string, message: string) => ({ from, message });

describe("eventMatches", () => {
  it("filters by type (any of), sender, and a case-insensitive regex over the message", () => {
    const event = { seq: 1, time: 0, type: "chat", data: chat("Ana", "Found DIAMONDS!") };
    assert.equal(eventMatches(event, {}), true);
    assert.equal(eventMatches(event, { types: ["chat", "whisper"] }), true);
    assert.equal(eventMatches(event, { types: ["night"] }), false);
    assert.equal(eventMatches(event, { from: "ana" }), true);
    assert.equal(eventMatches(event, { from: "ben" }), false);
    // The daemon compiles `match` with the "i" flag.
    assert.equal(eventMatches(event, { match: /diamonds/i }), true);
    assert.equal(eventMatches(event, { match: /^found/i }), true);
    assert.equal(eventMatches(event, { match: /diamonds\?$/i }), false);
  });

  it("lets from and match only fit events that carry a sender or a message", () => {
    const night = { seq: 2, time: 0, type: "night", data: { timeOfDay: 12542 } };
    assert.equal(eventMatches(night, { from: "ana" }), false);
    assert.equal(eventMatches(night, { match: /12542/ }), false);
    assert.equal(eventMatches(night, { types: ["night"] }), true);
  });
});

describe("EventLog.wait", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("returns the oldest buffered event after an explicit cursor", async () => {
    const log = new EventLog();
    log.push("chat", chat("ana", "hi"));
    log.push("chat", chat("ben", "hello"));
    log.push("night", { timeOfDay: 12542 });
    assert.equal((await log.wait({ since: 0, types: ["chat"] })).event?.seq, 1);
    assert.equal((await log.wait({ since: 1, types: ["chat"] })).event?.seq, 2);
  });

  it("waits only for new events by default", async () => {
    const log = new EventLog();
    log.push("chat", chat("ana", "already buffered"));
    const pending = log.wait({ types: ["chat"], timeoutMs: 50 });
    mock.timers.tick(50);
    const timedOut = await pending;
    assert.equal(timedOut.event, null);
    assert.equal(timedOut.timedOut, true);
  });

  it("resolves when a matching event arrives later, under every filter", async () => {
    const log = new EventLog();
    const pending = log.wait({ types: ["chat", "whisper"], from: "ben", timeoutMs: 1000 });
    log.push("chat", chat("ana", "not ben"));
    log.push("whisper", chat("Ben", "psst"));
    const got = await pending;
    assert.equal(got.event?.type, "whisper");
    assert.equal(got.next, 2);
    assert.equal(got.timedOut, false);
  });

  it("times out with the cursor past what it examined, so the next wait skips that", async () => {
    const log = new EventLog();
    log.push("death", {});
    const pending = log.wait({ types: ["chat"], timeoutMs: 100 });
    log.push("system", { message: "not a chat" });
    mock.timers.tick(100);
    const timedOut = await pending;
    assert.deepEqual([timedOut.event, timedOut.timedOut], [null, true]);
    assert.equal(timedOut.next, 2);
    const again = log.wait({ types: ["chat"], since: timedOut.next, timeoutMs: 100 });
    log.push("chat", chat("ana", "late"));
    assert.equal((await again).event?.seq, 3);
  });

  it("settles every waiter that matches the event", async () => {
    const log = new EventLog();
    const matched = [log.wait({ types: ["chat"] }), log.wait({ from: "ana" })];
    const unmatched = log.wait({ types: ["night"] });
    log.push("chat", chat("ana", "hello"));
    assert.deepEqual((await Promise.all(matched)).map((r) => r.event?.seq), [1, 1]);
    mock.timers.tick(60_000);
    assert.equal((await unmatched).timedOut, true);
  });

  it("drops a waiter whose request went away, without consuming events", async () => {
    const log = new EventLog();
    const gone = new AbortController();
    const pending = log.wait({ types: ["chat"], timeoutMs: 1000, signal: gone.signal });
    gone.abort();
    log.push("chat", chat("ana", "nobody is listening"));
    assert.equal((await pending).event, null);
    const next = log.wait({ types: ["chat"], since: 1, timeoutMs: 1000 });
    log.push("chat", chat("ben", "still here"));
    assert.equal((await next).event?.data.message, "still here");
  });

  it("restarts from the beginning when the cursor is ahead of the log", async () => {
    const log = new EventLog();
    log.push("night", { timeOfDay: 12542 });
    assert.equal((await log.wait({ since: 5, types: ["night"], timeoutMs: 1000 })).event?.seq, 1);
  });
});

describe("WaitInput", () => {
  it("rejects an invalid regular expression, an empty type list, and too long a timeout", () => {
    assert.equal(WaitInput.safeParse({ match: "a(" }).success, false);
    assert.equal(WaitInput.safeParse({ types: [] }).success, false);
    assert.equal(WaitInput.safeParse({ types: [""] }).success, false);
    assert.equal(WaitInput.safeParse({ timeoutMs: 30 * 60_000 + 1 }).success, false);
    assert.deepEqual(WaitInput.parse({ types: ["chat"], since: 3 }), { types: ["chat"], since: 3 });
  });
});
