// A preemption is an abort like /stop's and a timeout's: a program that does not settle within the
// grace of it ends with its host, whether it awaits forever or blocks the host's main thread after
// catching the abort. The supervisor's side runs against the trigger fixture
// (test/fixtures/host/trigger-host.ts: the real RunReporter, Triggers, and ProgramRunner over the
// real channel) with a small grace; the host-side rules (which run a preemption aborts, and when, and
// which runs the reporter's run slot refuses) run in-process against a RunReporter over a real
// ProgramRunner, whose channel is held open by the test. The body's own Triggers are checked to see
// the slot and send their preemptions through the recorder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { FromHost, HostInit } from "../src/protocol/host.ts";
import type { BodyEvent, RunResult } from "../src/protocol/index.ts";
import type { RunOutcome } from "../src/program/runner.ts";
import type { ProgramScope } from "../src/program/scope.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-preempt-deadline-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
const TRIGGER_FIXTURE = path.join(import.meta.dirname, "fixtures", "host", "trigger-host.ts");
const GRACE_MS = 500;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads.
const { EventLog } = await import("../src/body/events.ts");
const { HostProcess } = await import("../src/body/host-process.ts");
const { ProgramHistory } = await import("../src/body/history.ts");
const { HostEvents, RunReporter } = await import("../src/host/channel.ts");
const { buildWorld } = await import("../src/host/world.ts");
const { BusyError, ProgramRunner } = await import("../src/program/runner.ts");
const { hungCause, restartedError, KILL_MARGIN_MS } = await import("../src/protocol/host.ts");

/** The latest, after a preemption, that the run answers or its firing ends: the grace, the supervisor's margin, and a second for the kill and the answer. */
const BOUND_MS = GRACE_MS + KILL_MARGIN_MS + 1_000;
/** Longer than the bound, so a program the supervisor leaves alone to its spin is told by the time it takes. */
const SPIN_MS = 5_000;
const CAUSE = hungCause(GRACE_MS);

const hosts: InstanceType<typeof HostProcess>[] = [];
after(async () => {
  for (const host of hosts) await host.close();
  rmSync(ROOT, { recursive: true, force: true });
});

interface Script {
  reflex: { name: string; on: string[]; run: string; timeoutMs: number; cooldownMs: number; preempt?: boolean; priority?: number };
  burstOnEvent?: { type: string; count: number; bytes: number };
}

interface Scripted {
  host: InstanceType<typeof HostProcess>;
  events: InstanceType<typeof EventLog>;
}

