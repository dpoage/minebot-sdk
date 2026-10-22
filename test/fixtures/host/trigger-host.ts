// A bot host for host-restart.test.ts and preempt-deadline.test.ts whose world is routines and
// reflexes with no Minecraft: the real HostEvents, RunReporter, Triggers, and ProgramRunner over the
// real channel, wired as the body wires them. `init.script` (the test owns it) holds one reflex
// (`reflex`) and the runner's grace. The first host stores the reflex in the state directory before
// its Triggers load, so the failures its init carries apply to it; every replacement loads it from
// there, as the body's world does. Like the real host, its state report carries no reflex counts:
// they reach the supervisor through the reporter, with a delivery or as trigger_counts. It answers
// requests and delivers reflex runs through the reporter. Once acked, every run pushes `acked`
// with the time (ms) before its code starts. The first host, with `killAfterFinished`, SIGKILLs
// itself right after the message that carries a reflex_finished leaves it; with `killOnEndAck`,
// as the supervisor's answer to a run's end reaches it, before it can act on it. With
// `dieBeforeReadyOnSpawn: n`, the n-th host SIGKILLs itself once its Triggers are built (their
// counts sent) and before it is ready.
// A preempting firing stops the running run through `reporter.preempt()`, as the body's Triggers do; `burstOnEvent` queues a burst in the channel ahead of it.
// The reporter holds the run slot, as the body's does: a /call or firing that arrives while a run holds it is refused as busy, and a firing waiting for it starts when it frees.
// Requests: GET /ping answers with this pid; GET /triggers with the reflex list; POST /triggers
// binds the reflex in the body; POST /call runs `{source, timeoutMs}` as a routine the way the body's
// /call does.
// A stand-in routine is the body of a function over `ctx` (the run's scope: `log`, `sleep`, `signal`,
// `on`) that `runner.call` runs; the fixture has no routine library, so its source is what a routine
// would be. The definition is a reflex (a `routine` body): its firings run `script.reflex.run` (or what
// POST /triggers last saved under the name) as the stand-in routine, and the scheduler, channel, and
// supervisor see what they see for a body's reflex.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { HostEvents, preemptingRunner, RunReporter } from "../../../src/host/channel.ts";
import { Triggers } from "../../../src/host/triggers.ts";
import { ProgramRunner } from "../../../src/program/runner.ts";
import type { ProgramScope } from "../../../src/program/scope.ts";
import { programFinished, type FromHost, type HostInit, type ToHost } from "../../../src/protocol/host.ts";
import { ReflexInput } from "../../../src/protocol/index.ts";
import { JsonStore } from "../../../src/store.ts";

interface Script {
  graceMs: number;
  reflex: { name: string; on: string[]; run: string; when?: string; timeoutMs: number; cooldownMs: number; preempt?: boolean; priority?: number };
  killAfterFinished?: boolean;
  killOnEndAck?: boolean;
  dieBeforeReadyOnSpawn?: number;
  /** On hearing an event of `type`, before the reflexes do, the host sends `count` events of about `bytes` each: a burst in the channel ahead of whatever the reflexes send next. */
  burstOnEvent?: { type: string; count: number; bytes: number };
}

let killAfterFinished = false;
let killOnEndAck = false;
/** Runs whose start was acked: the next ack for one answers its end. */
const startAcked = new Set<number>();
function send(message: FromHost, written?: () => void): void {
  if (written) process.send!(message, () => written());
  else process.send!(message);
  const finished =
    (message.kind === "event" && message.type === "reflex_finished") ||
    ((message.kind === "run_delivered" || message.kind === "trigger_counts") && message.finished !== undefined);
  if (killAfterFinished && finished) process.kill(process.pid, "SIGKILL");
}

let events: HostEvents;
let reporter: RunReporter;
let triggers: Triggers;
let runner: ProgramRunner;

/** Where the stand-in routines' errors are located: the state directory of this host. */
let sourceDir = "";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...parameters: string[]) => (ctx: ProgramScope) => Promise<unknown>;

/** Starts a stand-in routine (`source` is the body of its function over `ctx`) once its start is acked, telling the test when. */
function start(source: string, timeoutMs: number) {
  events.push("acked", { at: Date.now() });
  return runner.call(async (scope) => new AsyncFunction("ctx", source)(scope), { timeoutMs, sourceDir });
}

