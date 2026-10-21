// Restart on crash and kill on a hung stop: the supervisor ends a program that will not stop by
// killing its host, replaces a host that dies, and the replacement carries the player over. The
// supervisor's side runs against a scripted host (test/fixtures/host/scripted-host.ts) with a
// small grace; the real host is killed once to see the same through the whole body.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { FromHost, HostInit } from "../src/protocol/host.ts";
import type { BodyEvent, RunResult, TriggerInfo } from "../src/protocol/index.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-host-restart-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "host", "scripted-host.ts");
const TRIGGER_FIXTURE = path.join(import.meta.dirname, "fixtures", "host", "trigger-host.ts");
const GRACE_MS = 300;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads.
const { EventLog } = await import("../src/body/events.ts");
const { HostProcess, restartDelay, RESTART_MAX_MS, STABLE_UP_MS } = await import("../src/body/host-process.ts");
const { ProgramHistory } = await import("../src/body/history.ts");
const { startDaemon } = await import("../src/body/daemon.ts");
const { RunReporter, HostEvents } = await import("../src/host/channel.ts");
const { buildWorld } = await import("../src/host/world.ts");
const { MilestoneSet } = await import("../src/milestones/milestones.ts");
const { endpointFile } = await import("../src/protocol/index.ts");
const { hungCause, restartedError, MAX_EVENT_LOGS, NOT_CONNECTED_MESSAGE } = await import("../src/protocol/host.ts");

const CAUSE = hungCause(GRACE_MS);
const NOT_CONNECTED = { status: 503, body: { error: NOT_CONNECTED_MESSAGE } };

const hosts: InstanceType<typeof HostProcess>[] = [];
after(async () => {
  for (const host of hosts) await host.close();
  rmSync(ROOT, { recursive: true, force: true });
});

interface Script {
  failFrom?: number;
  crashAfterReadyMs?: number;
  mirrorState?: boolean;
  trigger?: { mode: string; timeoutMs: number };
  spawnLog?: string;
  initLog?: string;
  /** The one trigger of the trigger fixture (TRIGGER_FIXTURE). */
  reflex?: { name: string; on: string[]; run: string; timeoutMs: number; cooldownMs: number };
}

interface Scripted {
  host: InstanceType<typeof HostProcess>;
  events: InstanceType<typeof EventLog>;
  history: string;
}

let scripts = 0;
async function scripted(script: Script = {}, entry = FIXTURE): Promise<Scripted> {
  const dir = path.join(ROOT, `scripted-${++scripts}`);
  mkdirSync(dir);
  const events = new EventLog();
  const history = path.join(dir, "history.jsonl");
  const init = { stateDir: dir, startedAt: "t0", deaths: 2, reconnects: 5, active: ["a", "b"], applyMilestones: true, script: { graceMs: GRACE_MS, ...script } } as unknown as HostInit;
  const host = new HostProcess({ init, events, history: new ProgramHistory({ file: history }), entry, graceMs: GRACE_MS });
  hosts.push(host);
  await host.start();
  host.join();
  return { host, events, history };
}

