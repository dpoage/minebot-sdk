// A preemption is an abort like /stop's and a timeout's: a program that does not settle within the
// grace of it ends with its host, whether it awaits forever or blocks the host's main thread after
// catching the abort. The supervisor's side runs against the trigger fixture
// (test/fixtures/host/trigger-host.ts: the real RunReporter, Triggers, and ProgramRunner over the
// real channel) with a small grace; the host-side rules (which run a preemption aborts, and when)
// run in-process against a RunReporter whose channel is held open by the test.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { FromHost, HostInit } from "../src/protocol/host.ts";
import type { BodyEvent, RunResult } from "../src/protocol/index.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-preempt-deadline-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
const TRIGGER_FIXTURE = path.join(import.meta.dirname, "fixtures", "host", "trigger-host.ts");
const GRACE_MS = 500;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads.
const { EventLog } = await import("../src/body/events.ts");
const { HostProcess } = await import("../src/body/host-process.ts");
const { ProgramHistory } = await import("../src/body/history.ts");
const { RunReporter } = await import("../src/host/channel.ts");
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
async function scripted(script: Script): Promise<Scripted> {
  const dir = path.join(ROOT, `scripted-${++scripts}`);
  mkdirSync(dir);
  const events = new EventLog();
  const init = { stateDir: dir, startedAt: "t0", deaths: 0, reconnects: 0, applyMilestones: true, script: { graceMs: GRACE_MS, ...script } } as unknown as HostInit;
  const host = new HostProcess({ init, events, history: new ProgramHistory({ file: path.join(dir, "history.jsonl") }), entry: TRIGGER_FIXTURE, graceMs: GRACE_MS });
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
const BLOCKS = `try { await sleep(1e9); } catch {} const t = Date.now(); while (Date.now() - t < ${SPIN_MS}) {} return 1;`;
/** Catches the abort and never settles. */
const AWAITS_FOREVER = "try { await sleep(1e9); } catch {} await new Promise(() => {}); return 1;";
/** Catches the abort and settles at once. */
const SETTLES = "try { await sleep(1e9); } catch {} return 1;";

const reflex = (run: string, extra: object = {}) => ({ name: "reflex", on: ["fire"], run, timeoutMs: 1_000, cooldownMs: 0, preempt: true, ...extra });

/** Starts /run `code` (a program that outlasts everything, with its timeout far off) and waits until its code runs; the run's answer is returned in an object, so awaiting this does not wait for it. */
async function startRun(t: Scripted, code: string): Promise<{ answer: Promise<{ status: number; body: unknown }> }> {
  const since = t.events.since(0).next;
  const answer = post(t, "/run", { code, timeoutMs: 60_000 });
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
    await waitFor(t, "trigger_fired");
    const since = t.events.since(0).next;
    const askedAt = Date.now();
    t.events.push("high");
    await waitFor(t, "disconnected", since);
    const tookMs = Date.now() - askedAt;
    assert.ok(tookMs <= BOUND_MS, `the host was restarted ${tookMs} ms after the ask (bound ${BOUND_MS} ms)`);
    const finished = await waitFor(t, "trigger_finished");
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
    const finished = await waitFor(t, "trigger_finished");
    assert.equal(finished.data.status, "ok");
    assert.deepEqual(eventsOf(t, "trigger_fired").map((e) => e.data.preempted), [true]);
    // Past the deadline the supervisor would have set for the preempted run.
    await sleep(GRACE_MS + KILL_MARGIN_MS + 500);
    assert.equal(await pidOf(t), before, "the host of a program that settled in its grace was replaced");
    assert.equal(eventsOf(t, "disconnected").length, 0);
  });
});

describe("a preemption aborts only the run that executes at the ask", () => {
  const result: RunResult = { status: "ok", result: 1, logs: "", durationMs: 0 };

  /** A reporter whose channel the test holds: what it sends is kept, and a message's write completes when the test says so. */
  function held() {
    const sent: FromHost[] = [];
    const writes: (() => void)[] = [];
    const stops: number[] = [];
    const reporter = new RunReporter({
      send: (message, written) => {
        sent.push(message);
        if (written) writes.push(written);
      },
      kits: () => [],
      stop: () => {
        stops.push(sent.length);
        return true;
      },
    });
    return { reporter, sent, writes, stops };
  }
  const preempts = (sent: FromHost[]) => sent.filter((m) => m.kind === "preempt");

  it("does not abort the run that starts between the ask and the write of the message", async () => {
    const { reporter, sent, writes, stops } = held();
    const first = Promise.withResolvers<RunResult>();
    const firstRun = reporter.record({ code: "first" }, () => first.promise);
    reporter.acknowledge(0);
    await setImmediate();
    assert.equal(reporter.preempt(), true);
    assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: 0 }]);
    // The first run settles, and a second starts, before the message is written.
    first.resolve(result);
    await setImmediate();
    reporter.acknowledge(0);
    await firstRun;
    const second = Promise.withResolvers<RunResult>();
    const secondRun = reporter.record({ code: "second" }, () => second.promise);
    reporter.acknowledge(1);
    await setImmediate();
    assert.equal(writes.length, 1);
    writes[0]!();
    assert.deepEqual(stops, [], "the second run was aborted for the first's preemption");
    assert.deepEqual(preempts(sent), [{ kind: "preempt", runId: 0 }], "a deadline was asked for the second run");
    second.resolve(result);
    await setImmediate();
    reporter.acknowledge(1);
    await secondRun;
  });

  it("aborts the run that still executes when the message is written, and not before", async () => {
    const { reporter, sent, writes, stops } = held();
    const running = Promise.withResolvers<RunResult>();
    const run = reporter.record({ code: "run" }, () => running.promise);
    reporter.acknowledge(0);
    await setImmediate();
    assert.equal(reporter.preempt(), true);
    assert.deepEqual(stops, [], "aborted before the message was written");
    writes[0]!();
    assert.deepEqual(stops, [sent.length], "not aborted once the message was written");
    running.resolve(result);
    await setImmediate();
    reporter.acknowledge(0);
    await run;
  });

  it("asks for nothing while no recorded run executes: before the supervisor's ack, and after the run settled", async () => {
    const { reporter, sent, stops } = held();
    const running = Promise.withResolvers<RunResult>();
    const run = reporter.record({ code: "run" }, () => running.promise);
    assert.equal(reporter.preempt(), false, "a run whose start is not acked executes");
    running.resolve(result);
    reporter.acknowledge(0);
    await setImmediate();
    reporter.acknowledge(0);
    await run;
    assert.equal(reporter.preempt(), false, "a settled run executes");
    assert.deepEqual([preempts(sent), stops], [[], []]);
  });
});