/** The routine a reflex of this fixture names; the fixture has no library, so nothing loads it. */
const ROUTINE = "stand-in";
/** The source each reflex stands in for, by name. */
const programs = new Map<string, string>();

function save(input: { name: string; run: string }): Promise<unknown> {
  const { run, ...fields } = input;
  programs.set(fields.name, run);
  return triggers.addReflex({ ...fields, routine: ROUTINE });
}

async function serve(id: number, method: string, pathname: string, body: string | null): Promise<unknown> {
  if (pathname === "/triggers" && method === "POST") return save(JSON.parse(body ?? "{}"));
  if (pathname === "/triggers") return { triggers: triggers.reflexes() };
  if (pathname !== "/call") return { pid: process.pid };
  const { source, timeoutMs } = JSON.parse(body ?? "{}") as { source: string; timeoutMs: number };
  return reporter.record({ code: source, timeoutMs, requestId: id }, async () => {
    const result = await start(source, timeoutMs);
    if (!result.hung) events.push("program_finished", programFinished(result));
    return result;
  });
}

process.on("message", async (message: ToHost) => {
  switch (message.kind) {
    case "init": {
      const init = message.init as HostInit & { script: Script };
      runner = new ProgramRunner({ graceMs: init.script.graceMs });
      sourceDir = init.stateDir;
      reporter = new RunReporter({ send, stop: () => runner.stop(), running: () => runner.running !== null });
      const reportState = () => send({ kind: "state", connected: true, deaths: init.deaths, reconnects: init.reconnects });
      events = new HostEvents((m) => {
        send(m);
        reportState();
      });
      const store = new JsonStore(path.join(init.stateDir, "triggers.json"));
      const first = store.keys().length === 0;
      const { run: program, ...fields } = init.script.reflex;
      programs.set(fields.name, program);
      if (first) store.set(fields.name, { ...ReflexInput.parse({ ...fields, routine: ROUTINE }), updated: new Date().toISOString() });
      killAfterFinished = first && init.script.killAfterFinished === true;
      killOnEndAck = first && init.script.killOnEndAck === true;
      reporter.onIdle(() => triggers.idle());
      const { burstOnEvent } = init.script;
      if (burstOnEvent) {
        events.subscribe((event) => {
          if (event.type === burstOnEvent.type) for (let i = 0; i < burstOnEvent.count; i++) events.push("burst", { pad: "x".repeat(burstOnEvent.bytes) });
        });
      }
      triggers = new Triggers({
        store,
        events,
        // As the body wires it: a preemption goes through the reporter.
        runner: preemptingRunner(reporter),
        connected: () => true,
        bot: () => undefined,
        reflexes: true,
        run: (reflex, event, started) => {
          const code = programs.get(reflex.name)!;
          return reporter.record(
            { code, timeoutMs: reflex.timeoutMs, extra: { trigger: reflex.name, event: { seq: event.seq, type: event.type } }, trigger: { name: reflex.name, updated: reflex.updated } },
            () => {
              started();
              return start(code, reflex.timeoutMs);
            },
          );
        },
        deliver: (end, finished, disabled, failures) => reporter.deliver(end, finished, disabled, failures),
        counts: (failures, ended) => reporter.counts(failures, ended),
        register: async () => {},
        failures: init.triggerFailures,
        lost: init.lostFiring,
      });
      const spawnLog = path.join(init.stateDir, "spawns");
      appendFileSync(spawnLog, `${process.pid}\n`);
      if (init.script.dieBeforeReadyOnSpawn === readFileSync(spawnLog, "utf8").trim().split("\n").length) {
        // Once everything sent so far (its counts) is written.
        process.send!({ kind: "state", connected: false, deaths: init.deaths, reconnects: init.reconnects }, () => process.kill(process.pid, "SIGKILL"));
        return;
      }
      reportState();
      send({ kind: "ready" });
      return;
    }
    case "request": {
      const { id, method, body } = message;
      const { pathname } = new URL(message.url, "http://localhost");
      try {
        reporter.answer({ id, status: 200, body: await serve(id, method, pathname, body) });
      } catch (err) {
        reporter.answer({ id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }
    case "stop":
      reporter.stop();
      return;
    case "run_ack":
      if (startAcked.has(message.runId) && killOnEndAck) process.kill(process.pid, "SIGKILL");
      startAcked.add(message.runId);
      reporter.acknowledge(message.runId, message.error);
      return;
    case "event":
      events.hear(message.event);
      return;
    case "shutdown":
      process.exit(0);
  }
});