let scripts = 0;
/** `ackDelayMs`: how late the supervisor's history writes the start of the run that /call answers `return 2;` for, as a loaded disk makes it late. */
async function scripted(script: Script, options: { ackDelayMs?: number } = {}): Promise<Scripted> {
  const dir = path.join(ROOT, `scripted-${++scripts}`);
  mkdirSync(dir);
  const events = new EventLog();
  const init = { stateDir: dir, startedAt: "t0", deaths: 0, reconnects: 0, applyMilestones: true, script: { graceMs: GRACE_MS, ...script } } as unknown as HostInit;
  const history = new ProgramHistory({ file: path.join(dir, "history.jsonl") });
  const begin = history.begin.bind(history);
  history.begin = async (code, extra) => {
    if (options.ackDelayMs && code === "return 2;") await sleep(options.ackDelayMs);
    return begin(code, extra);
  };
  const host = new HostProcess({ init, events, history, entry: TRIGGER_FIXTURE, graceMs: GRACE_MS });
  hosts.push(host);
  await host.start();
  host.join();
  return { host, events };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const post = (t: Scripted, url: string, body: unknown) => t.host.forward({ method: "POST", url, body: json(body), tooLarge: false });
async function pidOf(t: Scripted): Promise<number> {
  const { body } = await t.host.forward({ method: "GET", url: "/ping", body: null, tooLarge: false });
  const answer = body as { pid: number }; // the trigger fixture answers /ping with its pid
  return answer.pid;
}
const eventsOf = (t: Scripted, type: string): BodyEvent[] => t.events.since(0).events.filter((event) => event.type === type);
async function waitFor(t: Scripted, type: string, since = 0): Promise<BodyEvent> {
  const { event } = await t.events.wait({ types: [type], since, timeoutMs: 15_000 });
  assert.ok(event, `no ${type} event`);
  return event;
}

/** Catches the abort, then holds the host's main thread, as a program that never yields does. */
const BLOCKS = `try { await ctx.sleep(1e9); } catch {} const t = Date.now(); while (Date.now() - t < ${SPIN_MS}) {} return 1;`;
/** Catches the abort and never settles. */
const AWAITS_FOREVER = "try { await ctx.sleep(1e9); } catch {} await new Promise(() => {}); return 1;";
/** Catches the abort and settles at once. */
const SETTLES = "try { await ctx.sleep(1e9); } catch {} return 1;";

const reflex = (run: string, extra: object = {}) => ({ name: "reflex", on: ["fire"], run, timeoutMs: 1_000, cooldownMs: 0, preempt: true, ...extra });

/** Starts /call `code` (a routine that outlasts everything, with its timeout far off) and waits until its code runs; the run's answer is returned in an object, so awaiting this does not wait for it. */
async function startRun(t: Scripted, code: string): Promise<{ answer: Promise<{ status: number; body: unknown }> }> {
  const since = t.events.since(0).next;
  const answer = post(t, "/call", { source: code, timeoutMs: 60_000 });
  await waitFor(t, "acked", since);
  return { answer };
}

describe("a preemption's abort is backed by the supervisor's deadline", () => {
  const legs = {
    "a program that blocks the host after catching the abort": { code: BLOCKS, burst: undefined },
    "a program that awaits forever after catching the abort": { code: AWAITS_FOREVER, burst: undefined },
    "a program that blocks the host with a burst of events queued in the channel at the ask": { code: BLOCKS, burst: { type: "fire", count: 150, bytes: 4_000 } },
  };
  for (const [name, { code, burst }] of Object.entries(legs)) {
    it(`restarts the host of ${name}, and answers the run stopped, within the grace and the margins of the ask`, { timeout: 30_000 }, async () => {
      const t = await scripted({ reflex: reflex("return 1;"), ...(burst && { burstOnEvent: burst }) });
      const before = await pidOf(t);
      const { answer } = await startRun(t, code);
      const askedAt = Date.now();
      t.events.push("fire");
      const { status, body } = await answer;
      const tookMs = Date.now() - askedAt;
      assert.equal(status, 200);
      const result = body as RunResult;
      const { status: ended, error } = result;
      assert.deepEqual({ ended, error }, { ended: "stopped", error: restartedError(CAUSE) });
      assert.ok(tookMs <= BOUND_MS, `the run answered ${tookMs} ms after the ask (bound ${BOUND_MS} ms)`);
      assert.notEqual(await pidOf(t), before, "the host was not replaced");
      assert.equal(eventsOf(t, "disconnected").length, 1);
    });
  }

  it("restarts the host of a trigger's firing that a higher firing preempts and that blocks the host, and ends it stopped within the bound", { timeout: 30_000 }, async () => {
    const t = await scripted({ reflex: { name: "low", on: ["low"], run: BLOCKS, timeoutMs: 60_000, cooldownMs: 0 } });
    const before = await pidOf(t);
    await post(t, "/triggers", { name: "high", on: ["high"], run: "return 1;", preempt: true, priority: 1, cooldownMs: 0 });
    t.events.push("low");
    await waitFor(t, "reflex_fired");
    const since = t.events.since(0).next;
    const askedAt = Date.now();
    t.events.push("high");
    await waitFor(t, "disconnected", since);
    const tookMs = Date.now() - askedAt;
    assert.ok(tookMs <= BOUND_MS, `the host was restarted ${tookMs} ms after the ask (bound ${BOUND_MS} ms)`);
    const finished = await waitFor(t, "reflex_finished");
    assert.deepEqual({ name: finished.data.name, status: finished.data.status, error: finished.data.error }, { name: "low", status: "stopped", error: restartedError(CAUSE) });
    assert.notEqual(await pidOf(t), before);
  });

  it("leaves the host alone when the preempted program settles within the grace, and runs the preempting firing as preempted", { timeout: 30_000 }, async () => {
    const t = await scripted({ reflex: reflex("return 1;") });
    const before = await pidOf(t);
    const { answer } = await startRun(t, SETTLES);
    t.events.push("fire");
    const result = (await answer).body as RunResult;
    assert.equal(result.status, "stopped");
    assert.equal(result.error, undefined);
    const finished = await waitFor(t, "reflex_finished");
    assert.equal(finished.data.status, "ok");
    assert.deepEqual(eventsOf(t, "reflex_fired").map((e) => e.data.preempted), [true]);
    // Past the deadline the supervisor would have set for the preempted run.
    await sleep(GRACE_MS + KILL_MARGIN_MS + 500);
    assert.equal(await pidOf(t), before, "the host of a program that settled in its grace was replaced");
    assert.equal(eventsOf(t, "disconnected").length, 0);
  });
});

describe("a preemption after a run refused as busy still stops the run that executes", () => {
  /** Asks for a second /call while one executes: the fixture's /call, like the body's, has the runner refuse it. */
  const busy = (t: Scripted) => post(t, "/call", { source: "return 2;", timeoutMs: 1_000 });
  /** The fixture's answer to a /call the runner refused: the run slot's owner and how long it has held it. */
  async function refused(answer: Promise<{ status: number; body: unknown }>): Promise<void> {
    const { status, body } = await answer;
    assert.equal(status, 500);
    assert.ok(typeof body === "object" && body !== null && "error" in body, JSON.stringify(body));
    assert.match(String(body.error), /^busy: run_program has held the run slot for \d+ s; wait_for \["program_finished"\] or stop_program, then retry$/);
  }

  it("leaves the host alone when the executing program settles within the grace, and runs the preempting firing as preempted", { timeout: 30_000 }, async () => {
    const t = await scripted({ reflex: reflex("return 1;") });
    const before = await pidOf(t);
    const { answer } = await startRun(t, SETTLES);
    await refused(busy(t));
    t.events.push("fire");
    const result = (await answer).body as RunResult;
    assert.deepEqual({ status: result.status, error: result.error }, { status: "stopped", error: undefined });
    assert.equal((await waitFor(t, "reflex_finished")).data.status, "ok");
    assert.deepEqual(eventsOf(t, "reflex_fired").map((e) => e.data.preempted), [true]);
    // Past the deadline the supervisor would have set for the preempted run.
    await sleep(GRACE_MS + KILL_MARGIN_MS + 500);
    assert.equal(await pidOf(t), before, "the host of a program that settled in its grace was replaced");
    assert.equal(eventsOf(t, "disconnected").length, 0);
  });

  it("restarts the host of an executing program that blocks the host after catching the abort, and answers it stopped, within the bound", { timeout: 30_000 }, async () => {
    const t = await scripted({ reflex: reflex("return 1;") });
    const before = await pidOf(t);
    const { answer } = await startRun(t, BLOCKS);
    await refused(busy(t));
    const askedAt = Date.now();
    t.events.push("fire");
    const result = (await answer).body as RunResult;
    const tookMs = Date.now() - askedAt;
    assert.deepEqual({ status: result.status, error: result.error }, { status: "stopped", error: restartedError(CAUSE) });
    assert.ok(tookMs <= BOUND_MS, `the run answered ${tookMs} ms after the ask (bound ${BOUND_MS} ms)`);
    assert.notEqual(await pidOf(t), before, "the host was not replaced");
  });

  // A run that arrives while another holds the host's run slot (running, or in the grace of its preemption) is refused at its arrival, before
  // the supervisor hears of it: however late the supervisor's history would write its start, it never runs ahead of the preempting firing,
  // nor starts and is stopped by it (mb-9h3). Nothing here orders the refusal against the preemption: the order is the product's.
  for (const ackDelayMs of [0, 80, 400]) {
    it(`refuses a run that arrives as a preemption that waits behind a burst is asked (its start would be acked ${ackDelayMs} ms late), stops the executing program, runs the firing, and leaves the host alone`, { timeout: 30_000 }, async () => {
      const t = await scripted({ reflex: reflex("return 1;"), burstOnEvent: { type: "fire", count: 150, bytes: 4_000 } }, { ackDelayMs });
      const before = await pidOf(t);
      const { answer } = await startRun(t, SETTLES);
      const refusal = busy(t);
      t.events.push("fire");
      await refused(refusal);
      const result = (await answer).body as RunResult;
      assert.deepEqual({ status: result.status, error: result.error }, { status: "stopped", error: undefined });
      assert.equal((await waitFor(t, "reflex_finished")).data.status, "ok");
      assert.deepEqual(eventsOf(t, "reflex_fired").map((e) => e.data.preempted), [true]);
      await sleep(GRACE_MS + KILL_MARGIN_MS + 500);
      assert.equal(await pidOf(t), before, "the host of a program that settled in its grace was replaced");
      assert.equal(eventsOf(t, "disconnected").length, 0);
    });
  }
});

describe("a preemption aborts only the run that executes at the ask", () => {
  /** Waits on `release` or its abort, and settles at once either way. */
  const gated = (release: Promise<void>) => async (scope: ProgramScope) => {
    try {
      await Promise.race([release, scope.sleep(1e9)]);
    } catch {}
    return 1;
  };

  /**
   * A reporter over a real runner, its channel held by the test: what it sends is kept, a message's
   * write completes when the test says so, and the supervisor acks a run's end at once.
   */
  function held() {
    const sent: FromHost[] = [];
    const writes: (() => void)[] = [];
    const stops: number[] = [];
    const runner = new ProgramRunner({ graceMs: GRACE_MS });
    const reporter: InstanceType<typeof RunReporter> = new RunReporter({
      send: (message, written) => {
        sent.push(message);
        if (written) writes.push(written);
        if (message.kind === "run_finished") queueMicrotask(() => reporter.acknowledge(message.runId));
      },
      stop: () => {
        stops.push(sent.length);
        return runner.stop();
      },
      running: () => runner.running !== null,
    });
    let runs = 0;
    /** Records a run of `execute`; the supervisor acks its start (`start: false`: not yet; a string: refuses it with that error). */
    function recordRun(execute: () => Promise<RunOutcome>, start: boolean | string = true) {
      const runId = runs++;
      const ended = reporter.record({ code: "run" }, execute);
      if (start !== false) reporter.acknowledge(runId, start === true ? undefined : start);
      return { runId, ended };
    }
    /** Records a program that runs until released or aborted, and resolves once its code runs. */
    async function begin() {
      const gate = Promise.withResolvers<void>();
      const run = recordRun(() => runner.call(gated(gate.promise), { timeoutMs: 60_000, sourceDir: ROOT }));
      await setImmediate();
      assert.ok(runner.running, "the program does not run");
      return { ...run, release: () => gate.resolve() };
    }
    return { reporter, runner, sent, writes, stops, recordRun, begin };
  }
  const preempts = (sent: FromHost[]) => sent.filter((m) => m.kind === "preempt");

  it("does not abort the run that starts between the ask and the write of the message", async () => {
    const { reporter, sent, writes, stops, begin } = held();
    const first = await begin();
    assert.equal(reporter.preempt(), true);
    assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: first.runId }]);
    // The first run settles, and a second starts, before the message is written.
    first.release();
    assert.equal((await first.ended).status, "ok");
    const second = await begin();
    assert.equal(writes.length, 1);
    writes[0]!();
    assert.deepEqual(stops, [], "the second run was aborted for the first's preemption");
    assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: first.runId }], "a deadline was asked for the second run");
    second.release();
    assert.equal((await second.ended).status, "ok");
  });

  it("aborts the run that still executes when the message is written, and not before", async () => {
    const { reporter, sent, writes, stops, begin } = held();
    const run = await begin();
    assert.equal(reporter.preempt(), true);
    assert.deepEqual(stops, [], "aborted before the message was written");
    writes[0]!();
    assert.deepEqual(stops, [sent.length], "not aborted once the message was written");
    assert.equal((await run.ended).status, "stopped");
  });

  it("asks for nothing while no run holds the slot: after a run settled, after a run that threw before starting, and after a start the history refused", async () => {
    const { reporter, runner, sent, stops, recordRun } = held();
    const gate = Promise.withResolvers<void>();
    const run = recordRun(() => runner.call(gated(gate.promise), { timeoutMs: 60_000, sourceDir: ROOT }));
    await setImmediate();
    gate.resolve();
    await run.ended;
    assert.equal(reporter.preempt(), false, "a settled run holds the slot");
    await assert.rejects(recordRun(() => Promise.reject(new Error("not connected"))).ended, { message: "not connected" });
    assert.equal(reporter.preempt(), false, "a run that never started holds the slot");
    await assert.rejects(recordRun(() => runner.call(async () => 2, { sourceDir: ROOT }), "EACCES: permission denied").ended, { message: "EACCES: permission denied" });
    assert.equal(reporter.preempt(), false, "a run whose start the history refused holds the slot");
    assert.deepEqual([preempts(sent), stops, reporter.busy], [[], [], false]);
  });

  it("preempts a run whose start the supervisor has not acked yet as it starts, the supervisor told before the abort", async () => {
    const { reporter, runner, sent, writes, stops, recordRun } = held();
    const run = recordRun(() => runner.call(gated(Promise.withResolvers<void>().promise), { timeoutMs: 60_000, sourceDir: ROOT }), false);
    assert.equal(reporter.preempt(), true, "the firing does not wait for the reserved run");
    assert.deepEqual(preempts(sent), [], "a deadline was asked for a run the supervisor has not acked");
    reporter.acknowledge(run.runId);
    await setImmediate();
    assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: run.runId }]);
    assert.deepEqual(stops, [], "aborted before the message was written");
    writes[0]!();
    assert.equal((await run.ended).status, "stopped");
  });

  describe("refuses a run that arrives while another holds the slot, before the supervisor hears of it, and still stops the run that holds it", () => {
    /** Records a run while another holds the slot: it is refused as busy, with nothing sent and none of its code run. */
    async function refused(reporter: InstanceType<typeof RunReporter>, sent: FromHost[]): Promise<void> {
      const before = sent.length;
      let ran = false;
      const second = reporter.record({ code: "second" }, async () => {
        ran = true;
        return { status: "ok", result: 2, logs: "", durationMs: 0 };
      });
      await assert.rejects(second, BusyError);
      assert.deepEqual({ sent: sent.slice(before), ran }, { sent: [], ran: false });
    }

    it("while its start waits for the supervisor's ack", async () => {
      const { reporter, runner, sent, recordRun } = held();
      const gate = Promise.withResolvers<void>();
      const run = recordRun(() => runner.call(gated(gate.promise), { timeoutMs: 60_000, sourceDir: ROOT }), false);
      await refused(reporter, sent);
      reporter.acknowledge(run.runId);
      await setImmediate();
      gate.resolve();
      assert.equal((await run.ended).status, "ok");
    });

    it("before the ask", async () => {
      const { reporter, sent, writes, begin } = held();
      const run = await begin();
      await refused(reporter, sent);
      assert.equal(reporter.preempt(), true, "no run holds the slot");
      assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: run.runId }]);
      writes[0]!();
      assert.equal((await run.ended).status, "stopped");
    });

    it("between the ask and the write of the message", async () => {
      const { reporter, sent, writes, stops, begin } = held();
      const run = await begin();
      assert.equal(reporter.preempt(), true);
      await refused(reporter, sent);
      writes[0]!();
      assert.equal(stops.length, 1, "the executing run was not aborted");
      assert.equal((await run.ended).status, "stopped");
    });

    it("in the grace after the abort, until the run's end frees the slot and tells whoever waits for it", async () => {
      const { reporter, runner, sent, writes, recordRun } = held();
      let idles = 0;
      reporter.onIdle(() => idles++);
      const settle = Promise.withResolvers<void>();
      const run = recordRun(() =>
        runner.call(
          async (scope) => {
            try {
              await scope.sleep(1e9);
            } catch {}
            await settle.promise;
            return 1;
          },
          { timeoutMs: 60_000, sourceDir: ROOT },
        ),
      );
      await setImmediate();
      assert.equal(reporter.preempt(), true);
      writes[0]!();
      await setImmediate();
      assert.ok(runner.running, "the aborted program left its grace");
      await refused(reporter, sent);
      assert.equal(idles, 0);
      settle.resolve();
      assert.equal((await run.ended).status, "stopped");
      assert.deepEqual({ busy: reporter.busy, idles }, { busy: false, idles: 1 });
      const next = recordRun(async () => ({ status: "ok", result: 3, logs: "", durationMs: 0 }));
      assert.equal((await next.ended).result, 3);
    });
  });
});

