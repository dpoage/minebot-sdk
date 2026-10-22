// Restart on crash and kill on a hung stop: the supervisor ends a program that will not stop by
// killing its host, replaces a host that dies, and the replacement carries the player over. The
// supervisor's side runs against a scripted host (test/fixtures/host/scripted-host.ts) with a
// small grace; the real host is killed once to see the same through the whole body.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { FromHost, HostInit } from "../src/protocol/host.ts";
import type { BodyEvent, ReflexBindingInfo, RunResult } from "../src/protocol/index.ts";

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
  /** The one reflex of the reflex fixture (TRIGGER_FIXTURE). */
  reflex?: { name: string; on: string[]; run: string; when?: string; timeoutMs: number; cooldownMs: number };
  /** The reflex fixture's first host SIGKILLs itself right after the message carrying a reflex_finished leaves it. */
  killAfterFinished?: boolean;
  /** The reflex fixture's first host SIGKILLs itself as the answer to a run's end reaches it. */
  killOnEndAck?: boolean;
  /** The trigger fixture's n-th host SIGKILLs itself once its Triggers sent their counts, before it is ready. */
  dieBeforeReadyOnSpawn?: number;
}

interface Scripted {
  host: InstanceType<typeof HostProcess>;
  events: InstanceType<typeof EventLog>;
  history: string;
}

type History = InstanceType<typeof ProgramHistory>;

/** A history whose final line of a run cannot be written: the end writer throws. */
function refusingEnds(history: History): History {
  const refusing = {
    begin: async (...args: Parameters<History["begin"]>) => {
      await history.begin(...args);
      return async () => {
        throw new Error("disk full");
      };
    },
    register: history.register.bind(history),
  };
  return refusing as unknown as History; // the two methods HostProcess calls
}

/** A history that cannot write a run's start: the run is refused before its code runs. */
function refusingStarts(history: History): History {
  const refusing = {
    begin: async () => {
      throw new Error("start refused");
    },
    register: history.register.bind(history),
  };
  return refusing as unknown as History; // the two methods HostProcess calls
}

