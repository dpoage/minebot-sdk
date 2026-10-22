import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { z } from "zod";
import { EventLog } from "../src/body/events.ts";
import { NameConflictError, TriggerInvalidError, TriggerLimitError, Triggers, type StoredReflex } from "../src/host/triggers.ts";
import { BusyError } from "../src/program/runner.ts";
import { MAX_TRIGGERS, type BodyEvent, type ReflexInput, type RunResult } from "../src/protocol/index.ts";
import { JsonStore } from "../src/store.ts";

interface Harness {
  triggers: Triggers;
  events: EventLog;
  /** What the fake runner ran, in order. */
  ran: { name: string; event: BodyEvent }[];
  /** The runs the fake runner holds open until released, oldest first. */
  held: { release: (result?: Partial<RunResult>) => void }[];
  /** Pretends a run of the agent is running. */
  runner: { running: object | null; stops: number };
  file: string;
}

/**
 * A Triggers over a fake runner: runs finish with `ok` at once, unless `hold` is set, which keeps them open.
 * `gapMs` is the time between the runner going idle and the run's result being returned, as the history's append takes.
 */
async function harness(options: { file?: string; hold?: boolean; gapMs?: number; connected?: () => boolean; reflexes?: boolean } = {}): Promise<Harness> {
  const file = options.file ?? path.join(await mkdtemp(path.join(tmpdir(), "minebot-triggers-")), "triggers.json");
  const events = new EventLog();
  const runner = { running: null as object | null, stops: 0 };
  const ran: Harness["ran"] = [];
  const held: Harness["held"] = [];
  const fakeRunner = {
    get running() {
      return runner.running;
    },
    stop() {
      runner.stops++;
      // An aborted run ends at once, and whoever ran it reports that it is idle.
      const open = held.shift();
      if (open) open.release({ status: "stopped" });
      else if (runner.running) {
        runner.running = null;
        triggers.idle();
      }
      return true;
    },
  };
  const triggers = new Triggers({
    store: new JsonStore(file),
    events,
    runner: fakeRunner,
    connected: options.connected ?? (() => true),
    bot: () => ({ health: 20 }),
    reflexes: options.reflexes ?? true,
    register: async () => {},
    run: async (reflex: StoredReflex, event, started) => {
      if (runner.running) throw new BusyError();
      started();
      ran.push({ name: reflex.name, event });
      runner.running = {};
      try {
        if (options.hold) {
          const { promise, resolve } = Promise.withResolvers<Partial<RunResult>>();
          held.push({ release: (result) => resolve(result ?? {}) });
          return { status: "ok", logs: "", durationMs: 1, ...(await promise) };
        }
        if (reflex.routine.startsWith("throw")) return { status: "error", error: "boom", logs: "", durationMs: 1 };
        return { status: "ok", logs: "", durationMs: 1 };
      } finally {
        runner.running = null;
        if (options.gapMs) await sleep(options.gapMs);
      }
    },
  });
  return { triggers, events, ran, held, runner, file };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await setImmediate();
};

const types = (events: EventLog) => events.since(0).events.map((e) => e.type);

