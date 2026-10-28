import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { EventLog } from "../src/body/events.ts";
import { Triggers, type StoredReflex } from "../src/host/triggers.ts";
import { BusyError } from "../src/program/runner.ts";
import type { RunResult } from "../src/protocol/index.ts";
import type { TriggerDisabled, TriggerFinished } from "../src/protocol/host.ts";
import { JsonStore } from "../src/store.ts";

/** The death breaker (mb-znn.4): a reflex that the player keeps dying around is disabled, and says why. */

const T0 = 1_800_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

type Position = { x: number; y: number; z: number };

/** The reflex_disabled reason with the places filled in. */
const reasonOf = (last: string) =>
  `the player died 2 times within 10 min during or right after its runs (last: ${last}); bind it again with bind_routine and its full settings (list_routines shows them) to turn it back on`;

interface Harness {
  triggers: Triggers;
  events: EventLog;
  file: string;
  /** The reflexes that started, in order. */
  ran: string[];
  /** The `counts` calls, when the harness was built with that dependency. */
  counted: { failures: Record<string, number>; ended?: { finished?: TriggerFinished; disabled?: TriggerDisabled } }[];
  /** Ends the run a reflex holds open; false when it holds none. */
  release: (name: string) => Promise<boolean>;
  /** Sets the clock (ms after T0) and lets everything that follows from the last step settle. */
  at: (ms: number) => Promise<void>;
  /** Pushes an event at the clock's time and lets it settle. */
  push: (type: string, data?: Record<string, unknown>) => Promise<void>;
  /** Pushes a death at the clock's time. */
  die: (data?: { position?: Position; cause?: string }) => Promise<void>;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await setImmediate();
};

/**
 * A Triggers over a fake runner and a fake clock (Date only: every event is stamped by it). Runs end at once, or when
 * `hold` is set, when the test releases them, which is how a run takes as long as the incident's collect-loot did.
 */
async function harness(options: { file?: string; hold?: boolean; counts?: boolean; username?: string } = {}): Promise<Harness> {
  const file = options.file ?? path.join(await mkdtemp(path.join(tmpdir(), "minebot-breaker-")), "triggers.json");
  const username = options.username ?? "Fartmastery";
  const events = new EventLog();
  const runner = { running: null as object | null };
  const ran: string[] = [];
  const counted: Harness["counted"] = [];
  const open = new Map<string, () => void>();
  const triggers: Triggers = new Triggers({
    store: new JsonStore(file),
    events,
    runner: {
      get running() {
        return runner.running;
      },
      stop() {
        for (const end of open.values()) end();
        return true;
      },
    },
    connected: () => true,
    bot: () => (username ? { username } : {}),
    reflexes: true,
    register: async () => {},
    ...(options.counts && { counts: (failures: Record<string, number>, ended?: Harness["counted"][number]["ended"]) => void counted.push({ failures, ended }) }),
    run: async (reflex: StoredReflex, _event, started): Promise<RunResult> => {
      if (runner.running) throw new BusyError();
      started();
      ran.push(reflex.name);
      runner.running = {};
      try {
        if (options.hold) {
          const { promise, resolve } = Promise.withResolvers<void>();
          open.set(reflex.name, resolve);
          await promise;
          open.delete(reflex.name);
        }
        return { status: "ok", logs: "", durationMs: 1 };
      } finally {
        runner.running = null;
      }
    },
  });
  const at = async (ms: number) => {
    mock.timers.setTime(T0 + ms);
    await settle();
  };
  const push = async (type: string, data: Record<string, unknown> = {}) => {
    events.push(type, data);
    await settle();
  };
  return {
    triggers,
    events,
    file,
    ran,
    counted,
    at,
    push,
    die: async (data = { position: { x: 0, y: 64, z: 0 } }) => void (await push("death", data)),
    release: async (name) => {
      const end = open.get(name);
      if (!end) return false;
      end();
      await settle();
      return true;
    },
  };
}

const typed = (events: EventLog, type: string) => events.since(0).events.filter((e) => e.type === type);
const stored = (h: Harness, name: string) => new JsonStore(h.file).get(name) as StoredReflex | undefined;

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: T0 }));
afterEach(() => mock.timers.reset());

/**
 * The deaths, spawns and reflex ends of the 2026-10-27 00:19-00:43 incident (events 5404-6115 of the agent's log), seconds
 * from its first death. collect-loot (bound on death, preempt) walked the player back to an underwater grave and drowned
 * him 100-104 s after each run ended ok; sleep-camp (bound on night) fired twice in between.
 */