const get = (t: Scripted, url: string) => t.host.forward({ method: "GET", url, body: null, tooLarge: false });
async function pidOf(t: Scripted): Promise<number> {
  const { body } = await get(t, "/ping");
  // The scripted host answers /ping with its pid.
  const answer = body as { pid: number };
  return answer.pid;
}
const eventsOf = (t: Scripted, type: string): BodyEvent[] => t.events.since(0).events.filter((event) => event.type === type);
const historyOf = (t: Scripted) => readFileSync(t.history, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

async function waitFor(t: Scripted, type: string, since = 0): Promise<BodyEvent> {
  const { event } = await t.events.wait({ types: [type], since, timeoutMs: 15_000 });
  assert.ok(event, `no ${type} event`);
  return event;
}

/** A /run request the scripted host answers by starting a run of `mode`. */
function run(t: Scripted, mode: string, timeoutMs = 60_000) {
  return t.host.forward({ method: "POST", url: `/run?mode=${mode}&timeoutMs=${timeoutMs}`, body: null, tooLarge: false });
}

function withoutDuration(body: unknown): { durationMs: unknown; rest: Record<string, unknown> } {
  const { durationMs, ...rest } = body as RunResult;
  return { durationMs, rest };
}

/** Kills the host the scripted fixture reports and waits until the supervisor has logged its loss. */
async function killHost(t: Scripted): Promise<void> {
  const since = t.events.since(0).next;
  process.kill(await pidOf(t), "SIGKILL");
  await waitFor(t, "disconnected", since);
}

describe("restart: a program that does not stop ends with its host", () => {
  it("ends a run that blocks its host within the grace of /stop, and answers /run and /stop", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const before = await pidOf(t);
    const request = run(t, "block");
    await waitFor(t, "acked");
    const t0 = performance.now();
    assert.deepEqual(await t.host.stop(), { stopped: true });
    const took = performance.now() - t0;
    assert.ok(took < GRACE_MS + 1000, `/stop took ${took} ms`);
    const answer = await request;
    assert.equal(answer.status, 200);
    const { durationMs, rest } = withoutDuration(answer.body);
    assert.equal(typeof durationMs, "number");
    assert.deepEqual(rest, { status: "stopped", error: restartedError(CAUSE), logs: "" });
    assert.notEqual(await pidOf(t), before, "the host was not replaced");
    assert.deepEqual(eventsOf(t, "program_finished").map((e) => e.data.status), ["stopped"]);
    assert.deepEqual(eventsOf(t, "disconnected").map((e) => e.data.reason), [`bot host restarted: ${CAUSE}`]);
    const lines = historyOf(t);
    assert.deepEqual(lines.map((line) => line.status), ["stopped"]);
    assert.equal(lines[0]!.logs, "");
  });

  it("ends a run that blocks its host at its own timeout, with no /stop sent", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const request = run(t, "block", 200);
    await waitFor(t, "acked");
    const t0 = performance.now();
    const answer = await request;
    const took = performance.now() - t0;
    assert.ok(took < 200 + GRACE_MS + 1000, `the run took ${took} ms after its ack`);
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "timeout", error: restartedError(CAUSE), logs: "" });
    assert.deepEqual(eventsOf(t, "program_finished").map((e) => e.data.status), ["timeout"]);
    assert.equal(eventsOf(t, "disconnected").length, 1);
  });

  it("answers with the logs a live host reports when it says the program is hung", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const request = run(t, "report");
    await waitFor(t, "acked");
    assert.deepEqual(await t.host.stop(), { stopped: true });
    const answer = await request;
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "stopped", error: restartedError(CAUSE), logs: "partial" });
    assert.equal(historyOf(t)[0]!.logs, "partial", "the history line carries what the host reported");
    assert.equal(eventsOf(t, "program_finished").length, 1, "exactly one program_finished");
    assert.equal(eventsOf(t, "disconnected").length, 1);
  });

  it("ends a trigger's run the same way, with a trigger_finished and no program_finished", { timeout: 20_000 }, async () => {
    const t = await scripted({ trigger: { mode: "block", timeoutMs: 200 } });
    const finished = await waitFor(t, "trigger_finished");
    await waitFor(t, "disconnected");
    assert.deepEqual(finished.data, { name: "t1", status: "timeout", durationMs: finished.data.durationMs, error: restartedError(CAUSE) });
    assert.equal(eventsOf(t, "trigger_finished").length, 1);
    assert.equal(eventsOf(t, "program_finished").length, 0);
  });

  it("does not touch the host of a program that settles after its abort", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const before = await pidOf(t);
    const request = run(t, "settle");
    await waitFor(t, "acked");
    assert.deepEqual(await t.host.stop(), { stopped: true });
    const answer = await request;
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "stopped", logs: "settled" });
    // Past the kill deadline the settled run's host is still the same process.
    await sleep(GRACE_MS + 800);
    assert.equal(await pidOf(t), before);
    assert.equal(eventsOf(t, "disconnected").length, 0);
    assert.equal(eventsOf(t, "program_finished").length, 0, "the settled run's finish is the host's to push");
    assert.deepEqual(await t.host.stop(), { stopped: false }, "nothing is left running");
  });

  it("answers a run whose host crashes with the loss, and logs its end once", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const answer = await run(t, "crash");
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "error", error: restartedError("the bot host exited (signal SIGKILL)"), logs: "" });
    assert.deepEqual(eventsOf(t, "program_finished").map((e) => e.data.status), ["error"]);
    assert.deepEqual(eventsOf(t, "disconnected").map((e) => e.data.reason), ["bot host restarted: the bot host exited (signal SIGKILL)"]);
    assert.deepEqual(historyOf(t).map((line) => line.status), ["error"]);
  });

  it("answers a run that ends just as its deadline kills the host with the run's own result, and does not call it hung", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const before = await pidOf(t);
    // The host ends the run 850 ms after its ack; the supervisor's deadline is at 100 + 300 + 500 ms.
    const request = run(t, "late", 100);
    const acked = Number((await waitFor(t, "acked")).data.at);
    // Holding the supervisor up across both, in the check phase, has the next loop turn fire the deadline before it reads the run's end.
    await sleep(Math.max(0, acked + 750 - Date.now()));
    await setImmediate();
    while (Date.now() < acked + 1_000);
    const answer = await request;
    assert.equal(answer.status, 200);
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "ok", logs: "late" });
    assert.deepEqual(historyOf(t).map((line) => line.status), ["ok"]);
    assert.deepEqual(eventsOf(t, "program_finished").map((e) => e.data.status), ["ok"]);
    const reasons = eventsOf(t, "disconnected").map((e) => String(e.data.reason));
    assert.equal(reasons.length, 1, "the deadline did not kill the host: the race was not reproduced");
    assert.doesNotMatch(reasons[0]!, /did not stop/);
    assert.notEqual(await pidOf(t), before);
  });
});

