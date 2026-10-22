// The supervisor / bot-host split: one event log whose seq the host's triggers report, a run
// history whose failures fail the run, request bodies the supervisor reads by the API's rules, and
// a host that never outlives its supervisor and ends with it on a signal to the whole process group.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { RunReporter } from "../src/host/channel.ts";
import type { FromHost, HostInit } from "../src/protocol/host.ts";
import type { Endpoint, RunResult } from "../src/protocol/index.ts";
import { MAX_BODY_BYTES } from "../src/protocol/request.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-host-process-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
const REPO = path.join(import.meta.dirname, "..");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "host");

// MINEBOT_RUNTIME_DIR is read when the discovery module loads.
const { EventLog } = await import("../src/body/events.ts");
const { HostProcess } = await import("../src/body/host-process.ts");
const { ProgramHistory } = await import("../src/body/history.ts");
const { startDaemon } = await import("../src/body/daemon.ts");

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A loopback port that refuses connections: bound once, then released. */
async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether a process is running; a zombie awaiting its reaper is gone. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

/** Resolves once the process is gone, polling; false when it is still there after `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

function childrenOf(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

describe("one event log", () => {
  it("numbers a host's events in the supervisor's log, and the trigger that fires on one reports that seq", async () => {
    const events = new EventLog();
    // The log already holds events the host never saw, so its seq cannot be the host's own count.
    for (const type of ["a", "b", "c"]) events.push(type);
    const host = new HostProcess({
      init: { stateDir: path.join(ROOT, "seq-host") } as HostInit,
      events,
      history: new ProgramHistory({}),
      entry: path.join(FIXTURES, "seq-host.ts"),
    });
    try {
      await host.start();
      host.join();
      await events.wait({ types: ["reflex_finished"], since: 0, timeoutMs: 10_000 });
      const logged = events.since(0).events;
      assert.deepEqual(
        logged.map((event) => event.type),
        ["a", "b", "c", "ping", "reflex_fired", "reflex_finished"],
        "each host event is in the log once, in production order",
      );
      const ping = logged[3]!;
      assert.equal(ping.seq, 4, "the host's event was numbered by the log, after the three it holds");
      assert.deepEqual(logged[4]!.data.event, { seq: ping.seq, type: "ping" });
    } finally {
      await host.close();
    }
  });
});

describe("a host that cannot start", () => {
  it("rejects start() with how it exited, and leaves the supervisor running", async () => {
    const host = new HostProcess({ init: {} as HostInit, events: new EventLog(), history: new ProgramHistory({}), entry: path.join(FIXTURES, "exit-host.ts") });
    await assert.rejects(host.start(), { message: "the bot host exited before it was ready (code 3)" });
    await host.close();
  });
});

describe("a run whose end the history cannot write", () => {
  /** What the run host's two runs (one with a result, one that throws first) ended with, over a history at `file`. */
  async function recordedRuns(file: string): Promise<Record<string, unknown>[]> {
    const events = new EventLog();
    const host = new HostProcess({ init: {} as HostInit, events, history: new ProgramHistory({ file }), entry: path.join(FIXTURES, "run-host.ts") });
    try {
      await host.start();
      host.join();
      const first = await events.wait({ types: ["recorded"], since: 0, timeoutMs: 10_000 });
      const second = await events.wait({ types: ["recorded"], since: first.next, timeoutMs: 10_000 });
      return [first.event!.data, second.event!.data];
    } finally {
      await host.close();
    }
  }

  it("fails the run with the write's error, as when the history was written in the same process", async () => {
    // A directory where the file should be: the run's final line cannot be appended.
    const file = path.join(ROOT, "history-is-a-directory");
    mkdirSync(file);
    const [result, thrown] = await recordedRuns(file);
    assert.equal(result!.name, "result");
    assert.match(String(result!.error), /^EISDIR: /, "the run settled before its end was recorded");
    assert.deepEqual(thrown, { name: "thrown", error: "the body is not connected" }, "a run that threw before its result keeps its own error");
  });

  it("settles a run once its final line is on disk", async () => {
    const file = path.join(ROOT, "history-written.jsonl");
    const [result, thrown] = await recordedRuns(file);
    assert.deepEqual(result, { name: "result", status: "ok" });
    assert.deepEqual(thrown, { name: "thrown", error: "the body is not connected" });
    assert.deepEqual(
      readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).status),
      ["ok"],
    );
  });
});

