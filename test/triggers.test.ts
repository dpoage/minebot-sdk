import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import { EventLog } from "../src/body/events.ts";
import { TriggerInvalidError, TriggerLimitError, Triggers, type StoredTrigger } from "../src/body/triggers.ts";
import { BusyError } from "../src/program/runner.ts";
import { MAX_TRIGGERS, type BodyEvent, type RunResult } from "../src/protocol/index.ts";
import { JsonStore } from "../src/store.ts";

interface Harness {
  triggers: Triggers;
  events: EventLog;
  /** What the fake runner ran, in order. */
  ran: { name: string; event: BodyEvent }[];
  /** The programs the fake runner holds open until released, oldest first. */
  held: { release: (result?: Partial<RunResult>) => void }[];
  /** Pretends a program of the agent is running. */
  runner: { running: object | null; stops: number };
  file: string;
}

/**
 * A Triggers over a fake runner: runs finish with `ok` at once, unless `hold` is set, which keeps them open.
 * `gapMs` is the time between the runner going idle and the run's result being returned, as the history's append takes.
 */
async function harness(options: { file?: string; hold?: boolean; gapMs?: number; connected?: () => boolean } = {}): Promise<Harness> {
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
      // An aborted program ends at once, and whoever ran it reports that it is idle.
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
    register: async () => {},
    run: async (trigger: StoredTrigger, event, started) => {
      if (runner.running) throw new BusyError();
      started();
      ran.push({ name: trigger.name, event });
      runner.running = {};
      try {
        if (options.hold) {
          const { promise, resolve } = Promise.withResolvers<Partial<RunResult>>();
          held.push({ release: (result) => resolve(result ?? {}) });
          return { status: "ok", logs: "", durationMs: 1, ...(await promise) };
        }
        if (trigger.run.startsWith("throw")) return { status: "error", error: "boom", logs: "", durationMs: 1 };
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
  it("stores a trigger with its defaults, replaces one of the same name, and removes it", async () => {
    const { triggers } = await harness();
    const first = await triggers.add({ name: "eat", on: ["hurt"], run: "return 1" });
    assert.equal(first.replaced, false);
    assert.deepEqual([first.trigger.cooldownMs, first.trigger.timeoutMs, first.trigger.enabled, first.trigger.preempt, first.trigger.priority], [1000, 30000, true, false, 0]);
    assert.equal((await triggers.add({ name: "eat", on: ["chat"], run: "return 2" })).replaced, true);
    assert.deepEqual(triggers.list().map((t) => [t.name, t.on]), [["eat", ["chat"]]]);
    assert.equal(triggers.remove("eat"), true);
    assert.equal(triggers.remove("eat"), false);
  });

  it("rejects bad names, trigger events, code that does not compile, and a bad `when`", async () => {
    const { triggers } = await harness();
    await assert.rejects(triggers.add({ name: "Bad Name", on: ["hurt"], run: "1" }), TriggerInvalidError);
    await assert.rejects(triggers.add({ name: "loop", on: ["trigger_finished"], run: "1" }), /cannot listen to trigger events/);
    await assert.rejects(triggers.add({ name: "syntax", on: ["hurt"], run: "const = ;" }), /run does not compile/);
    await assert.rejects(triggers.add({ name: "when", on: ["hurt"], run: "1", when: "event.data.health <" }), /when does not compile/);
    await assert.rejects(triggers.add({ name: "pattern", on: ["chat"], run: "1", match: "a(" }), /regular expression/);
    assert.deepEqual(triggers.list(), []);
  });

  it("keeps at most MAX_TRIGGERS, but still replaces at the cap", async () => {
    const { triggers } = await harness();
    for (let i = 0; i < MAX_TRIGGERS; i++) await triggers.add({ name: `t${i}`, on: ["hurt"], run: "1" });
    await assert.rejects(triggers.add({ name: "one-more", on: ["hurt"], run: "1" }), TriggerLimitError);
    assert.equal((await triggers.add({ name: "t0", on: ["chat"], run: "1" })).replaced, true);
  });

  it("survives a reload, and reports an entry it cannot load without losing the others", async () => {
    const first = await harness();
    await first.triggers.add({ name: "keep", on: ["hurt"], run: "return 1", when: "event.data.health < 10", cooldownMs: 0 });
    await first.triggers.add({ name: "off", on: ["chat"], run: "return 2", enabled: false });
    first.triggers.close();
    const store = new JsonStore(first.file);
    store.set("broken", { on: "hurt", run: 5 });
    store.set("nocompile", { ...(store.get("keep") as object), run: "const = ;" });
    const second = await harness({ file: first.file });
    assert.deepEqual(second.triggers.list().map((t) => [t.name, t.enabled]), [["keep", true], ["off", false]]);
    assert.deepEqual(second.events.since(0).events.filter((e) => e.type === "trigger_error").map((e) => e.data.name), ["broken", "nocompile"]);
    second.events.push("hurt", { health: 5 });
    await settle();
    assert.deepEqual(second.ran.map((r) => r.name), ["keep"]);
  });
});

describe("Triggers: firing", () => {
  it("runs on a matching event with the event, and records trigger_fired and trigger_finished", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "react", on: ["hurt", "night"], run: "return 1", cooldownMs: 0 });
    events.push("chat", { from: "ana", message: "hi" });
    events.push("hurt", { health: 8 });
    await settle();
    assert.deepEqual(ran.map((r) => [r.name, r.event.type, r.event.data]), [["react", "hurt", { health: 8 }]]);
    const log = events.since(0).events.filter((e) => e.type.startsWith("trigger_"));
    assert.deepEqual(log.map((e) => e.type), ["trigger_fired", "trigger_finished"]);
    assert.deepEqual(log[0]!.data, { name: "react", event: { seq: 2, type: "hurt" } });
    assert.equal(log[1]!.data.status, "ok");
    assert.equal(triggers.list()[0]!.fired, 1);
  });

  it("filters chat by sender and pattern, and by a `when` expression over the event and the bot", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "ana", on: ["chat"], run: "1", from: "Ana", match: "^come", cooldownMs: 0 });
    await triggers.add({ name: "hp", on: ["hurt"], run: "1", when: "event.data.health < 10 && bot.health === 20", cooldownMs: 0 });
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

  it("never lets a `when` change the event the log holds, and cuts off one that never ends", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "mutate", on: ["hurt"], run: "1", when: "(event.data.health = 0, true)", cooldownMs: 0 });
    events.push("hurt", { health: 7 });
    await settle();
    assert.equal(events.since(0).events[0]!.data.health, 7);
    assert.equal(ran.length, 1);
    await triggers.add({ name: "spin", on: ["night"], run: "1", when: "(() => { while (true); })()", cooldownMs: 0 });
    events.push("night", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["mutate"]);
    assert.match(String(triggers.list().find((t) => t.name === "spin")!.lastError), /^when: Script execution timed out/);
  });

  it("waits out the cooldown, and a disabled trigger does not fire", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "slow", on: ["hurt"], run: "1", cooldownMs: 60_000 });
    events.push("hurt", { health: 9 });
    await settle();
    events.push("hurt", { health: 8 });
    await settle();
    assert.equal(ran.length, 1);
    triggers.setEnabled("slow", false);
    await triggers.add({ name: "other", on: ["hurt"], run: "1", cooldownMs: 0, enabled: false });
    events.push("hurt", { health: 7 });
    await settle();
    assert.equal(ran.length, 1);
  });

  it("ignores events of triggers themselves", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "any", on: ["hurt"], run: "1", cooldownMs: 0 });
    events.push("trigger_fired", { name: "x" });
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.event.type), ["hurt"]);
  });

  it("drops events while the body is not connected", async () => {
    let connected = false;
    const { triggers, events, ran } = await harness({ connected: () => connected });
    await triggers.add({ name: "react", on: ["hurt"], run: "1", cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    assert.equal(ran.length, 0);
    connected = true;
    events.push("hurt", {});
    await settle();
    assert.equal(ran.length, 1);
  });
});