let scripts = 0;
async function scripted(script: Script = {}, entry = FIXTURE, carried: Partial<HostInit> = {}, wrap: (history: History) => History = (h) => h): Promise<Scripted> {
  const dir = path.join(ROOT, `scripted-${++scripts}`);
  mkdirSync(dir);
  const events = new EventLog();
  const history = path.join(dir, "history.jsonl");
  const init = { stateDir: dir, startedAt: "t0", deaths: 2, reconnects: 5, applyMilestones: true, ...carried, script: { graceMs: GRACE_MS, ...script } } as unknown as HostInit;
  const host = new HostProcess({ init, events, history: wrap(new ProgramHistory({ file: history })), entry, graceMs: GRACE_MS });
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

  it("ends a reflex's run the same way, with a reflex_finished and no program_finished", { timeout: 20_000 }, async () => {
    const t = await scripted({ trigger: { mode: "block", timeoutMs: 200 } });
    const finished = await waitFor(t, "reflex_finished");
    await waitFor(t, "disconnected");
    assert.deepEqual(finished.data, { name: "t1", status: "timeout", durationMs: finished.data.durationMs, error: restartedError(CAUSE) });
    assert.equal(eventsOf(t, "reflex_finished").length, 1);
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
      wikiMode: "off",
      stateDir: path.join(ROOT, "state-real"),
      milestonesEnabled: false,
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
  it("is started with the counters and the start time of the one it replaces, and without the milestones", { timeout: 40_000 }, async () => {
    const initLog = path.join(ROOT, "carry-init.log");
    const t = await scripted({ mirrorState: true, initLog });
    await killHost(t);
    await get(t, "/ping");
    await killHost(t);
    await get(t, "/ping");
    const inits = readFileSync(initLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as HostInit);
    assert.deepEqual(
      inits.map(({ deaths, reconnects, applyMilestones, startedAt }) => ({ deaths, reconnects, applyMilestones, startedAt })),
      [
        { deaths: 2, reconnects: 5, applyMilestones: true, startedAt: "t0" },
        { deaths: 2, reconnects: 6, applyMilestones: false, startedAt: "t0" },
        { deaths: 2, reconnects: 7, applyMilestones: false, startedAt: "t0" },
      ],
    );
    // What the body does not offer any more is not carried: no active set, and none of the kit options.
    for (const init of inits) assert.deepEqual(Object.keys(init).filter((key) => /active|kit/i.test(key)), []);
  });

  describe("in the host's world", () => {
    const base = {
      name: "w",
      username: "w",
      auth: "offline" as const,
      host: "127.0.0.1",
      port: 1,
      wikiMode: "off" as const,
      milestonesEnabled: true,
      triggers: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      deaths: 2,
      reconnects: 3,
      milestones: MilestoneSet.parse({ milestones: [{ id: "logs", description: "Get logs", obtained: ["*_log"], count: 3 }] }),
    };
    const io = { events: new HostEvents(() => {}), recorder: { record: async () => assert.fail("no run"), deliver: () => assert.fail("no run"), counts: () => {}, preempt: () => false, register: async () => {} } };

    it("starts from the counters and the start time, and without the milestones", async () => {
      const world = buildWorld({ ...base, stateDir: path.join(ROOT, "world-a"), applyMilestones: false }, io);
      try {
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

    it("answers a /run whose end the history refused as the supervisor does for that run when the host dies before answering", { timeout: 20_000 }, async () => {
      // The host's own routes, with the reporter's failure for a refused end: what a live host answers.
      const refusing = { ...io.recorder, record: async () => Promise.reject(new Error("disk full")) };
      const world = buildWorld({ ...base, stateDir: path.join(ROOT, "world-c"), applyMilestones: false }, { events: io.events, recorder: refusing });
      let live: { status: number; body: unknown };
      try {
        writeFileSync(path.join(ROOT, "world-c", "routines", "act.ts"), "export default () => 1;\n");
        await world.serve({ id: 1, method: "POST", url: "/bind", body: JSON.stringify({ kind: "action", name: "act", routine: "act" }), tooLarge: false });
        live = await world.serve({ id: 2, method: "POST", url: "/call", body: JSON.stringify({ name: "act" }), tooLarge: false });
      } finally {
        world.close();
      }
      const t = await scripted({ reflex: { name: "reflex", on: ["fire"], run: "return 1;", timeoutMs: 1_000, cooldownMs: 0 }, killOnEndAck: true }, TRIGGER_FIXTURE, {}, refusingEnds);
      const owed = await t.host.forward({ method: "POST", url: "/call", body: Buffer.from(JSON.stringify({ source: "return 1;" })), tooLarge: false });
      assert.deepEqual(owed, live);
    });
  });
});

describe("restart: a reflex's end when the host dies around it", () => {
  const reflex = (code: string) => ({ name: "reflex", on: ["fire"], run: code, timeoutMs: 200, cooldownMs: 0 });

  it("emits no second reflex_finished when the host dies idle after an ok firing", { timeout: 20_000 }, async () => {
    const t = await scripted({ reflex: reflex("return 1;") }, TRIGGER_FIXTURE);
    t.events.push("fire");
    await waitFor(t, "reflex_finished");
    await killHost(t);
    await get(t, "/ping");
    assert.deepEqual(eventsOf(t, "reflex_finished").map((e) => e.data.status), ["ok"], "the idle host's death delivered the firing again");
  });

  it("leaves one reflex_finished, and the firing counted once, when the host dies right after delivering it", { timeout: 20_000 }, async () => {
    // A firing that times out and settles counts; the reflex has failed once already.
    const t = await scripted({ reflex: { ...reflex("try { await ctx.sleep(100000); } catch {}"), timeoutMs: 100 }, killAfterFinished: true }, TRIGGER_FIXTURE, { triggerFailures: { reflex: 1 } });
    t.events.push("fire");
    await waitFor(t, "disconnected");
    const [info] = ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers; // the replacement host's
    assert.deepEqual(eventsOf(t, "reflex_finished").map((e) => e.data.status), ["timeout"]);
    assert.equal(info!.failures, 2, "the firing was not counted exactly once");
  });

  it("has the supervisor build, for a host that died before delivering a firing, the reflex_finished a live host builds for the same end", { timeout: 30_000 }, async () => {
    const finishedOf = async (killOnEndAck: boolean, wrap?: (history: History) => History) => {
      const t = await scripted({ reflex: reflex(`ctx.log("same end"); return 1;`), killOnEndAck }, TRIGGER_FIXTURE, {}, wrap);
      t.events.push("fire");
      const { data } = await waitFor(t, "reflex_finished");
      if (killOnEndAck) await waitFor(t, "disconnected");
      else assert.equal(eventsOf(t, "disconnected").length, 0);
      const { durationMs, ...rest } = data;
      assert.equal(typeof durationMs, "number");
      return rest;
    };
    // The run's own result, and the error of an end the history refused; whatever the builder puts in, both sides carry it.
    const ok = await finishedOf(false);
    assert.deepEqual(await finishedOf(true), ok);
    assert.equal(ok.logs, "same end");
    const refused = await finishedOf(false, refusingEnds);
    assert.deepEqual(await finishedOf(true, refusingEnds), refused);
    assert.deepEqual([refused.status, refused.error], ["error", "disk full"]);
  });

  describe("the streak a replacement starts from is the dead host's, with nothing sent after the end", () => {
    /** Kills the host by the pid it had before the firing, with no request in between, and reads the replacement's reflex. */
    async function idleDeath(t: Scripted, pid: number): Promise<ReflexBindingInfo> {
      const since = t.events.since(0).next;
      process.kill(pid, "SIGKILL");
      await waitFor(t, "disconnected", since);
      const [info] = ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers;
      return info!;
    }

    // A firing with no run behind it reaches the supervisor in one message with its counts: a death right after it cannot split them.
    const runLess = {
      "its start refused by the history": { run: "return 1;", when: undefined, wrap: refusingStarts, error: /^start refused$/ },
    };
    for (const [name, end] of Object.entries(runLess)) {
      it(`after a firing with no run, ${name}, with the host killed right after the message carrying its reflex_finished`, { timeout: 20_000 }, async () => {
        const t = await scripted(
          { reflex: { ...reflex(end.run), ...(end.when !== undefined && { when: end.when }) }, killAfterFinished: true },
          TRIGGER_FIXTURE,
          { triggerFailures: { reflex: 1 } },
          end.wrap,
        );
        t.events.push("fire");
        await waitFor(t, "disconnected");
        const [info] = ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers; // the replacement host's
        const finished = eventsOf(t, "reflex_finished");
        assert.deepEqual(finished.map((e) => e.data.status), ["error"]);
        assert.match(String(finished[0]!.data.error), end.error);
        assert.equal(info!.failures, 2, "the firing's count was split from its reflex_finished");
      });
    }

    it("after a replacement that counted the lost firing died before it was ready: the next host counts it once", { timeout: 30_000 }, async () => {
      const t = await scripted({ reflex: reflex("await new Promise(() => {});"), dieBeforeReadyOnSpawn: 2 }, TRIGGER_FIXTURE, { triggerFailures: { reflex: 1 } });
      t.events.push("fire");
      await waitFor(t, "disconnected");
      // The second host dies before ready (requests answer 503 until a host is); the third serves.
      let listed: { status: number; body: unknown } | undefined;
      for (const until = Date.now() + 15_000; Date.now() < until; await sleep(100)) {
        listed = await get(t, "/triggers");
        if (listed.status === 200) break;
      }
      assert.equal(listed?.status, 200, "no host became ready");
      assert.equal(readFileSync(path.join(path.dirname(t.history), "spawns"), "utf8").trim().split("\n").length, 3);
      const [info] = (listed!.body as { triggers: ReflexBindingInfo[] }).triggers;
      assert.equal(info!.failures, 2, "the killed firing was counted twice");
      assert.equal(eventsOf(t, "reflex_disabled").length, 0);
      assert.equal(eventsOf(t, "reflex_finished").length, 1);
    });
  });
});

describe("restart: what a run is owed follows its state", () => {
  it("never kills a run whose end waits behind a slow history write across its deadline", { timeout: 20_000 }, async () => {
    const history = new ProgramHistory({ file: path.join(ROOT, "slow-register.jsonl") });
    // A disk this slow holds the register a reflex bind sends during the program; the program's end, sent within its grace, queues behind it past the deadline.
    const slow = {
      begin: history.begin.bind(history),
      register: async (...args: Parameters<typeof history.register>) => {
        await sleep(650);
        return history.register(...args);
      },
    } as unknown as InstanceType<typeof ProgramHistory>;
    const events = new EventLog();
    const dir = path.join(ROOT, "slow-register");
    mkdirSync(dir);
    const init = { stateDir: dir, startedAt: "t0", deaths: 0, reconnects: 0, applyMilestones: true, script: { graceMs: GRACE_MS } } as unknown as HostInit;
    const host = new HostProcess({ init, events, history: slow, entry: FIXTURE, graceMs: GRACE_MS });
    hosts.push(host);
    await host.start();
    host.join();
    const t: Scripted = { host, events, history: path.join(ROOT, "slow-register.jsonl") };
    const before = await pidOf(t);
    // Aborted at 100 ms, it settles at 350, inside the grace; the register goes at 300 and is written at 950; the deadline is at 900.
    const answer = await t.host.forward({ method: "POST", url: "/run?mode=settle&timeoutMs=100&settleMs=250&registerAtMs=300", body: null, tooLarge: false });
    assert.deepEqual(withoutDuration(answer.body).rest, { status: "timeout", logs: "settled" });
    await sleep(500);
    assert.equal(await pidOf(t), before, "the host of a run that ended within its grace was replaced");
    assert.equal(eventsOf(t, "disconnected").length, 0);
  });

  it("keeps no record of a request run once its answer was delivered: stop finds nothing to stop and an idle death owes it nothing", { timeout: 20_000 }, async () => {
    const t = await scripted();
    for (let i = 0; i < 3; i++) assert.deepEqual(withoutDuration((await run(t, "settle", 20)).body).rest, { status: "timeout", logs: "settled" });
    // The host delivers each run right after its answer, so by the answer to this request every run is delivered.
    await pidOf(t);
    assert.equal(t.host.openRuns, 0, "delivered runs are still held");
    assert.deepEqual(await t.host.stop(), { stopped: false });
    await killHost(t);
    assert.equal(eventsOf(t, "program_finished").length, 0, "the idle host's death synthesized a run's end");
    assert.deepEqual(historyOf(t).map((line) => line.status), ["timeout", "timeout", "timeout"]);
  });

  it("does not count a run whose end was reported as running: a stop before its delivery stops nothing and leaves the host", { timeout: 20_000 }, async () => {
    const t = await scripted();
    const before = await pidOf(t);
    // It ends at 20 ms; the host delivers it 1.5 s after its end was recorded, past its deadline (820 ms).
    const request = t.host.forward({ method: "POST", url: "/run?mode=settle&timeoutMs=20&deliverAfterMs=1500", body: null, tooLarge: false });
    await waitFor(t, "acked");
    await sleep(300);
    const t0 = performance.now();
    assert.deepEqual(await t.host.stop(), { stopped: false });
    assert.ok(performance.now() - t0 < 200, "the stop waited on a run that had ended");
    assert.deepEqual(withoutDuration((await request).body).rest, { status: "timeout", logs: "settled" });
    assert.equal(await pidOf(t), before, "the host of a run that had ended was replaced");
    assert.equal(eventsOf(t, "disconnected").length, 0);
  });

  describe("a run whose end the history refused is owed the end the host would have delivered", () => {
    const blocks = (ms: number) => `const until = Date.now() + ${ms}; while (Date.now() < until);`;
    for (const kind of ["request", "trigger"] as const) {
      for (const death of ["late at its deadline", "at the end's ack"] as const) {
        it(`${kind} run, host dead ${death}`, { timeout: 20_000 }, async () => {
          const late = death === "late at its deadline";
          // Late: it blocks past its 100 ms timeout and ends just as the deadline (900 ms) fires, the supervisor held up from 750 to 1000 ms.
          const code = late ? `${blocks(850)} return 1;` : "return 1;";
          const t = await scripted({ reflex: { name: "reflex", on: ["fire"], run: code, timeoutMs: 100, cooldownMs: 0 }, killOnEndAck: !late }, TRIGGER_FIXTURE, { triggerFailures: { reflex: 1 } }, refusingEnds);
          const request = kind === "request" ? t.host.forward({ method: "POST", url: "/call", body: Buffer.from(JSON.stringify({ source: code, timeoutMs: 100 })), tooLarge: false }) : undefined;
          if (kind === "trigger") t.events.push("fire");
          const acked = Number((await waitFor(t, "acked")).data.at);
          if (late) {
            await sleep(Math.max(0, acked + 750 - Date.now()));
            await setImmediate();
            while (Date.now() < acked + 1_000);
          }
          await waitFor(t, "disconnected");
          assert.equal(eventsOf(t, "disconnected").length, 1);
          if (request) {
            assert.deepEqual(await request, { status: 500, body: { error: "disk full" } });
            // The host pushed it before it reported the end.
            assert.deepEqual(eventsOf(t, "program_finished").map((e) => e.data.status), ["ok"]);
            assert.equal(eventsOf(t, "reflex_finished").length, 0);
            return;
          }
          const finished = eventsOf(t, "reflex_finished").map(({ data: { durationMs: _, ...rest } }) => rest);
          assert.deepEqual(finished, [{ name: "reflex", status: "error", error: "disk full" }]);
          assert.equal(eventsOf(t, "program_finished").length, 0);
          const [info] = ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers; // the replacement host's
          assert.deepEqual({ failures: info!.failures, lastStatus: info!.lastStatus, lastError: info!.lastError }, { failures: 2, lastStatus: "error", lastError: "disk full" });
        });
      }
    }
  });
});

describe("restart: every run in flight at its host's death ends once, with its real result when it has one", () => {
  const blocks = (ms: number) => `const until = Date.now() + ${ms}; while (Date.now() < until);`;
  // With timeoutMs 100 and the grace 300, the supervisor's deadline is 900 ms after the ack.
  const cases = {
    killed: { code: "while (true) {}", status: "timeout", error: restartedError(CAUSE), result: undefined },
    "late-ok": { code: `${blocks(850)} return 1;`, status: "ok", error: undefined, result: 1 },
    "late-timeout": { code: `try { await ctx.sleep(100000); } catch {} ${blocks(700)}`, status: "timeout", error: undefined, result: undefined },
  } as const;
  const failuresAfter = { killed: 2, "late-ok": 0, "late-timeout": 2 };

  for (const kind of ["request", "trigger"] as const) {
    for (const [name, end] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
      it(`${kind} run, ${name}`, { timeout: 20_000 }, async () => {
        // The trigger has failed once already: its end counts on, or resets, the streak.
        const t = await scripted({ reflex: { name: "reflex", on: ["fire"], run: end.code, timeoutMs: 100, cooldownMs: 0 } }, TRIGGER_FIXTURE, { triggerFailures: { reflex: 1 } });
        const request =
          kind === "request" ? t.host.forward({ method: "POST", url: "/call", body: Buffer.from(JSON.stringify({ source: end.code, timeoutMs: 100 })), tooLarge: false }) : undefined;
        if (kind === "trigger") t.events.push("fire");
        const acked = Number((await waitFor(t, "acked")).data.at);
        // Held up from 750 to 1000 ms, in the check phase, the supervisor's next loop turn fires the deadline before it reads an end the host sent before it.
        await sleep(Math.max(0, acked + 750 - Date.now()));
        await setImmediate();
        while (Date.now() < acked + 1_000);
        await waitFor(t, "disconnected");

        const expected = { status: end.status, ...(end.error !== undefined && { error: end.error }) };
        if (request) {
          const answer = await request;
          assert.equal(answer.status, 200);
          assert.deepEqual(withoutDuration(answer.body).rest, { ...expected, ...(end.result !== undefined && { result: end.result }), logs: "" });
        }
        // program_finished carries the status alone, as the host pushes it.
        const finished = eventsOf(t, kind === "request" ? "program_finished" : "reflex_finished");
        assert.deepEqual(finished.map(({ data: { durationMs: _, ...rest } }) => rest), [kind === "request" ? { status: end.status } : { name: "reflex", ...expected }]);
        assert.equal(eventsOf(t, kind === "request" ? "reflex_finished" : "program_finished").length, 0);
        assert.deepEqual(historyOf(t).map((line) => line.status), [end.status]);
        const reasons = eventsOf(t, "disconnected").map((e) => String(e.data.reason));
        assert.equal(reasons.length, 1);
        if (name === "killed") assert.equal(reasons[0], `bot host restarted: ${CAUSE}`);
        else assert.doesNotMatch(reasons[0]!, /did not stop/, "the host was restarted for a hang of a run that finished");
        if (kind === "trigger") {
          const [info] = ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers; // the replacement host's
          assert.deepEqual({ failures: info!.failures, lastStatus: info!.lastStatus }, { failures: failuresAfter[name], lastStatus: end.status });
        }
      });
    }
  }
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

describe("restart: the messages the host sends carry no kits", () => {
  it("sends run_started, register, and state with exactly their own fields", async () => {
    const sent: FromHost[] = [];
    const reporter = new RunReporter({ send: (message) => sent.push(message), stop: () => false, running: () => false });
    const registered = reporter.register("event.data.health < 8", { trigger: "t" });
    reporter.acknowledge(0);
    await registered;
    assert.deepEqual(sent, [{ kind: "register", runId: 0, code: "event.data.health < 8", extra: { trigger: "t" } }]);
  });
});

describe("restart: the host's report of a hung run", () => {
  it("is run_finished with hung, the requestId on run_started, and a result without the flag", async () => {
    const sent: FromHost[] = [];
    const reporter = new RunReporter({ send: (message) => sent.push(message), stop: () => false, running: () => false });
    const hung = reporter.record({ code: "x", timeoutMs: 5, requestId: 7 }, async () => ({ status: "stopped", error: "e", logs: "partial", durationMs: 1, hung: true }));
    hung.catch(() => {});
    reporter.acknowledge(0);
    while (!sent.some((message) => message.kind === "run_finished")) await sleep(1);
    assert.deepEqual(sent[0], { kind: "run_started", runId: 0, code: "x", timeoutMs: 5, extra: {}, requestId: 7 });
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

  it("delivers a run after the answer to its request, delivers a firing whose end the history refused, and leaves an end it holds no run for to the caller", async () => {
    const sent: FromHost[] = [];
    const reporter = new RunReporter({ send: (message) => sent.push(message), stop: () => false, running: () => false });
    const ended = async (runId: number) => {
      reporter.acknowledge(runId);
      while (!sent.some((message) => message.kind === "run_finished" && message.runId === runId)) await sleep(1);
    };
    const ok = { status: "ok", logs: "", durationMs: 1 } as const;

    const answered = reporter.record({ code: "x", requestId: 9 }, async () => ok);
    await ended(0);
    reporter.acknowledge(0);
    const result = await answered;
    sent.length = 0;
    reporter.answer({ id: 9, status: 200, body: result });
    assert.deepEqual(sent, [{ kind: "response", id: 9, status: 200, body: ok }, { kind: "run_delivered", runId: 0 }]);

    const finished = { name: "t", status: "error", durationMs: 1, error: "disk full" } as const;
    const refused = reporter.record({ code: "y", trigger: { name: "t", updated: "u" } }, async () => ok);
    await ended(1);
    reporter.acknowledge(1, "disk full");
    const end = await refused.catch((err: unknown) => err);
    sent.length = 0;
    assert.equal(reporter.deliver(end, finished, undefined, { t: 1 }), true);
    assert.deepEqual(sent, [{ kind: "run_delivered", runId: 1, finished, triggerFailures: { t: 1 } }]);

    // A firing whose start the history refused never became a run of the supervisor's: Triggers hands it to `counts`, one message with its counts.
    sent.length = 0;
    const disabled = { name: "t", failures: 3, reason: "r" };
    assert.equal(reporter.deliver(new Error("start refused"), finished, disabled, { t: 3 }), false);
    assert.deepEqual(sent, []);
    reporter.counts({ t: 3 }, { finished, disabled });
    assert.deepEqual(sent, [{ kind: "trigger_counts", triggerFailures: { t: 3 }, finished, disabled }]);
    sent.length = 0;
    reporter.counts({});
    assert.deepEqual(sent, [{ kind: "trigger_counts", triggerFailures: {} }]);
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

// The restart rules of "a reflex's end when the host dies around it", over the reflex fixture: its
// definition is stored with a `routine`, and its firings run `reflex.run` as the stand-in routine.
// The real body's reflexes are killed with their host in test/reflex.test.ts.
describe("restart: a reflex whose firing ends with its host", () => {
  const reflex = (code: string) => ({ name: "reflex", on: ["fire"], run: code, timeoutMs: 200, cooldownMs: 0 });
  const scriptedReflex = (script: Script, carried: Partial<HostInit> = {}, wrap?: (history: History) => History) => scripted(script, TRIGGER_FIXTURE, carried, wrap);
  /** The reflexes the trigger fixture lists. */
  const reflexesOf = async (t: Scripted): Promise<ReflexBindingInfo[]> => ((await get(t, "/triggers")).body as { triggers: ReflexBindingInfo[] }).triggers;

  it("stores the definition with a routine and no program", { timeout: 20_000 }, async () => {
    const t = await scriptedReflex({ reflex: reflex("return 1;") });
    const [info] = await reflexesOf(t);
    assert.deepEqual([info!.kind, info!.routine, info!.name], ["reflex", "stand-in", "reflex"]);
    const stored = JSON.parse(readFileSync(path.join(path.dirname(t.history), "triggers.json"), "utf8")) as Record<string, Record<string, unknown>>;
    assert.equal(stored.reflex!.routine, "stand-in");
    assert.equal("run" in stored.reflex!, false);
  });

  it("has the reflex_finished carry the logs the host reported, cut as the host cuts them", { timeout: 20_000 }, async () => {
    const t = await scriptedReflex({ reflex: reflex(`ctx.log("reflex-log"); ctx.log(".".repeat(${MAX_EVENT_LOGS})); await new Promise(() => {});`) });
    t.events.push("fire");
    const finished = await waitFor(t, "reflex_finished");
    await waitFor(t, "disconnected");
    assert.deepEqual(finished.data, {
      name: "reflex",
      status: "timeout",
      durationMs: finished.data.durationMs,
      error: restartedError(CAUSE),
      logs: `reflex-log\n${".".repeat(MAX_EVENT_LOGS)}`.slice(0, MAX_EVENT_LOGS),
    });
  });

  it("counts the firing toward the failures, so a reflex that never stops is disabled after 3 and restarts the host 3 times", { timeout: 40_000 }, async () => {
    const t = await scriptedReflex({ reflex: reflex("await new Promise(() => {});") });
    for (let firing = 1; firing <= 4; firing++) {
      // A host is up to hear the event.
      await get(t, "/ping");
      const since = t.events.since(0).next;
      t.events.push("fire");
      if (firing <= 3) await waitFor(t, "disconnected", since);
    }
    // A fourth firing would have started by now.
    await sleep(1_000);
    assert.equal(eventsOf(t, "reflex_fired").length, 3);
    assert.equal(eventsOf(t, "disconnected").length, 3);
    const reason = `failed 3 times in a row; last: ${restartedError(CAUSE)}`;
    assert.deepEqual(eventsOf(t, "reflex_disabled").map((e) => e.data), [{ name: "reflex", failures: 3, reason }]);
    const [info] = await reflexesOf(t);
    assert.deepEqual(
      { enabled: info!.enabled, failures: info!.failures, disabledReason: info!.disabledReason, lastStatus: info!.lastStatus, lastError: info!.lastError, fired: info!.fired },
      { enabled: false, failures: 3, disabledReason: reason, lastStatus: "timeout", lastError: restartedError(CAUSE), fired: 0 },
    );
  });

  it("does not charge a reflex bound again during the firing that ended its host", { timeout: 20_000 }, async () => {
    const t = await scriptedReflex({ reflex: { ...reflex("await new Promise(() => {});"), timeoutMs: 1_000 } });
    t.events.push("fire");
    await waitFor(t, "reflex_fired");
    const replaced = await t.host.forward({ method: "POST", url: "/triggers", body: Buffer.from(JSON.stringify(reflex("return 2;"))), tooLarge: false });
    assert.equal((replaced.body as { replaced: boolean }).replaced, true); // the trigger fixture answers with Triggers.addReflex's response
    await waitFor(t, "disconnected");
    const [info] = await reflexesOf(t);
    assert.deepEqual({ failures: info!.failures, lastStatus: info!.lastStatus }, { failures: 0, lastStatus: undefined });
  });

  it("counts the firing once: a host that dies idle after it does not count it again", { timeout: 30_000 }, async () => {
    const t = await scriptedReflex({ reflex: reflex("await new Promise(() => {});") });
    t.events.push("fire");
    await waitFor(t, "disconnected");
    assert.equal((await reflexesOf(t))[0]!.failures, 1);
    await killHost(t);
    assert.equal((await reflexesOf(t))[0]!.failures, 1, "the replacement of an idle host counted the old firing again");
  });

  it("leaves one reflex_finished and the disable logged once when the host dies right after delivering the firing that disabled the reflex", { timeout: 20_000 }, async () => {
    const t = await scriptedReflex({ reflex: { ...reflex("try { await ctx.sleep(100000); } catch {}"), timeoutMs: 100 }, killAfterFinished: true }, { triggerFailures: { reflex: 2 } });
    t.events.push("fire");
    await waitFor(t, "disconnected");
    const [info] = await reflexesOf(t); // the replacement host's
    assert.deepEqual(eventsOf(t, "reflex_finished").map((e) => e.data.status), ["timeout"]);
    assert.deepEqual(eventsOf(t, "reflex_disabled").map((e) => e.data.failures), [3], "the disable the firing caused was lost or logged twice");
    assert.deepEqual({ enabled: info!.enabled, failures: info!.failures }, { enabled: false, failures: 3 });
  });

  describe("the streak a replacement starts from is the dead host's, with nothing sent after the end", () => {
    /** Kills the host by the pid it had before the firing, with no request in between, and reads the replacement's reflex. */
    async function idleDeath(t: Scripted, pid: number): Promise<ReflexBindingInfo> {
      const since = t.events.since(0).next;
      process.kill(pid, "SIGKILL");
      await waitFor(t, "disconnected", since);
      return (await reflexesOf(t))[0]!;
    }

    it("after a firing whose start the history refused", { timeout: 20_000 }, async () => {
      const t = await scriptedReflex({ reflex: reflex("return 1;") }, { triggerFailures: { reflex: 1 } }, refusingStarts);
      const pid = await pidOf(t);
      t.events.push("fire");
      await waitFor(t, "reflex_finished");
      const info = await idleDeath(t, pid);
      assert.deepEqual(eventsOf(t, "reflex_finished").map(({ data: { durationMs: _, ...rest } }) => rest), [{ name: "reflex", status: "error", error: "start refused" }]);
      assert.equal(info.failures, 2, "the refused firing's count did not reach the supervisor");
    });

    it("after a delivered firing", { timeout: 20_000 }, async () => {
      const t = await scriptedReflex({ reflex: { ...reflex("try { await ctx.sleep(100000); } catch {}"), timeoutMs: 100 } }, { triggerFailures: { reflex: 1 } });
      const pid = await pidOf(t);
      t.events.push("fire");
      await waitFor(t, "reflex_finished");
      await sleep(300);
      const info = await idleDeath(t, pid);
      assert.deepEqual(eventsOf(t, "reflex_finished").map((e) => e.data.status), ["timeout"]);
      assert.equal(info.failures, 2, "the delivered firing's count did not reach the supervisor");
    });

    it("after the reflex was bound again, which starts its streak over", { timeout: 20_000 }, async () => {
      const t = await scriptedReflex({ reflex: reflex("return 1;") }, { triggerFailures: { reflex: 2 } });
      const pid = await pidOf(t);
      await t.host.forward({ method: "POST", url: "/triggers", body: Buffer.from(JSON.stringify(reflex("return 2;"))), tooLarge: false });
      const info = await idleDeath(t, pid);
      assert.equal(info.failures, 0);
    });

    it("after a firing with no run, its `when` throwing, with the host killed right after the message carrying its reflex_finished", { timeout: 20_000 }, async () => {
      const t = await scriptedReflex({ reflex: { ...reflex("return 1;"), when: "event.data.nope.x" }, killAfterFinished: true }, { triggerFailures: { reflex: 1 } });
      t.events.push("fire");
      await waitFor(t, "disconnected");
      const [info] = await reflexesOf(t); // the replacement host's
      const finished = eventsOf(t, "reflex_finished");
      assert.deepEqual(finished.map((e) => e.data.status), ["error"]);
      assert.match(String(finished[0]!.data.error), /^when: /);
      assert.equal(info!.failures, 2, "the firing's count was split from its reflex_finished");
    });
  });
});