describe("restart: the supervisor keeps serving across a host's death", () => {
  it("keeps the event log's seq, answers in-flight requests with the 503, and has the next host answer queued ones", { timeout: 30_000 }, async () => {
    const t = await scripted({ mirrorState: true });
    const first = await pidOf(t);
    t.events.push("marker");
    const slow = get(t, "/slow");
    process.kill(first, "SIGKILL");
    await waitFor(t, "disconnected");
    assert.deepEqual(await slow, NOT_CONNECTED);

    // The host is gone and its replacement is not up: the request waits for it.
    const queued = await Promise.race([get(t, "/notes"), sleep(15_000).then(() => assert.fail("a request issued while no host is ready was never answered"))]);
    assert.equal(queued.status, 200);
    const answer = queued.body as { pid: number }; // the scripted host's /notes
    const second = answer.pid;
    assert.notEqual(second, first);
    await waitFor(t, "hello", 3);
    assert.deepEqual(
      t.events.since(0).events.map((e) => [e.seq, e.type]),
      [[1, "hello"], [2, "marker"], [3, "disconnected"], [4, "hello"]],
      "one log, numbered without a reset, with exactly one disconnected",
    );
    assert.equal(t.events.since(0).events[2]!.data.reason, "bot host restarted: the bot host exited (signal SIGKILL)");
    assert.equal(t.host.connected, true);
  });

  it("survives sends to a host that is dead before its channel says so, and restarts it", { timeout: 30_000 }, async () => {
    const t = await scripted();
    const first = await pidOf(t);
    process.kill(first, "SIGKILL");
    // Held up, the supervisor has not seen the channel close: each send below fails on a dead socket.
    const until = Date.now() + 100;
    while (Date.now() < until);
    const inFlight = [get(t, "/slow"), get(t, "/slow"), get(t, "/slow")];
    t.events.push("echoed");
    assert.deepEqual(await Promise.all(inFlight), [NOT_CONNECTED, NOT_CONNECTED, NOT_CONNECTED]);
    assert.notEqual(await pidOf(t), first, "no new host became ready");
    assert.equal(eventsOf(t, "disconnected").length, 1);
  });

  it("restarts a real host of a running body and keeps the endpoint, the log, and the API", { timeout: 60_000 }, async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const daemon = await startDaemon({
      name: "real",
      username: "real",
      auth: "offline",
      host: "127.0.0.1",
      port,
      apiHost: "127.0.0.1",
      apiPort: 0,
      lockKits: false,
      wikiMode: "off",
      stateDir: path.join(ROOT, "state-real"),
      milestonesEnabled: false,
      agentKits: false,
    });
    try {
      const api = async <T>(url: string): Promise<T> => {
        const response = await fetch(`${daemon.endpoint.url}${url}`, { headers: { authorization: `Bearer ${daemon.endpoint.token}` } });
        return (await response.json()) as T;
      };
      const hostsNow = () =>
        execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
          .map(Number)
          .filter((pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("host/main"));
      const [first] = hostsNow();
      assert.ok(first !== undefined);
      process.kill(first, "SIGKILL");
      const lostAt = (events: BodyEvent[]) => events.find((e) => String(e.data.reason).startsWith("bot host restarted"))?.seq;
      while (lostAt((await api<{ events: BodyEvent[] }>("/events?since=0")).events) === undefined) await sleep(20);
      // The host is gone and its replacement is not up: the request waits for it.
      const restarted = await api<unknown>("/notes");
      assert.deepEqual(restarted, { notes: [] });
      const [second] = hostsNow();
      assert.ok(second !== undefined && second !== first, "no new host process");
      // The new host reconnects as the same player: its own events follow the supervisor's.
      let events: BodyEvent[] = [];
      for (let i = 0; i < 100; i++) {
        events = (await api<{ events: BodyEvent[] }>("/events?since=0")).events;
        if (events.some((e) => e.type === "reconnect_scheduled" && e.seq > (lostAt(events) ?? Infinity))) break;
        await sleep(100);
      }
      const lost = events.filter((e) => String(e.data.reason).startsWith("bot host restarted"));
      assert.equal(lost.length, 1);
      assert.match(String(lost[0]!.data.reason), /^bot host restarted: the bot host exited \(signal SIGKILL\)$/);
      assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq has no gap and no reset");
      assert.ok(events.some((e) => e.seq > lost[0]!.seq), "the new host's events follow");
      assert.ok(existsSync(endpointFile("real")), "the endpoint file is still published");
    } finally {
      await daemon.close();
    }
    assert.ok(!existsSync(endpointFile("real")), "shutdown removes the endpoint file");
  });
});