describe("Triggers: queue and preemption", () => {
  it("waits for a running program, and runs once when it ends, however often the event came", async () => {
    const { triggers, events, ran, runner } = await harness();
    await triggers.add({ name: "react", on: ["hurt"], run: "1", cooldownMs: 0 });
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

  it("stops the running program for a preempting trigger, and runs it next", async () => {
    const { triggers, events, ran, runner } = await harness();
    await triggers.add({ name: "urgent", on: ["hurt"], run: "1", cooldownMs: 0, preempt: true });
    runner.running = {};
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1);
    assert.deepEqual(ran.map((r) => r.name), ["urgent"]);
    assert.equal(events.since(0).events.find((e) => e.type === "trigger_fired")!.data.preempted, true);
  });

  it("lets a higher priority preempt a running trigger, never an equal one", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true });
    await triggers.add({ name: "calm", on: ["night"], run: "1", cooldownMs: 0 });
    await triggers.add({ name: "same", on: ["chat"], run: "1", cooldownMs: 0, preempt: true });
    await triggers.add({ name: "high", on: ["hurt"], run: "1", cooldownMs: 0, preempt: true, priority: 5 });
    events.push("night", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["calm"]);
    events.push("chat", { from: "ana", message: "x" });
    await settle();
    assert.equal(runner.stops, 0, "a trigger of equal priority waits");
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1);
    assert.deepEqual(ran.map((r) => r.name), ["calm", "high"]);
    assert.equal(triggers.list().find((t) => t.name === "calm")!.lastStatus, "stopped");
    held[0]!.release();
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["calm", "high", "same"]);
  });

  it("runs waiting triggers highest priority first", async () => {
    const { triggers, events, ran, runner } = await harness();
    await triggers.add({ name: "low", on: ["hurt"], run: "1", cooldownMs: 0, priority: -1 });
    await triggers.add({ name: "first", on: ["hurt"], run: "1", cooldownMs: 0 });
    await triggers.add({ name: "top", on: ["hurt"], run: "1", cooldownMs: 0, priority: 9 });
    runner.running = {};
    events.push("hurt", {});
    runner.running = null;
    triggers.idle();
    await settle();
    // Each run ends at once and starts the next waiting one.
    assert.deepEqual(ran.map((r) => r.name), ["top", "first", "low"]);
  });

  it("starts the next firing when the last one ends, and leaves a busy runner alone", async () => {
    const { triggers, events, ran, held } = await harness({ hold: true });
    await triggers.add({ name: "a", on: ["hurt"], run: "1", cooldownMs: 0 });
    await triggers.add({ name: "b", on: ["hurt"], run: "1", cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["a"]);
    held[0]!.release();
    await settle();
    assert.deepEqual(ran.map((r) => r.name), ["a", "b"]);
    held[1]!.release();
    await settle();
    assert.deepEqual(types(events).filter((t) => t === "trigger_finished").length, 2);
  });
});