const INCIDENT: ([number, "death" | "spawn", Position] | [number, "night"] | [number, "end", string])[] = [
  [0.0, "death", { x: -289.5, y: 43, z: 102.52 }],
  [0.048, "spawn", { x: -504.5, y: 77, z: 94.5 }],
  [99.021, "end", "collect-loot"],
  [183.15, "night"],
  [186.152, "end", "sleep-camp"],
  [202.4, "death", { x: -286.36, y: 42, z: 104.64 }],
  [202.445, "spawn", { x: -517.5, y: 76, z: 105.5 }],
  [302.729, "end", "collect-loot"],
  [406.201, "death", { x: -286.5, y: 42, z: 104.5 }],
  [406.247, "spawn", { x: -503.5, y: 78, z: 106.5 }],
  [499.422, "end", "collect-loot"],
  [599.452, "death", { x: -286.5, y: 42, z: 104.5 }],
  [599.5, "spawn", { x: -521.5, y: 72, z: 91.5 }],
  [710.822, "end", "collect-loot"],
  [811.5, "death", { x: -286.5, y: 42, z: 104.5 }],
  [811.555, "spawn", { x: -507.5, y: 73, z: 104.5 }],
  [911.82, "end", "collect-loot"],
  [1012.205, "death", { x: -286.5, y: 42, z: 104.5 }],
  [1012.35, "spawn", { x: -501.5, y: 78, z: 106.5 }],
  [1123.28, "end", "collect-loot"],
  [1224.659, "death", { x: -286.5, y: 42, z: 104.5 }],
  [1224.72, "spawn", { x: -510.5, y: 74, z: 90.5 }],
  [1328.937, "end", "collect-loot"],
  [1383.157, "night"],
  [1386.16, "end", "sleep-camp"],
  [1430.708, "death", { x: -286.5, y: 42, z: 104.49 }],
  [1430.751, "spawn", { x: -518.5, y: 177, z: 89.5 }],
  [1432.366, "end", "collect-loot"],
];

const bindIncident = async (h: Harness) => {
  await h.triggers.addReflex({ name: "collect-loot", on: ["death"], routine: "collect-loot", cooldownMs: 0, preempt: true, priority: 5 });
  await h.triggers.addReflex({ name: "sleep-camp", on: ["night"], routine: "sleep-camp", cooldownMs: 0 });
};

describe("death breaker: the incident replay", () => {
  it("disables collect-loot at the second death that falls after its runs, and no third firing starts", async () => {
    const h = await harness({ hold: true });
    await bindIncident(h);
    for (const [seconds, kind, arg] of INCIDENT) {
      await h.at(Math.round(seconds * SECOND));
      if (kind === "end") await h.release(arg as string);
      else if (kind === "night") await h.push("night", { timeOfDay: 16158 });
      else await h.push(kind, { position: arg });
    }
    // Deaths 2 and 3 each fell 103 s after a run of collect-loot ended; death 1 fell before any run of it.
    assert.deepEqual(h.ran.filter((name) => name === "collect-loot").length, 2, `firings: ${h.ran.join(" ")}`);
    const disabled = typed(h.events, "reflex_disabled");
    assert.equal(disabled.length, 1, "reported once; the five later deaths find it disabled");
    assert.deepEqual(disabled[0]!.data, { name: "collect-loot", failures: 0, reason: reasonOf("died at -286 42 105") });
    assert.equal(disabled[0]!.time, T0 + 406_201, "at the second death that counts, the third of the replay");
    const firedAfter = typed(h.events, "reflex_fired").filter((e) => e.seq > disabled[0]!.seq && e.data.name === "collect-loot");
    assert.deepEqual(firedAfter, []);
    const reflex = stored(h, "collect-loot")!;
    assert.deepEqual([reflex.enabled, reflex.disabledReason], [false, reasonOf("died at -286 42 105")], "saved to the store");
    assert.equal(h.triggers.reflexes().find((r) => r.name === "collect-loot")!.enabled, false);
    // sleep-camp was charged once by death 2 (it ended 16 s before), and once more by death 8: 20 minutes apart.
    assert.equal(h.triggers.reflexes().find((r) => r.name === "sleep-camp")!.enabled, true);
    assert.equal(h.ran.filter((name) => name === "sleep-camp").length, 2);
  });
});

/** Binds `chat`-fired reflex `name`, fires it at `startMs` and ends it at once. */
const fire = async (h: Harness, startMs: number) => {
  await h.at(startMs);
  await h.push("chat", { message: "go" });
};
const bindOnChat = (h: Harness, name = "r") => h.triggers.addReflex({ name, on: ["chat"], routine: "ok", cooldownMs: 0 });
const enabled = (h: Harness, name = "r") => h.triggers.reflexes().find((r) => r.name === name)!.enabled;