describe("restart: what a replacement host carries over", () => {
  it("is started with the counters, the active kits, and the start time of the one it replaces, and without the milestones", { timeout: 40_000 }, async () => {
    const initLog = path.join(ROOT, "carry-init.log");
    const t = await scripted({ mirrorState: true, initLog });
    await killHost(t);
    await get(t, "/ping");
    await killHost(t);
    await get(t, "/ping");
    const inits = readFileSync(initLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as HostInit);
    assert.deepEqual(
      inits.map(({ deaths, reconnects, active, applyMilestones, startedAt }) => ({ deaths, reconnects, active, applyMilestones, startedAt })),
      [
        { deaths: 2, reconnects: 5, active: ["a", "b"], applyMilestones: true, startedAt: "t0" },
        { deaths: 2, reconnects: 6, active: ["a", "b"], applyMilestones: false, startedAt: "t0" },
        { deaths: 2, reconnects: 7, active: ["a", "b"], applyMilestones: false, startedAt: "t0" },
      ],
    );
  });

  describe("in the host's world", () => {
    const base = {
      name: "w",
      username: "w",
      auth: "offline" as const,
      host: "127.0.0.1",
      port: 1,
      lockKits: false,
      wikiMode: "off" as const,
      milestonesEnabled: true,
      agentKits: false,
      triggers: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      deaths: 2,
      reconnects: 3,
      milestones: MilestoneSet.parse({ milestones: [{ id: "logs", description: "Get logs", obtained: ["*_log"], count: 3 }] }),
    };
    const io = { events: new HostEvents(() => {}), recorder: { record: async () => assert.fail("no run"), register: async () => {} } };

    it("starts from the counters and the start time, with the carried kits less the ones the catalog does not offer, and without the milestones", async () => {
      const world = buildWorld({ ...base, stateDir: path.join(ROOT, "world-a"), active: ["deleted-agent-kit", "move"], applyMilestones: false }, io);
      try {
        assert.ok(world.kits.active.includes("move"));
        assert.ok(!world.kits.active.includes("deleted-agent-kit"));
        assert.ok(!world.kits.active.includes("combat"), "the carried set replaces the default of every kit");
        assert.deepEqual(await world.body.status(), { connected: false, startedAt: base.startedAt, deaths: 2, reconnects: 3, milestones: null });
        assert.equal(world.body.milestones, null);
      } finally {
        world.close();
      }
    });

    it("applies the milestones of its options at the first start", async () => {
      const world = buildWorld({ ...base, stateDir: path.join(ROOT, "world-b"), applyMilestones: true }, io);
      try {
        assert.equal(world.body.milestones?.milestones[0]?.id, "logs");
      } finally {
        world.close();
      }
    });
  });
});

