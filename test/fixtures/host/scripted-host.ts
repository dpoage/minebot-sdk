// A bot host for host-restart.test.ts: the supervisor's IPC contract spoken by a script, with no
// world. What it does is read from `init.script` (the test owns it):
//   spawnLog / initLog  files it appends its pid / its init (minus the script) to, one line per spawn
//   failFrom            from this spawn number on, exits with code 3 before it is ready
//   crashAfterReadyMs   exits this long after it is ready
//   mirrorState         reports the deaths / reconnects / active it was started with
//   graceMs             how long its `report` runs wait after an abort before reporting themselves hung
//   ackLog              file it writes the time (ms) it was acked a run's start to
//   trigger             a run with no request, started at `start`: { mode, timeoutMs }
// Once built it pushes a `hello` event with its pid. A run's end the supervisor acked is delivered
// as the real host delivers it: after the answer to its request, or with its trigger_finished.
// Requests: /ping and /notes answer with this pid; /slow never answers; /run?mode=...&timeoutMs=...
// starts a run that answers the request:
//   block   takes the main thread once acked
//   crash   SIGKILLs itself once acked
//   hang    stays alive and never ends or reports
//   report  after the abort (a stop, or timeoutMs) waits graceMs, then reports itself hung with logs "partial"
//   settle  ends at the abort, reporting its result; with settleMs, that long after the abort; with
//           registerAtMs, sends a `register` (as a POST /triggers during a program does) that long after its ack;
//           with deliverAfterMs, answers and delivers that long after its end was acked
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { hungCause, restartedError, triggerFinished, type FromHost, type HostInit, type ToHost } from "../../../src/protocol/host.ts";
import type { RunResult } from "../../../src/protocol/index.ts";

interface Script {
  spawnLog?: string;
  initLog?: string;
  ackLog?: string;
  failFrom?: number;
  crashAfterReadyMs?: number;
  mirrorState?: boolean;
  graceMs?: number;
  trigger?: { mode: string; timeoutMs: number };
}

interface Run {
  mode: string;
  timeoutMs: number;
  settleMs: number;
  deliverAfterMs: number;
  registerAtMs?: number;
  requestId?: number;
  trigger?: string;
  phase: "starting" | "running" | "finishing";
  result?: RunResult;
}

const send = (message: FromHost) => process.send!(message);
const runs = new Map<number, Run>();
const aborts: (() => void)[] = [];
let script: Script = {};
let nextRun = 0;

function startRun(run: Omit<Run, "phase">): void {
  const runId = nextRun++;
  runs.set(runId, { ...run, phase: "starting" });
  const { trigger, requestId, timeoutMs } = run;
  const extra = trigger === undefined ? {} : { trigger, event: { seq: 1, type: "x" } };
  send({ kind: "run_started", runId, code: "program", timeoutMs, extra, kits: [], ...(requestId !== undefined && { requestId }), ...(trigger !== undefined && { trigger: { name: trigger, updated: "t0" } }) });
}

function running(runId: number, run: Run): void {
  run.phase = "running";
  if (script.ackLog) appendFileSync(script.ackLog, `${Date.now()}\n`);
  // The host acks `acked` before it blocks: the test waits for it to know the deadline is armed.
  send({ kind: "event", type: "acked", data: { runId } });
  if (run.mode === "block") {
    for (;;);
  }
  if (run.mode === "crash") process.kill(process.pid, "SIGKILL");
  if (run.mode === "hang") return;
  if (run.registerAtMs !== undefined) {
    setTimeout(() => send({ kind: "register", runId: nextRun++, code: "trigger", extra: {}, kits: [] }), run.registerAtMs);
  }
  const startedAt = Date.now();
  const abort = new Promise<"stopped" | "timeout">((resolve) => {
    aborts.push(() => resolve("stopped"));
    setTimeout(() => resolve("timeout"), run.timeoutMs);
  });
  void abort.then(async (status) => {
    if (run.mode === "report") {
      await new Promise((resolve) => setTimeout(resolve, script.graceMs ?? 0));
      const result: RunResult = { status, error: restartedError(hungCause(script.graceMs ?? 0)), logs: "partial", durationMs: Date.now() - startedAt };
      send({ kind: "run_finished", runId, result, hung: true });
      return;
    }
    if (run.settleMs > 0) await sleep(run.settleMs);
    run.result = { status, logs: "settled", durationMs: Date.now() - startedAt };
    run.phase = "finishing";
    send({ kind: "run_finished", runId, result: run.result });
  });
}

/** The supervisor recorded the run's end: answer its request, or push its trigger_finished, then deliver it (deliverAfterMs later). */
async function deliver(runId: number, run: Run): Promise<void> {
  runs.delete(runId);
  const result = run.result!;
  if (run.deliverAfterMs > 0) await sleep(run.deliverAfterMs);
  if (run.requestId !== undefined) {
    send({ kind: "response", id: run.requestId, status: 200, body: result });
    send({ kind: "run_delivered", runId });
  } else if (run.trigger !== undefined) {
    send({ kind: "run_delivered", runId, finished: triggerFinished(run.trigger, result), triggerFailures: {} });
  }
}

process.on("message", (message: ToHost) => {
  switch (message.kind) {
    case "init": {
      const init = message.init as HostInit & { script?: Script };
      script = init.script ?? {};
      const { script: _, ...rest } = init;
      if (script.initLog) appendFileSync(script.initLog, `${JSON.stringify(rest)}\n`);
      if (script.spawnLog) appendFileSync(script.spawnLog, `${process.pid}\n`);
      const spawn = script.spawnLog ? readFileSync(script.spawnLog, "utf8").trim().split("\n").length : 1;
      if (script.failFrom !== undefined && spawn >= script.failFrom) process.exit(3);
      if (script.mirrorState) {
        send({ kind: "state", connected: true, deaths: init.deaths, reconnects: init.reconnects, active: init.active ?? [] });
      }
      send({ kind: "event", type: "hello", data: { pid: process.pid } });
      send({ kind: "ready" });
      if (script.crashAfterReadyMs !== undefined) setTimeout(() => process.exit(1), script.crashAfterReadyMs);
      return;
    }
    case "start":
      if (script.trigger) startRun({ mode: script.trigger.mode, timeoutMs: script.trigger.timeoutMs, settleMs: 0, deliverAfterMs: 0, trigger: "t1" });
      return;
    case "request": {
      const url = new URL(message.url, "http://localhost");
      const { searchParams: q } = url;
      if (url.pathname === "/ping" || url.pathname === "/notes") send({ kind: "response", id: message.id, status: 200, body: { pid: process.pid } });
      else if (url.pathname === "/run") {
        startRun({
          mode: q.get("mode") ?? "settle",
          timeoutMs: Number(q.get("timeoutMs") ?? 60_000),
          settleMs: Number(q.get("settleMs") ?? 0),
          deliverAfterMs: Number(q.get("deliverAfterMs") ?? 0),
          ...(q.has("registerAtMs") && { registerAtMs: Number(q.get("registerAtMs")) }),
          requestId: message.id,
        });
      }
      // /slow, and anything else: no answer.
      return;
    }
    case "stop":
      for (const abort of aborts.splice(0)) abort();
      return;
    case "run_ack": {
      const run = runs.get(message.runId);
      if (!run) return;
      if (run.phase === "starting") running(message.runId, run);
      else void deliver(message.runId, run);
      return;
    }
    case "shutdown":
      process.exit(0);
  }
});