describe("death breaker: what counts", () => {
  it("counts a death up to 180 s after the firing ended, and not one 181 s after", async () => {
    for (const [after, disables] of [[180 * SECOND, true], [181 * SECOND, false]] as const) {
      const h = await harness();
      await bindOnChat(h);
      await fire(h, 0);
      await h.at(after);
      await h.die();
      await fire(h, after + 10 * SECOND);
      await h.at(after + 70 * SECOND);
      await h.die();
      assert.equal(enabled(h), !disables, `first death ${after / SECOND} s after the end`);
      assert.equal(typed(h.events, "reflex_disabled").length, disables ? 1 : 0);
    }
  });

  it("does not disable on two deaths 11 minutes apart, and does on 10", async () => {
    for (const [gap, disables] of [[11 * MINUTE, false], [10 * MINUTE, true]] as const) {
      const h = await harness();
      await bindOnChat(h);
      await fire(h, 0);
      await h.at(60 * SECOND);
      await h.die();
      await fire(h, gap);
      await h.at(60 * SECOND + gap);
      await h.die();
      assert.equal(enabled(h), !disables, `second death ${gap / MINUTE} min after the first`);
    }
  });

  it("measures the 10 minutes between counted deaths, so a death too late for the first pairs with the next", async () => {
    const h = await harness();
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(60 * SECOND);
    await h.die();
    await fire(h, 650 * SECOND);
    await h.at(720 * SECOND);
    await h.die();
    assert.equal(enabled(h), true, "11 minutes after the first");
    await h.at(760 * SECOND);
    await h.die();
    assert.equal(enabled(h), false, "40 s after the second, which fell 110 s after a run ended");
  });

  it("counts a death that falls during the firing, naming the cause the death carries", async () => {
    const h = await harness({ hold: true });
    await bindOnChat(h);
    await fire(h, 0);
    assert.deepEqual(h.ran, ["r"]);
    await h.at(30 * SECOND);
    await h.die({ position: { x: 10.7, y: -3, z: 5 }, cause: "Fartmastery drowned" });
    assert.equal(enabled(h), true, "one death in 10 minutes is not enough");
    await h.at(90 * SECOND);
    await h.die({ position: { x: -289.5, y: 43, z: 102.52 }, cause: "Fartmastery drowned\nsecond line" });
    assert.equal(enabled(h), false);
    assert.deepEqual(typed(h.events, "reflex_disabled").map((e) => e.data), [{ name: "r", failures: 0, reason: reasonOf("drowned at -289 43 103") }]);
    await h.release("r");
    assert.deepEqual(typed(h.events, "reflex_finished").map((e) => [e.data.name, e.data.status]), [["r", "ok"]], "the run's end is still reported");
    assert.equal(typed(h.events, "reflex_disabled").length, 1);
  });

  it("leaves the player's own name out of the cause, wherever the death message repeats it", async () => {
    const h = await harness();
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(20 * SECOND);
    await h.die({ position: { x: 1.6, y: 2.4, z: 3 } });
    await h.at(40 * SECOND);
    await h.die({ position: { x: 1.6, y: 2.4, z: 3 }, cause: "Fartmastery was slain by Fartmastery" });
    assert.equal(h.triggers.reflexes()[0]!.disabledReason, reasonOf("was slain by at 2 2 3"));
  });

  it("drops the leading player name when the body has no bot to ask, and says died when the cause is only the name", async () => {
    const blind = await harness({ username: "" });
    await bindOnChat(blind);
    await fire(blind, 0);
    await blind.at(20 * SECOND);
    await blind.die({ position: { x: 0, y: 64, z: 0 }, cause: "suffocated" });
    await blind.at(40 * SECOND);
    await blind.die({ position: { x: 0, y: 64, z: 0 }, cause: "Fartmastery drowned" });
    assert.equal(blind.triggers.reflexes()[0]!.disabledReason, reasonOf("drowned at 0 64 0"), "no bot: the message's leading name is dropped");

    const h = await harness();
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(20 * SECOND);
    await h.die({ position: { x: 0, y: 64, z: 0 }, cause: "suffocated" });
    await h.at(40 * SECOND);
    await h.die({ position: { x: 0, y: 64, z: 0 }, cause: "Fartmastery" });
    assert.equal(h.triggers.reflexes()[0]!.disabledReason, reasonOf("died at 0 64 0"), "a cause that is only the name says died");
  });

  it("counts a death in the same tick as the firing's end", async () => {
    const h = await harness({ hold: true });
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(30 * SECOND);
    await h.die();
    await h.at(60 * SECOND);
    // The run has settled, and Triggers has not yet been told: a death now falls in the firing.
    const ended = h.release("r");
    h.events.push("death", { position: { x: 1, y: 2, z: 3 } });
    await ended;
    await settle();
    assert.equal(enabled(h), false);
  });

  it("charges each reflex a death fell around separately, and skips the ones whose runs ended more than 180 s before", async () => {
    const h = await harness();
    await h.triggers.addReflex({ name: "old", on: ["ping"], routine: "ok", cooldownMs: 0 });
    await bindOnChat(h, "a");
    await bindOnChat(h, "b");
    await h.at(0);
    await h.push("ping");
    await fire(h, 100 * SECOND);
    await h.at(110 * SECOND);
    await h.die();
    await h.at(250 * SECOND);
    await h.die();
    assert.deepEqual([enabled(h, "a"), enabled(h, "b"), enabled(h, "old")], [false, false, true]);
    assert.deepEqual(typed(h.events, "reflex_disabled").map((e) => e.data.name).sort(), ["a", "b"]);
  });

  it("does not count a death against a reflex that never fired", async () => {
    const h = await harness();
    await bindOnChat(h);
    await h.at(0);
    for (let i = 1; i <= 4; i++) {
      await h.at(i * 30 * SECOND);
      await h.die();
    }
    assert.equal(enabled(h), true);
  });
});