describe("the body's triggers", () => {
  const world = {
    name: "w",
    username: "w",
    auth: "offline" as const,
    host: "127.0.0.1",
    port: 1,
    wikiMode: "off" as const,
    milestonesEnabled: false,
    triggers: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    deaths: 0,
    reconnects: 0,
    applyMilestones: false,
  };

  it("see the recorder's run slot, and ask the recorder, not the runner, to stop the run that holds it for a preempting firing", async () => {
    let preempted = 0;
    const events = new HostEvents(() => {});
    const recorder = {
      record: async () => assert.fail("no run"),
      // With no server no program can run here: the slot is held, as it is while a run's code executes, and the runner is idle.
      busy: true,
      onIdle: () => {},
      deliver: () => false,
      counts: () => {},
      preempt: () => {
        preempted++;
        return true;
      },
      register: async () => {},
    };
    const built = buildWorld({ ...world, stateDir: path.join(ROOT, "world") }, { events, recorder });
    try {
      await built.body.triggers!.addReflex({ name: "pre", on: ["fire"], routine: "stand-in", preempt: true, cooldownMs: 0 });
      events.hear({ seq: 1, time: Date.now(), type: "fire", data: {} });
      await setImmediate();
      assert.equal(preempted, 1, "the preemption did not go through the recorder");
    } finally {
      built.close();
    }
  });
});
