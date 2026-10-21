// A bot host for host-restart.test.ts whose world is programs and triggers with no Minecraft: the
// real HostEvents, RunReporter, Triggers, and ProgramRunner over the real channel, wired as the
// body wires them. `init.script` (the test owns it) holds one trigger (`reflex`) and the runner's
// grace. The first host stores the trigger in the state directory before its Triggers load, so the
// failures its init carries apply to it; every replacement loads it from there, as the body's world
// does. Like the real host, its state report carries no trigger counts: they reach the supervisor
// through the reporter, with a delivery or as trigger_counts. It answers requests and delivers
// trigger runs through the reporter. Once acked, every run pushes `acked`
// with the time (ms) before its code starts. The first host, with `killAfterFinished`, SIGKILLs
// itself right after the message that carries a trigger_finished leaves it; with `killOnEndAck`,
// as the supervisor's answer to a run's end reaches it, before it can act on it.
// Requests: GET /ping answers with this pid; GET /triggers with the trigger list; POST /triggers
// saves the trigger in the body; POST /run runs `{code, timeoutMs}` the way the body's /run does.
import path from "node:path";
import { HostEvents, RunReporter } from "../../../src/host/channel.ts";
import { Triggers } from "../../../src/host/triggers.ts";
import { BusyError, ProgramRunner } from "../../../src/program/runner.ts";
import { programFinished, type FromHost, type HostInit, type ToHost } from "../../../src/protocol/host.ts";
import { TriggerInput } from "../../../src/protocol/index.ts";
import { JsonStore } from "../../../src/store.ts";

interface Script {
  graceMs: number;
  reflex: { name: string; on: string[]; run: string; timeoutMs: number; cooldownMs: number };
  killAfterFinished?: boolean;
  killOnEndAck?: boolean;
}

let killAfterFinished = false;
let killOnEndAck = false;
/** Runs whose start was acked: the next ack for one answers its end. */
const startAcked = new Set<number>();
function send(message: FromHost): void {
  process.send!(message);
  const finished = (message.kind === "event" && message.type === "trigger_finished") || (message.kind === "run_delivered" && message.finished !== undefined);
  if (killAfterFinished && finished) process.kill(process.pid, "SIGKILL");
}

let events: HostEvents;
let reporter: RunReporter;
let triggers: Triggers;
let runner: ProgramRunner;

/** Starts a program once its start is acked, telling the test when. */
function start(code: string, timeoutMs: number) {
  events.push("acked", { at: Date.now() });
  return runner.run(code, timeoutMs);
}

async function serve(id: number, method: string, pathname: string, body: string | null): Promise<unknown> {
  if (pathname === "/triggers" && method === "POST") return triggers.add(JSON.parse(body ?? "{}"));
  if (pathname === "/triggers") return { triggers: triggers.list() };
  if (pathname !== "/run") return { pid: process.pid };
  const { code, timeoutMs } = JSON.parse(body ?? "{}") as { code: string; timeoutMs: number };
  return reporter.record({ code, timeoutMs, requestId: id }, async () => {
    const result = await start(code, timeoutMs);
    if (!result.hung) events.push("program_finished", programFinished(result));
    triggers.idle();
    return result;
  });
}

process.on("message", async (message: ToHost) => {
  switch (message.kind) {
    case "init": {
      const init = message.init as HostInit & { script: Script };
      runner = new ProgramRunner({ globals: () => ({}), graceMs: init.script.graceMs });
      reporter = new RunReporter({ send, kits: () => [], stop: () => runner.stop() });
      const reportState = () => send({ kind: "state", connected: true, deaths: init.deaths, reconnects: init.reconnects, active: [] });
      events = new HostEvents((m) => {
        send(m);
        reportState();
      });
      const store = new JsonStore(path.join(init.stateDir, "triggers.json"));
      const first = store.keys().length === 0;
      if (first) store.set(init.script.reflex.name, { ...TriggerInput.parse(init.script.reflex), updated: new Date().toISOString() });
      killAfterFinished = first && init.script.killAfterFinished === true;
      killOnEndAck = first && init.script.killOnEndAck === true;
      triggers = new Triggers({
        store,
        events,
        runner,
        connected: () => true,
        bot: () => undefined,
        run: (trigger, event, started) =>
          reporter.record(
            { code: trigger.run, timeoutMs: trigger.timeoutMs, extra: { trigger: trigger.name, event: { seq: event.seq, type: event.type } }, trigger: { name: trigger.name, updated: trigger.updated } },
            () => {
              if (runner.running) throw new BusyError();
              started();
              return start(trigger.run, trigger.timeoutMs);
            },
          ),
        deliver: (end, finished, disabled, failures) => reporter.deliver(end, finished, disabled, failures),
        counts: (failures) => reporter.counts(failures),
        register: async () => {},
        failures: init.triggerFailures,
        lost: init.lostFiring,
      });
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