describe("death breaker: the disable", () => {
  it("gives the reason the death's own words when the event carries no cause, and keeps the binding", async () => {
    const h = await harness();
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(20 * SECOND);
    await h.die({ position: { x: 1.9, y: 70, z: -0.5 } });
    await h.at(40 * SECOND);
    await h.die({ position: { x: 1.9, y: 70, z: -0.5 }, cause: "" });
    assert.equal(h.triggers.reflexes().find((r) => r.name === "r")!.disabledReason, reasonOf("died at 2 70 0"));
    assert.deepEqual(h.triggers.reflexes().map((r) => r.name), ["r"]);
  });

  it("is reported to counts, with the disable, when the host has counts, and pushes no event", async () => {
    const h = await harness({ counts: true });
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(20 * SECOND);
    await h.die();
    await h.at(40 * SECOND);
    h.counted.length = 0;
    await h.die();
    assert.equal(h.counted.length, 1);
    assert.equal(h.counted[0]!.ended?.finished, undefined);
    assert.deepEqual(h.counted[0]!.ended?.disabled, { name: "r", failures: 0, reason: reasonOf("died at 0 64 0") });
    assert.deepEqual(typed(h.events, "reflex_disabled"), []);
  });

  it("keeps the disable across a reload, and does not fire the disabled reflex on the event that disabled it", async () => {
    const h = await harness();
    await h.triggers.addReflex({ name: "grave", on: ["death"], routine: "ok", cooldownMs: 0 });
    await h.at(0);
    await h.die();
    await h.at(100 * SECOND);
    await h.die();
    await h.at(200 * SECOND);
    await h.die();
    assert.deepEqual(h.ran, ["grave", "grave"], "the third death disabled it before it could match");
    h.triggers.close();
    const second = await harness({ file: h.file });
    const [reflex] = second.triggers.reflexes();
    assert.deepEqual([reflex!.enabled, reflex!.disabledReason], [false, reasonOf("died at 0 64 0")]);
  });

  it("is undone by binding it again, with the counts starting over", async () => {
    const h = await harness();
    await bindOnChat(h);
    await fire(h, 0);
    await h.at(20 * SECOND);
    await h.die();
    await h.at(40 * SECOND);
    await h.die();
    assert.equal(enabled(h), false);
    await h.at(50 * SECOND);
    const again = await bindOnChat(h);
    assert.equal(again.replaced, true);
    assert.equal(enabled(h), true);
    assert.equal(h.triggers.reflexes()[0]!.disabledReason, undefined);
    assert.deepEqual(stored(h, "r")!.enabled, true);
    await fire(h, 60 * SECOND);
    await h.at(80 * SECOND);
    await h.die();
    assert.equal(enabled(h), true, "the two deaths before the new binding are forgotten");
    await h.at(100 * SECOND);
    await h.die();
    assert.equal(enabled(h), false);
    assert.equal(typed(h.events, "reflex_disabled").length, 2);
  });
});