describe("Triggers: saving", () => {
  it("stores a reflex with its defaults, replaces one of the same name, and removes it", async () => {
    const { triggers } = await harness();
    const first = await triggers.addReflex({ name: "eat", on: ["hurt"], routine: "ok" });
    assert.equal(first.replaced, false);
    assert.deepEqual([first.reflex.cooldownMs, first.reflex.timeoutMs, first.reflex.enabled, first.reflex.preempt, first.reflex.priority], [1000, 30000, true, false, 0]);
    assert.equal((await triggers.addReflex({ name: "eat", on: ["chat"], routine: "again" })).replaced, true);
    assert.deepEqual(triggers.reflexes().map((t) => [t.name, t.on]), [["eat", ["chat"]]]);
    assert.equal(triggers.removeReflex("eat"), true);
    assert.equal(triggers.removeReflex("eat"), false);
  });

  it("survives a reload, and reports an entry it cannot load without losing the others", async () => {
    const first = await harness();
    await first.triggers.addReflex({ name: "keep", on: ["hurt"], routine: "ok", when: "event.data.health < 10", cooldownMs: 0 });
    await first.triggers.addReflex({ name: "off", on: ["chat"], routine: "again", enabled: false });
    first.triggers.close();
    const store = new JsonStore(first.file);
    store.set("broken", { on: "hurt", routine: 5 });
    store.set("nocompile", { ...(store.get("keep") as object), when: "const = ;" });
    const second = await harness({ file: first.file });
    assert.deepEqual(second.triggers.reflexes().map((t) => [t.name, t.enabled]), [["keep", true], ["off", false]]);
    assert.deepEqual(second.events.since(0).events.filter((e) => e.type === "reflex_error").map((e) => e.data.name), ["broken", "nocompile"]);
    second.events.push("hurt", { health: 5 });
    await settle();
    assert.deepEqual(second.ran.map((r) => r.name), ["keep"]);
  });
});

describe("Triggers: firing", () => {
  it("never lets a `when` change the event the log holds, and cuts off one that never ends", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.addReflex({ name: "mutate", on: ["hurt"], routine: "ok", when: "(event.data.health = 0, true)", cooldownMs: 0 });
    events.push("hurt", { health: 7 });
    await settle();
    assert.equal(events.since(0).events[0]!.data.health, 7);
    assert.equal(ran.length, 1);
    await triggers.addReflex({ name: "spin", on: ["night"], routine: "ok", when: "(() => { while (true); })()", cooldownMs: 0 });
    events.push("night", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["mutate"]);
    assert.match(String(triggers.reflexes().find((t) => t.name === "spin")!.lastError), /^when: Script execution timed out/);
  });
});

describe("Triggers: failures", () => {
  it("disables a reflex that fails three times in a row, and binding it again resets the count", async () => {
    const { triggers, events } = await harness();
    await triggers.addReflex({ name: "flaky", on: ["hurt"], routine: "throws", cooldownMs: 0 });
    for (let i = 0; i < 2; i++) {
      events.push("hurt", {});
      await settle();
    }
    await triggers.addReflex({ name: "flaky", on: ["hurt"], routine: "ok", cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    assert.equal(triggers.reflexes()[0]!.failures, 0);

    await triggers.addReflex({ name: "bad", on: ["night"], routine: "throws", cooldownMs: 0 });
    for (let i = 0; i < 4; i++) {
      events.push("night", {});
      await settle();
    }
    const bad = triggers.reflexes().find((t) => t.name === "bad")!;
    assert.equal(bad.enabled, false);
    assert.equal(bad.fired, 3, "the fourth night did not run it");
    assert.match(bad.disabledReason!, /failed 3 times in a row; last: boom/);
    const disabled = events.since(0).events.filter((e) => e.type === "reflex_disabled");
    assert.deepEqual(disabled.map((e) => [e.data.name, e.data.failures]), [["bad", 3]]);

    const { reflex: enabled } = await triggers.addReflex({ name: "bad", on: ["night"], routine: "throws", cooldownMs: 0 });
    assert.deepEqual([enabled.enabled, enabled.failures, enabled.disabledReason], [true, 0, undefined]);
  });
});

describe("Triggers: races between a run's end and its result", () => {
  it("keeps the priority of a firing that started while the previous one was still being recorded", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true, gapMs: 30 });
    await triggers.addReflex({ name: "chore", on: ["night"], routine: "ok", cooldownMs: 0 });
    await triggers.addReflex({ name: "flee", on: ["hurt"], routine: "ok", cooldownMs: 0, priority: 5 });
    await triggers.addReflex({ name: "eat", on: ["low_food"], routine: "ok", cooldownMs: 0, preempt: true });
    events.push("night", {});
    await settle();
    held[0]!.release();
    await settle();
    // chore's runner is idle but its result is still being written when flee fires.
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["chore", "flee"]);
    await sleep(60);
    events.push("low_food", {});
    await settle();
    assert.equal(runner.stops, 0, "eat has a lower priority than the running flee, so it waits");
    held[1]!.release();
    await sleep(60);
    assert.deepEqual(ran.map((r) => r.name), ["chore", "flee", "eat"]);
  });

  it("stops a run that started after the one it stopped, instead of waiting it out", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true, gapMs: 20 });
    await triggers.addReflex({ name: "calm", on: ["night"], routine: "ok", cooldownMs: 0 });
    await triggers.addReflex({ name: "flee", on: ["hurt"], routine: "ok", cooldownMs: 0, preempt: true, priority: 5 });
    events.push("night", {});
    await settle();
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1, "calm was stopped for flee");
    // calm's runner is idle and its result is still being written when the agent starts a run.
    runner.running = {};
    await sleep(40);
    await settle();
    assert.equal(runner.stops, 2, "the agent's run is stopped too");
    assert.deepEqual(ran.map((r) => r.name), ["calm", "flee"]);
    void held;
  });
});