describe("restart: a trigger whose firing ends with its host", () => {
  const reflex = (code: string) => ({ name: "reflex", on: ["fire"], run: code, timeoutMs: 200, cooldownMs: 0 });

  it("has the trigger_finished carry the logs the host reported, cut as the host cuts them", { timeout: 20_000 }, async () => {
    const t = await scripted({ reflex: reflex(`log("reflex-log"); log(".".repeat(${MAX_EVENT_LOGS})); await new Promise(() => {});`) }, TRIGGER_FIXTURE);
    t.events.push("fire");
    const finished = await waitFor(t, "trigger_finished");
    await waitFor(t, "disconnected");
    assert.deepEqual(finished.data, {
      name: "reflex",
      status: "timeout",
      durationMs: finished.data.durationMs,
      error: restartedError(CAUSE),
      logs: `reflex-log\n${".".repeat(MAX_EVENT_LOGS)}`.slice(0, MAX_EVENT_LOGS),
    });
  });

  it("counts the firing toward the trigger's failures, so a trigger that never stops is disabled after 3 and restarts the host 3 times", { timeout: 40_000 }, async () => {
    const t = await scripted({ reflex: reflex("await new Promise(() => {});") }, TRIGGER_FIXTURE);
    for (let firing = 1; firing <= 4; firing++) {
      // A host is up to hear the event.
      await get(t, "/ping");
      const since = t.events.since(0).next;
      t.events.push("fire");
      if (firing <= 3) await waitFor(t, "disconnected", since);
    }
    // A fourth firing would have started by now.
    await sleep(1_000);
    assert.equal(eventsOf(t, "trigger_fired").length, 3);
    assert.equal(eventsOf(t, "disconnected").length, 3);
    const reason = `failed 3 times in a row; last: ${restartedError(CAUSE)}`;
    assert.deepEqual(eventsOf(t, "trigger_disabled").map((e) => e.data), [{ name: "reflex", failures: 3, reason }]);
    const { body } = await get(t, "/triggers");
    const listed = body as { triggers: TriggerInfo[] }; // the trigger fixture's /triggers
    const [info] = listed.triggers;
    assert.deepEqual(
      { enabled: info!.enabled, failures: info!.failures, disabledReason: info!.disabledReason, lastStatus: info!.lastStatus, lastError: info!.lastError, fired: info!.fired },
      { enabled: false, failures: 3, disabledReason: reason, lastStatus: "timeout", lastError: restartedError(CAUSE), fired: 0 },
    );
  });
});