describe("the run reporter", () => {
  it("drops a stop meant for a run the history refused, so the next run is not aborted", async () => {
    const sent: FromHost[] = [];
    let stops = 0;
    const reporter = new RunReporter({
      send: (message) => sent.push(message),
      stop: () => {
        stops++;
        return false;
      },
      running: () => false,
    });
    const result: RunResult = { status: "ok", result: 1, logs: "", durationMs: 0 };
    const refused = reporter.record({ code: "return 1;" }, async () => result);
    // The stop arrives while the run waits for the history to record its start, which then fails.
    reporter.stop();
    reporter.acknowledge(0, "EACCES: permission denied");
    await assert.rejects(refused, { message: "EACCES: permission denied" });

    stops = 0;
    const next = reporter.record({ code: "return 2;" }, async () => result);
    reporter.acknowledge(1);
    while (!sent.some((message) => message.kind === "run_finished" && message.runId === 1)) await sleep(1);
    reporter.acknowledge(1);
    assert.deepEqual(await next, result);
    assert.equal(stops, 0, "the next run was aborted by a stale stop");
  });
});

describe("the supervisor's reading of request bodies", () => {
  let daemon: { endpoint: Endpoint; close: () => Promise<void> };
  before(async () => {
    daemon = await startDaemon({
      name: "reading",
      username: "reading",
      auth: "offline",
      host: "127.0.0.1",
      port: await refusedPort(),
      apiHost: "127.0.0.1",
      apiPort: 0,
      wikiMode: "off",
      stateDir: path.join(ROOT, "state-reading"),
      milestonesEnabled: false,
      triggers: false,
    });
  });
  after(() => daemon.close());

  /**
   * POSTs `body` as a client that writes its whole request before it reads anything (as Python's
   * http.client does), then reads the answer. Node's own client reads while it writes, and would
   * see an answer the server sent before resetting the connection.
   */
  async function post(pathname: string, body: Buffer): Promise<{ status: number; body: unknown }> {
    const { port } = new URL(daemon.endpoint.url);
    const socket = net.connect(Number(port), "127.0.0.1");
    const received: Buffer[] = [];
    // Settles with the connection: resolves when the server closes it, rejects when it resets it.
    const closed = Promise.withResolvers<void>();
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("end", () => closed.resolve());
    socket.on("error", closed.reject);
    const connected = Promise.withResolvers<void>();
    socket.once("connect", () => connected.resolve());
    await Promise.race([connected.promise, closed.promise]);
    socket.pause();
    const head = `POST ${pathname} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${daemon.endpoint.token}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`;
    // A failed write also fails `closed`, through the socket's error.
    const written = Promise.withResolvers<void>();
    socket.write(Buffer.concat([Buffer.from(head), body]), () => written.resolve());
    await Promise.race([written.promise, closed.promise]);
    socket.resume();
    await closed.promise;
    const response = Buffer.concat(received).toString("utf8");
    const status = Number(/^HTTP\/1\.1 (\d{3}) /.exec(response)?.[1]);
    return { status, body: JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4)) };
  }

  it("answers a body far past the cap with the 404 of a route the body does not serve", async () => {
    const large = Buffer.alloc(5 * 1024 * 1024, "x");
    assert.deepEqual(await post("/unknown", large), { status: 404, body: { error: "no route for POST /unknown" } });
    // No body serves /triggers (reflexes are bound through /bind), so its body is not read either.
    assert.deepEqual(await post("/triggers", large), { status: 404, body: { error: "no route for POST /triggers" } });
  });

  it("reads a wait's body by the API's rules: JSON, and no larger than the cap", async () => {
    assert.deepEqual(await post("/wait", Buffer.from("nope")), { status: 400, body: { error: "request body is not valid JSON" } });
    assert.deepEqual(await post("/wait", Buffer.alloc(MAX_BODY_BYTES + 1, "x")), { status: 413, body: { error: "request body too large" } });
  });
});

