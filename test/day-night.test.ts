// P1.1: a wait for a phase that already holds answers at once, including the phase the body joined
// in (the first time packet after a join announces it, so no transition is coming); in the other
// phase it waits for the transition. An explicit cursor keeps the buffered-only semantics.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { EventLog } from "../src/body/events.ts";

describe("EventLog.wait on day and night", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("answers at once with the day event when day already holds, including a phase the body joined in", async () => {
    const log = new EventLog();
    // A body that joined in the day: the log holds the phase and never saw a transition.
    log.push("day", { timeOfDay: 1000 });
    const pending = log.wait({ types: ["day"], timeoutMs: 1000 });
    // A wait that only saw new events would need this timeout; the phase already answers.
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

  it("times out when the other phase holds and no transition comes", async () => {
    const log = new EventLog();
    log.push("night", { timeOfDay: 13000 });
    const pending = log.wait({ types: ["day"], timeoutMs: 1000 });
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