describe("restart: backoff and failure", () => {
  it("doubles the delay from 1 s to a 60 s cap, and starts over after a host stayed up 60 s", () => {
    assert.equal(restartDelay(0, 0), 1_000);
    assert.equal(restartDelay(1, 0), 2_000);
    assert.equal(restartDelay(5, 0), 32_000);
    assert.equal(restartDelay(6, 0), 60_000);
    assert.equal(restartDelay(7, 0), RESTART_MAX_MS);
    assert.equal(restartDelay(40, 59_999), RESTART_MAX_MS);
    assert.equal(restartDelay(7, STABLE_UP_MS), 1_000);
    assert.equal(restartDelay(3, STABLE_UP_MS + 1), 1_000);
  });

  it("does not respawn a host that crashes every time faster than the schedule allows", { timeout: 20_000 }, async () => {
    const spawnLog = path.join(ROOT, "crash-loop.log");
    const t = await scripted({ spawnLog, crashAfterReadyMs: 20 });
    await sleep(5_000);
    await t.host.close();
    const spawns = readFileSync(spawnLog, "utf8").trim().split("\n").length;
    // At 0 s, then after 1 s, then 2 s later: the fourth waits 4 s more.
    assert.ok(spawns >= 2 && spawns <= 4, `${spawns} hosts were forked in 5 s`);
  });

  it("answers 503 while the latest restart failed before ready, to the requests waiting for it and to later ones", { timeout: 30_000 }, async () => {
    const t = await scripted({ spawnLog: path.join(ROOT, "failing.log"), failFrom: 2 });
    await killHost(t);
    const t0 = performance.now();
    const waiting = await Promise.race([get(t, "/ping"), sleep(10_000).then(() => assert.fail("a request waiting for a host that failed to start was never answered"))]);
    assert.deepEqual(waiting, NOT_CONNECTED);
    assert.ok(performance.now() - t0 < 5_000);
    const t1 = performance.now();
    assert.deepEqual(await get(t, "/ping"), NOT_CONNECTED);
    assert.ok(performance.now() - t1 < 500, "a later request waited instead of answering at once");
  });
});

describe("restart: the host's report of a hung run", () => {
  it("is run_finished with hung, the requestId on run_started, and a result without the flag", async () => {
    const sent: FromHost[] = [];
    const reporter = new RunReporter({ send: (message) => sent.push(message), kits: () => [], stop: () => false });
    const hung = reporter.record({ code: "x", timeoutMs: 5, requestId: 7 }, async () => ({ status: "stopped", error: "e", logs: "partial", durationMs: 1, hung: true }));
    hung.catch(() => {});
    reporter.acknowledge(0);
    while (!sent.some((message) => message.kind === "run_finished")) await sleep(1);
    assert.deepEqual(sent[0], { kind: "run_started", runId: 0, code: "x", timeoutMs: 5, extra: {}, kits: [], requestId: 7 });
    assert.deepEqual(sent[1], { kind: "run_finished", runId: 0, result: { status: "stopped", error: "e", logs: "partial", durationMs: 1 }, hung: true });

    // A run that ended normally says nothing of it, and a trigger's run has no request.
    sent.length = 0;
    const settled = reporter.record({ code: "y" }, async () => ({ status: "ok", result: 1, logs: "", durationMs: 2 }));
    reporter.acknowledge(1);
    while (!sent.some((message) => message.kind === "run_finished")) await sleep(1);
    reporter.acknowledge(1);
    assert.deepEqual(await settled, { status: "ok", result: 1, logs: "", durationMs: 2 });
    assert.ok(!("requestId" in sent[0]!));
    assert.deepEqual(sent[1], { kind: "run_finished", runId: 1, result: { status: "ok", result: 1, logs: "", durationMs: 2 } });
  });
});

describe("restart: a run's start is recorded before its code may run", () => {
  it("acks run_started only once the history has the line, so a program that kills the supervisor leaves it", { timeout: 20_000 }, async () => {
    const ackLog = path.join(ROOT, "ack-time.log");
    let writtenAt = Infinity;
    // A history whose write is slow: the line is not on disk until a while after the run was reported.
    const slow = {
      start: async () => {},
      register: async () => {},
      begin: async () => {
        await sleep(200);
        writtenAt = Date.now();
        return async () => {};
      },
    } as unknown as InstanceType<typeof ProgramHistory>;
    const events = new EventLog();
    const host = new HostProcess({ init: { stateDir: ROOT, script: { ackLog } } as unknown as HostInit, events, history: slow, entry: FIXTURE, graceMs: GRACE_MS });
    hosts.push(host);
    await host.start();
    host.join();
    host.forward({ method: "POST", url: "/run?mode=hang&timeoutMs=60000", body: null, tooLarge: false }).catch(() => {});
    // The host's own events pass through the supervisor in order, behind the history write; the time it noted when the ack reached it does not.
    await events.wait({ types: ["acked"], since: 0, timeoutMs: 10_000 });
    const ackedAt = Number(readFileSync(ackLog, "utf8").trim());
    assert.ok(ackedAt >= writtenAt, `the host was acked ${writtenAt - ackedAt} ms before the history had the line`);
  });
});