describe("the host's lifetime", () => {
  const bodies: ChildProcess[] = [];
  after(() => {
    for (const body of bodies) if (body.pid !== undefined && alive(body.pid)) process.kill(body.pid, "SIGKILL");
  });

  /** `minebot body` in its own process group (as a terminal or systemd runs it), on a port that refuses connections. */
  async function startBody(): Promise<{ body: ChildProcess; pid: number; hostPid: number; exited: Promise<number | null>; state: string }> {
    const state = path.join(ROOT, `state-${bodies.length}`);
    mkdirSync(state, { recursive: true });
    const port = await refusedPort();
    const body = spawn(process.execPath, ["--conditions=minebot-sdk:source", path.join(REPO, "src", "cli.ts"), "body", "--bot", "x", "--host", "127.0.0.1", "--port", String(port), "--state", state], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MINEBOT_RUNTIME_DIR: path.join(ROOT, `runtime-${bodies.length}`) },
    });
    bodies.push(body);
    const exited = new Promise<number | null>((resolve) => body.once("exit", (code) => resolve(code)));
    let output = "";
    const up = Promise.withResolvers<void>();
    body.stderr!.on("data", (chunk: Buffer) => {
      output += chunk;
      if (output.includes("] body \"x\" API at")) up.resolve();
    });
    await Promise.race([up.promise, exited.then((code) => assert.fail(`the body exited with ${code} before it was up:\n${output}`))]);
    const pid = body.pid!;
    const [hostPid] = childrenOf(pid);
    assert.ok(hostPid !== undefined, "the body has no host child");
    return { body, pid, hostPid, exited, state };
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`ends with the supervisor, exit 0 and no host left, on ${signal} to the whole process group`, async () => {
      const { pid, hostPid, exited, state } = await startBody();
      process.kill(-pid, signal);
      assert.equal(await exited, 0);
      assert.ok(await goneWithin(hostPid, 2000), "the host outlived the supervisor");
      // Only the host's own shutdown writes the kit stats file, with no program having run.
      assert.ok(existsSync(path.join(state, "kit-stats.json")), "the host did not run its shutdown");
    });
  }

  it("leaves no host when the supervisor is killed while the host is idle", async () => {
    const { pid, hostPid, exited } = await startBody();
    process.kill(pid, "SIGKILL");
    await exited;
    assert.ok(await goneWithin(hostPid, 2000), "the host outlived a killed supervisor");
  });

  it("leaves no host when the supervisor is killed while the host's main thread is blocked", async () => {
    const parent = spawn(process.execPath, ["--conditions=minebot-sdk:source", path.join(FIXTURES, "parent-process.ts")], { stdio: ["ignore", "pipe", "inherit"] });
    bodies.push(parent);
    const line = Promise.withResolvers<string>();
    parent.stdout!.on("data", (chunk: Buffer) => line.resolve(chunk.toString()));
    const hostPid = Number(/child (\d+)/.exec(await line.promise)?.[1]);
    assert.ok(hostPid > 0, "the parent never reported the host");
    try {
      await sleep(200);
      assert.ok(alive(hostPid));
      parent.kill("SIGKILL");
      assert.ok(await goneWithin(hostPid, 2000), "the blocked host outlived a killed supervisor");
    } finally {
      if (alive(hostPid)) process.kill(hostPid, "SIGKILL");
    }
  });

  it("leaves no host after close()", async () => {
    const state = path.join(ROOT, "state-close");
    const daemon = await startDaemon({
      name: "closing",
      username: "closing",
      auth: "offline",
      host: "127.0.0.1",
      port: await refusedPort(),
      apiHost: "127.0.0.1",
      apiPort: 0,
      wikiMode: "off",
      stateDir: state,
      milestonesEnabled: false,
    });
    const [hostPid] = childrenOf(process.pid).filter((pid) => alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("host/main"));
    assert.ok(hostPid !== undefined, "the daemon has no host child");
    await daemon.close();
    assert.ok(!alive(hostPid), "the host was still running when close() returned");
    assert.ok(!existsSync(path.join(ROOT, "runtime", "closing.json")));
  });
});