type Fields = Omit<z.input<typeof ReflexInput>, "routine">;

/** Saves a reflex with the fields given, calling the routine `ok`; `fail` makes the harness's runner end it in error. */
function define(triggers: Triggers, fields: Fields, fail = false) {
  return triggers.addReflex({ ...fields, routine: fail ? "throws" : "ok" });
}

describe("Triggers: a reflex fires, queues, preempts, and fails", () => {
  it("runs on a matching event with the event, and records reflex_fired and reflex_finished", async () => {
    const { triggers, events, ran } = await harness();
    await define(triggers, { name: "react", on: ["hurt", "night"], cooldownMs: 0 });
    events.push("chat", { from: "ana", message: "hi" });
    events.push("hurt", { health: 8 });
    await settle();
    assert.deepEqual(ran.map((r) => [r.name, r.event.type, r.event.data]), [["react", "hurt", { health: 8 }]]);
    const log = events.since(0).events.filter((e) => e.type.startsWith("reflex_"));
    assert.deepEqual(log.map((e) => e.type), ["reflex_fired", "reflex_finished"]);
    assert.deepEqual(log[0]!.data, { name: "react", event: { seq: 2, type: "hurt" } });
    assert.equal(log[1]!.data.status, "ok");
    assert.equal(triggers.reflexes()[0]!.fired, 1);
  });

  it("filters chat by sender and pattern, and by a `when` expression over the event and the bot", async () => {
    const { triggers, events, ran } = await harness();
    await define(triggers, { name: "ana", on: ["chat"], from: "Ana", match: "^come", cooldownMs: 0 });
    await define(triggers, { name: "hp", on: ["hurt"], when: "event.data.health < 10 && bot.health === 20", cooldownMs: 0 });
    events.push("chat", { from: "ben", message: "come here" });
    events.push("chat", { from: "ana", message: "go away" });
    events.push("hurt", { health: 15 });
    await settle();
    assert.equal(ran.length, 0);
    events.push("chat", { from: "ana", message: "come here" });
    await settle();
    events.push("hurt", { health: 5 });
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["ana", "hp"]);
  });

  it("cuts off a `when` that never ends and counts one that throws as a failure, without running the body", async () => {
    const { triggers, events, ran } = await harness();
    await define(triggers, { name: "spin", on: ["night"], when: "(() => { while (true); })()", cooldownMs: 0 });
    await define(triggers, { name: "broken", on: ["hurt"], when: "event.nothing.deeper", cooldownMs: 0 });
    events.push("night", {});
    for (let i = 0; i < 3; i++) {
      events.push("hurt", {});
      await settle();
    }
    assert.equal(ran.length, 0);
    const byName = (name: string) => triggers.reflexes().find((t) => t.name === name)!;
    assert.match(String(byName("spin").lastError), /^when: Script execution timed out/);
    assert.equal(byName("broken").enabled, false);
    assert.equal(events.since(0).events.filter((e) => e.type === "reflex_finished" && e.data.name === "broken").length, 3);
  });

  it("waits out the cooldown between starts, and one that is not enabled does not fire", async () => {
    const { triggers, events, ran } = await harness();
    await define(triggers, { name: "slow", on: ["hurt"], cooldownMs: 60_000 });
    events.push("hurt", { health: 9 });
    await settle();
    events.push("hurt", { health: 8 });
    await settle();
    assert.equal(ran.length, 1);
    await define(triggers, { name: "other", on: ["hurt"], cooldownMs: 0, enabled: false });
    events.push("hurt", { health: 7 });
    await settle();
    assert.equal(ran.length, 1);
  });

  it("starts the cooldown when a firing starts, so one that waited behind a long program is not followed at once", async () => {
    const { triggers, events, ran, runner } = await harness();
    await define(triggers, { name: "eat", on: ["low_food"], cooldownMs: 100 });
    runner.running = {};
    events.push("low_food", {});
    await sleep(150);
    runner.running = null;
    triggers.idle();
    await settle();
    assert.equal(ran.length, 1);
    events.push("low_food", {});
    await settle();
    assert.equal(ran.length, 1, "the cooldown counts from the start of the firing");
    await sleep(120);
    events.push("low_food", {});
    await settle();
    assert.equal(ran.length, 2);
  });

  it("ignores the events of reflexes, and drops events while the body is not connected", async () => {
    let connected = false;
    const { triggers, events, ran } = await harness({ connected: () => connected });
    await define(triggers, { name: "any", on: ["hurt"], cooldownMs: 0 });
    events.push("reflex_fired", { name: "x" });
    events.push("hurt", {});
    await settle();
    assert.equal(ran.length, 0);
    connected = true;
    events.push("reflex_fired", { name: "x" });
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.event.type), ["hurt"]);
  });

  it("waits for a running program and runs once when it ends, however often the event came", async () => {
    const { triggers, events, ran, runner } = await harness();
    await define(triggers, { name: "react", on: ["hurt"], cooldownMs: 0 });
    runner.running = {};
    events.push("hurt", { n: 1 });
    events.push("hurt", { n: 2 });
    await settle();
    assert.equal(ran.length, 0);
    assert.equal(runner.stops, 0);
    runner.running = null;
    triggers.idle();
    await settle();
    assert.deepEqual(ran.map((r) => r.event.data.n), [1]);
  });

  it("stops the running program for a preempting one, and runs it next", async () => {
    const { triggers, events, ran, runner } = await harness();
    await define(triggers, { name: "urgent", on: ["hurt"], cooldownMs: 0, preempt: true });
    runner.running = {};
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1);
    assert.deepEqual(ran.map((r) => r.name), ["urgent"]);
    assert.equal(events.since(0).events.find((e) => e.type === "reflex_fired")!.data.preempted, true);
  });

  it("lets a higher priority preempt a running one, never an equal one", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true });
    await define(triggers, { name: "calm", on: ["night"], cooldownMs: 0 });
    await define(triggers, { name: "same", on: ["chat"], cooldownMs: 0, preempt: true });
    await define(triggers, { name: "high", on: ["hurt"], cooldownMs: 0, preempt: true, priority: 5 });
    events.push("night", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["calm"]);
    events.push("chat", { from: "ana", message: "x" });
    await settle();
    assert.equal(runner.stops, 0, "one of equal priority waits");
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1);
    assert.deepEqual(ran.map((r) => r.name), ["calm", "high"]);
    assert.equal(triggers.reflexes().find((t) => t.name === "calm")!.lastStatus, "stopped");
    held[0]!.release();
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["calm", "high", "same"]);
  });

  it("runs waiting ones highest priority first, and starts the next when the last one ends", async () => {
    const { triggers, events, ran, runner } = await harness();
    await define(triggers, { name: "low", on: ["hurt"], cooldownMs: 0, priority: -1 });
    await define(triggers, { name: "first", on: ["hurt"], cooldownMs: 0 });
    await define(triggers, { name: "top", on: ["hurt"], cooldownMs: 0, priority: 9 });
    runner.running = {};
    events.push("hurt", {});
    runner.running = null;
    triggers.idle();
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["top", "first", "low"]);
  });

  it("disables itself after three failures in a row with a reflex_disabled, and replacing it resets the run of failures", async () => {
    const { triggers, events } = await harness();
    await define(triggers, { name: "flaky", on: ["hurt"], cooldownMs: 0 }, true);
    for (let i = 0; i < 2; i++) {
      events.push("hurt", {});
      await settle();
    }
    await define(triggers, { name: "flaky", on: ["hurt"], cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    assert.equal(triggers.reflexes()[0]!.failures, 0);

    await define(triggers, { name: "bad", on: ["night"], cooldownMs: 0 }, true);
    for (let i = 0; i < 4; i++) {
      events.push("night", {});
      await settle();
    }
    const bad = triggers.reflexes().find((t) => t.name === "bad")!;
    assert.equal(bad.enabled, false);
    assert.equal(bad.fired, 3, "the fourth night did not run it");
    assert.match(bad.disabledReason!, /failed 3 times in a row; last: boom/);
    assert.deepEqual(events.since(0).events.filter((e) => e.type === "reflex_disabled").map((e) => [e.data.name, e.data.failures]), [["bad", 3]]);
  });

  it("keeps its definition and its disabled state across a reload", async () => {
    const first = await harness();
    await define(first.triggers, { name: "bad", on: ["night"], cooldownMs: 0 }, true);
    await define(first.triggers, { name: "keep", on: ["hurt"], cooldownMs: 0, when: "event.data.health < 10" });
    for (let i = 0; i < 3; i++) {
      first.events.push("night", {});
      await settle();
    }
    first.triggers.close();
    const second = await harness({ file: first.file });
    assert.deepEqual(second.triggers.reflexes().map((t) => [t.name, t.enabled]), [["bad", false], ["keep", true]]);
    assert.match(second.triggers.reflexes()[0]!.disabledReason!, /failed 3 times/);
    second.events.push("hurt", { health: 5 });
    await settle();
    assert.deepEqual(second.ran.map((r) => r.name), ["keep"]);
  });

  it("goes on counting the streak of the host it replaces, and counts the firing that ended that host", async () => {
    const first = await harness();
    await define(first.triggers, { name: "hang", on: ["night"], cooldownMs: 0 });
    first.triggers.close();
    const stored = new JsonStore(first.file).get("hang") as { updated: string };
    const events = new EventLog();
    const counts: Record<string, number>[] = [];
    const second = new Triggers({
      store: new JsonStore(first.file),
      events,
      runner: { running: null, stop: () => false },
      connected: () => true,
      bot: () => undefined,
      reflexes: true,
      register: async () => {},
      run: async () => ({ status: "ok", logs: "", durationMs: 1 }),
      counts: (failures) => counts.push(failures),
      failures: { hang: 2 },
      lost: { name: "hang", updated: stored.updated, status: "timeout", error: "host killed", durationMs: 5 },
    });
    const [def] = second.reflexes();
    assert.deepEqual([def!.failures, def!.enabled, def!.lastStatus], [3, false, "timeout"]);
    assert.deepEqual(counts, [{ hang: 3 }]);
  });

  it("keeps the numbers of one that was replaced while its old run ended", async () => {
    const { triggers, events, held } = await harness({ hold: true });
    await define(triggers, { name: "fix", on: ["hurt"], cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    await define(triggers, { name: "fix", on: ["hurt"], cooldownMs: 0 });
    held[0]!.release({ status: "error", error: "boom" });
    await settle();
    const [fix] = triggers.reflexes();
    assert.deepEqual([fix!.failures, fix!.fired, fix!.lastStatus, fix!.enabled], [0, 0, undefined, true]);
    assert.deepEqual(events.since(0).events.filter((e) => e.type === "reflex_finished").map((e) => e.data.status), ["error"]);
  });
});

describe("Triggers: the names a reflex may take", () => {
  it("refuses an action's name to a reflex, until the action is gone", async () => {
    const { triggers } = await harness();
    const actions = new Set(["pid"]);
    triggers.shareNamesWith((name) => actions.has(name));
    await assert.rejects(triggers.addReflex({ name: "pid", on: ["hurt"], routine: "ok" }), NameConflictError);
    assert.deepEqual(triggers.reflexes(), []);
    actions.delete("pid");
    await triggers.addReflex({ name: "pid", on: ["hurt"], routine: "ok" });
  });

  it("keeps a limit on reflexes, and still replaces at the cap", async () => {
    const { triggers } = await harness();
    for (let i = 0; i < MAX_TRIGGERS; i++) await triggers.addReflex({ name: `t${i}`, on: ["hurt"], routine: "ok" });
    await assert.rejects(triggers.addReflex({ name: "one-more", on: ["hurt"], routine: "ok" }), /at most 50 reflexes/);
    await assert.rejects(triggers.addReflex({ name: "one-more", on: ["hurt"], routine: "ok" }), TriggerLimitError);
    assert.equal((await triggers.addReflex({ name: "t1", on: ["chat"], routine: "ok" })).replaced, true);
  });

  it("validates a reflex, and registers nothing it refuses", async () => {
    const { triggers } = await harness();
    await assert.rejects(triggers.addReflex({ name: "r", on: ["reflex_finished"], routine: "ok" }), /cannot listen to reflex events/);
    for (const type of ["reflex_fired", "reflex_finished", "reflex_disabled", "reflex_error"]) {
      await assert.rejects(triggers.addReflex({ name: "r", on: ["hurt", type], routine: "ok" }), TriggerInvalidError, type);
    }
    await assert.rejects(triggers.addReflex({ name: "r", on: ["hurt"], routine: "Not A Routine" }), TriggerInvalidError);
    await assert.rejects(triggers.addReflex({ name: "r", on: ["hurt"], routine: "ok", when: "event.data.health <" }), /when does not compile/);
    await assert.rejects(triggers.addReflex({ name: "r.dotted", on: ["hurt"], routine: "ok" }), TriggerInvalidError);
    assert.deepEqual(triggers.reflexes(), []);
  });

  it("loads stored reflexes only where routines are offered, and never writes the ones it skips", async () => {
    const first = await harness();
    await first.triggers.addReflex({ name: "r", on: ["hurt"], routine: "ok", cooldownMs: 0 });
    first.triggers.close();
    const before = readFileSync(first.file, "utf8");
    const second = await harness({ file: first.file, reflexes: false });
    assert.deepEqual(second.triggers.reflexes(), []);
    const errors = second.events.since(0).events.filter((e) => e.type === "reflex_error");
    assert.deepEqual(errors.map((e) => e.data.name), ["r"]);
    assert.match(String(errors[0]!.data.error), /reflex needs routines/);
    second.events.push("hurt", {});
    await settle();
    assert.deepEqual(second.ran, []);
    assert.equal(readFileSync(first.file, "utf8"), before);
  });
});

/** What a code trigger of the code before reflexes stores: a `run` program, no `routine`. */
const codeEntry = { on: ["hurt"], run: "return 1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };
const reflexEntry = { on: ["hurt"], routine: "ok", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };

/** A triggers.json holding `entries`, written the way the store writes it; its path. */
async function fileOf(entries: Record<string, unknown>): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "minebot-skipped-")), "triggers.json");
  const store = new JsonStore(file);
  for (const [name, entry] of Object.entries(entries)) store.set(name, entry);
  return file;
}

