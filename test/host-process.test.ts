// The supervisor / bot-host split: one event log whose seq the host's triggers report, and a host
// that never outlives its supervisor and ends with it on a signal to the whole process group.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostInit } from "../src/protocol/host.ts";

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
      init: {} as HostInit,
      events,
      history: new ProgramHistory({}),
      entry: path.join(FIXTURES, "seq-host.ts"),
    });
    try {
      await host.start();
      host.join();
      await events.wait({ types: ["trigger_finished"], since: 0, timeoutMs: 10_000 });
      const logged = events.since(0).events;
      assert.deepEqual(
        logged.map((event) => event.type),
        ["a", "b", "c", "ping", "trigger_fired", "trigger_finished"],
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
      lockKits: false,
      wikiMode: "off",
      stateDir: state,
      milestonesEnabled: false,
      agentKits: false,
    });
    const [hostPid] = childrenOf(process.pid).filter((pid) => alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("host/main"));
    assert.ok(hostPid !== undefined, "the daemon has no host child");
    await daemon.close();
    assert.ok(!alive(hostPid), "the host was still running when close() returned");
    assert.ok(!existsSync(path.join(ROOT, "runtime", "closing.json")));
  });
});