describe("Triggers: failures", () => {
  it("disables a trigger that fails three times in a row, and a later success resets the count", async () => {
    const { triggers, events } = await harness();
    await triggers.add({ name: "flaky", on: ["hurt"], run: "throw 1", cooldownMs: 0 });
    for (let i = 0; i < 2; i++) {
      events.push("hurt", {});
      await settle();
    }
    await triggers.add({ name: "flaky", on: ["hurt"], run: "return 1", cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    assert.equal(triggers.list()[0]!.failures, 0);

    await triggers.add({ name: "bad", on: ["night"], run: "throw 1", cooldownMs: 0 });
    for (let i = 0; i < 4; i++) {
      events.push("night", {});
      await settle();
    }
    const bad = triggers.list().find((t) => t.name === "bad")!;
    assert.equal(bad.enabled, false);
    assert.equal(bad.fired, 3, "the fourth night did not run it");
    assert.match(bad.disabledReason!, /failed 3 times in a row; last: boom/);
    const disabled = events.since(0).events.filter((e) => e.type === "trigger_disabled");
    assert.deepEqual(disabled.map((e) => [e.data.name, e.data.failures]), [["bad", 3]]);

    const enabled = triggers.setEnabled("bad", true);
    assert.deepEqual([enabled.enabled, enabled.failures, enabled.disabledReason], [true, 0, undefined]);
  });

  it("persists the disabled state", async () => {
    const first = await harness();
    await first.triggers.add({ name: "bad", on: ["night"], run: "throw 1", cooldownMs: 0 });
    for (let i = 0; i < 3; i++) {
      first.events.push("night", {});
      await settle();
    }
    const second = await harness({ file: first.file });
    assert.equal(second.triggers.list()[0]!.enabled, false);
    assert.match(second.triggers.list()[0]!.disabledReason!, /failed 3 times/);
  });

  it("counts a `when` that throws as a failure without running the program", async () => {
    const { triggers, events, ran } = await harness();
    await triggers.add({ name: "broken", on: ["hurt"], run: "1", when: "event.nothing.deeper", cooldownMs: 0 });
    for (let i = 0; i < 3; i++) {
      events.push("hurt", {});
      await settle();
    }
    assert.equal(ran.length, 0);
    assert.equal(triggers.list()[0]!.enabled, false);
    assert.equal(events.since(0).events.filter((e) => e.type === "trigger_finished").length, 3);
  });
});

describe("Triggers: races between a run's end and its result", () => {
  it("keeps the priority of a firing that started while the previous one was still being recorded", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true, gapMs: 30 });
    await triggers.add({ name: "chore", on: ["night"], run: "1", cooldownMs: 0 });
    await triggers.add({ name: "flee", on: ["hurt"], run: "1", cooldownMs: 0, priority: 5 });
    await triggers.add({ name: "eat", on: ["low_food"], run: "1", cooldownMs: 0, preempt: true });
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

  it("stops a program that started after the one it stopped, instead of waiting it out", async () => {
    const { triggers, events, ran, held, runner } = await harness({ hold: true, gapMs: 20 });
    await triggers.add({ name: "calm", on: ["night"], run: "1", cooldownMs: 0 });
    await triggers.add({ name: "flee", on: ["hurt"], run: "1", cooldownMs: 0, preempt: true, priority: 5 });
    events.push("night", {});
    await settle();
    events.push("hurt", {});
    await settle();
    assert.equal(runner.stops, 1, "calm was stopped for flee");
    // calm's runner is idle and its result is still being written when the agent starts a program.
    runner.running = {};
    await sleep(40);
    await settle();
    assert.equal(runner.stops, 2, "the agent's program is stopped too");
    assert.deepEqual(ran.map((r) => r.name), ["calm", "flee"]);
    void held;
  });

  it("starts the cooldown when a firing starts, so one that waited behind a long program is not followed at once", async () => {
    const { triggers, events, ran, runner } = await harness();
    await triggers.add({ name: "eat", on: ["low_food"], run: "1", cooldownMs: 100 });
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

  it("keeps the numbers of a trigger that was replaced while its old run ended", async () => {
    const { triggers, events, held } = await harness({ hold: true });
    await triggers.add({ name: "fix", on: ["hurt"], run: "1", cooldownMs: 0 });
    events.push("hurt", {});
    await settle();
    await triggers.add({ name: "fix", on: ["hurt"], run: "2", cooldownMs: 0 });
    held[0]!.release({ status: "error", error: "boom" });
    await settle();
    const [fix] = triggers.list();
    assert.deepEqual([fix!.failures, fix!.fired, fix!.lastStatus, fix!.enabled], [0, 0, undefined, true]);
    assert.deepEqual(events.since(0).events.filter((e) => e.type === "trigger_finished").map((e) => e.data.status), ["error"]);
  });
});