/** The entry `name` holds in the file now, as the JSON text it is stored with. */
const entryText = (file: string, name: string) => JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[name]);

describe("Triggers: stored entries that are not reflexes", () => {
  const skippedEntries = { code: codeEntry, "key.login": { ...codeEntry, run: "bot.chat('/key x')" }, junk: { on: "hurt", routine: 5 }, good: reflexEntry };

  it("skips each one and reports it once, naming the migration for a code trigger, while the loadable reflexes fire", async () => {
    const file = await fileOf(skippedEntries);
    const { triggers, events, ran } = await harness({ file });
    const errors = events.since(0).events.filter((e) => e.type === "reflex_error");
    assert.deepEqual(errors.map((e) => e.data.name), ["code", "key.login", "junk"]);
    assert.match(String(errors[0]!.data.error), /code trigger.*bind a routine as a reflex after `unbind code`/);
    assert.match(String(errors[1]!.data.error), /after `unbind key\.login`/);
    assert.doesNotMatch(String(errors[2]!.data.error), /code trigger/);
    assert.deepEqual(triggers.reflexes().map((r) => r.name), ["good"]);
    assert.deepEqual([triggers.holds("code"), triggers.holds("key.login"), triggers.holds("junk"), triggers.holds("good"), triggers.holds("none")], ["skipped", "skipped", "skipped", "reflex", undefined]);
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["good"]);
    assert.equal(events.since(0).events.filter((e) => e.type === "reflex_error").length, 3, "reported once per start, not again by a firing");
  });

  it("skips a stored reflex that listens to a reflex event, as one that does not validate", async () => {
    const file = await fileOf({ loop: { ...reflexEntry, on: ["reflex_finished"] }, good: reflexEntry });
    const { triggers, events } = await harness({ file });
    assert.deepEqual(triggers.reflexes().map((r) => r.name), ["good"]);
    const [error] = events.since(0).events.filter((e) => e.type === "reflex_error");
    assert.equal(error!.data.name, "loop");
    assert.match(String(error!.data.error), /cannot listen to reflex events/);
  });

  it("leaves their stored bytes as they were through any binds, unbinds, rebinds, and firings", async () => {
    const file = await fileOf(skippedEntries);
    const before = Object.fromEntries(["code", "key.login", "junk"].map((name) => [name, entryText(file, name)]));
    const { triggers, events } = await harness({ file });
    await triggers.addReflex({ name: "fresh", on: ["night"], routine: "throws", cooldownMs: 0 });
    await triggers.addReflex({ name: "fresh", on: ["night"], routine: "throws", cooldownMs: 0, enabled: true });
    await triggers.addReflex({ name: "good", on: ["hurt"], routine: "ok", cooldownMs: 0 });
    for (let i = 0; i < 4; i++) {
      events.push("night", {});
      events.push("hurt", {});
      await settle();
    }
    assert.equal(triggers.reflexes().find((r) => r.name === "fresh")!.enabled, false, "the failing reflex disabled itself, which stores it");
    assert.equal(triggers.reflexes().find((r) => r.name === "good")!.fired, 4);
    assert.equal(triggers.removeReflex("fresh"), true);
    assert.equal(triggers.removeReflex("code"), false, "a skipped entry is not a reflex to remove");
    assert.deepEqual(Object.fromEntries(Object.keys(before).map((name) => [name, entryText(file, name)])), before);
    triggers.close();
    const reloaded = await harness({ file });
    assert.deepEqual(reloaded.triggers.reflexes().map((r) => r.name), ["good"]);
    assert.deepEqual(Object.fromEntries(Object.keys(before).map((name) => [name, entryText(file, name)])), before);
  });

  it("holds the names of skipped entries: a reflex of that name is refused naming it, and the entry is not replaced", async () => {
    const file = await fileOf(skippedEntries);
    const { triggers } = await harness({ file });
    const before = entryText(file, "code");
    await assert.rejects(triggers.addReflex({ name: "code", on: ["hurt"], routine: "ok" }), (err) => err instanceof NameConflictError && /"code" is a stored entry this body did not load/.test(err.message));
    await assert.rejects(triggers.addReflex({ name: "junk", on: ["hurt"], routine: "ok" }), NameConflictError);
    assert.equal(entryText(file, "code"), before);
    assert.equal((await triggers.addReflex({ name: "good", on: ["chat"], routine: "ok" })).replaced, true, "a loaded reflex of the name is still replaced");
  });

  it("counts skipped entries toward the limit: with 49 of them and a reflex, a new reflex is refused", async () => {
    const entries: Record<string, unknown> = { r: reflexEntry };
    for (let i = 0; i < MAX_TRIGGERS - 1; i++) entries[`c${i}`] = { ...codeEntry, run: `return ${i}` };
    const file = await fileOf(entries);
    const { triggers } = await harness({ file });
    assert.deepEqual(triggers.reflexes().map((r) => r.name), ["r"]);
    await assert.rejects(triggers.addReflex({ name: "one-more", on: ["hurt"], routine: "ok" }), TriggerLimitError);
    assert.equal((await triggers.addReflex({ name: "r", on: ["chat"], routine: "ok" })).replaced, true, "a bind that replaces a reflex is not a new name");
    assert.equal(triggers.removeSkipped("c0"), true);
    assert.equal((await triggers.addReflex({ name: "one-more", on: ["hurt"], routine: "ok" })).replaced, false, "a deleted skipped entry frees its slot");
    await assert.rejects(triggers.addReflex({ name: "and-another", on: ["hurt"], routine: "ok" }), TriggerLimitError);
  });

  it("deletes exactly one skipped entry by name, dotted names included, and frees the name", async () => {
    const file = await fileOf(skippedEntries);
    const { triggers } = await harness({ file });
    const others = { code: entryText(file, "code"), junk: entryText(file, "junk"), good: entryText(file, "good") };
    assert.equal(triggers.removeSkipped("key.login"), true);
    assert.equal(triggers.removeSkipped("key.login"), false);
    assert.equal(triggers.removeSkipped("good"), false, "a reflex is not a skipped entry");
    assert.equal(triggers.removeSkipped("missing"), false);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored), ["code", "junk", "good"]);
    assert.deepEqual({ code: entryText(file, "code"), junk: entryText(file, "junk"), good: entryText(file, "good") }, others);
    assert.equal(triggers.holds("key.login"), undefined);
    assert.equal(triggers.holds("code"), "skipped");
  });

  it("skips every entry, code triggers included, on a body without routines, and writes none of them", async () => {
    const file = await fileOf(skippedEntries);
    const before = readFileSync(file, "utf8");
    const { triggers, events, ran } = await harness({ file, reflexes: false });
    assert.deepEqual(triggers.reflexes(), []);
    assert.deepEqual(events.since(0).events.filter((e) => e.type === "reflex_error").map((e) => e.data.name), ["code", "key.login", "junk", "good"]);
    assert.equal(triggers.holds("good"), "skipped");
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran, []);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("pushes only reflex_* events, never a trigger_* one", async () => {
    const file = await fileOf(skippedEntries);
    const { events } = await harness({ file });
    events.push("hurt", {});
    await settle();
    assert.deepEqual(types(events).filter((type) => type.includes("trigger")), []);
    assert.deepEqual(types(events).filter((type) => type.startsWith("reflex_")), ["reflex_error", "reflex_error", "reflex_error", "reflex_fired", "reflex_finished"]);
  });
});
