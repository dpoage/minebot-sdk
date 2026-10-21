// A bot host for host-restart.test.ts whose world is one trigger: the real HostEvents, RunReporter,
// Triggers, and ProgramRunner over the real channel, with no Minecraft. `init.script` (the test owns
// it) holds the trigger (`reflex`) and the runner's grace. The first host saves the trigger in the state
// directory and every replacement loads it from there, as the body's world does; like the real
// host, the state it reports carries the triggers' failures.
// Requests: /ping answers with this pid, /triggers with the trigger list.
import path from "node:path";
import { HostEvents, RunReporter } from "../../../src/host/channel.ts";
import { Triggers } from "../../../src/host/triggers.ts";
import { BusyError, ProgramRunner } from "../../../src/program/runner.ts";
import type { FromHost, HostInit, ToHost } from "../../../src/protocol/host.ts";
import { JsonStore } from "../../../src/store.ts";

interface Script {
  graceMs: number;
  reflex: { name: string; on: string[]; run: string; timeoutMs: number; cooldownMs: number };
}

const send = (message: FromHost) => process.send!(message);
let events: HostEvents;
let reporter: RunReporter;
let triggers: Triggers;

process.on("message", async (message: ToHost) => {
  switch (message.kind) {
    case "init": {
      const init = message.init as HostInit & { script: Script };
      const runner = new ProgramRunner({ globals: () => ({}), graceMs: init.script.graceMs });
      reporter = new RunReporter({ send, kits: () => [], stop: () => runner.stop() });
      const reportState = () =>
        send({ kind: "state", connected: true, deaths: init.deaths, reconnects: init.reconnects, active: [], triggerFailures: triggers.failures() });
      events = new HostEvents((m) => {
        send(m);
        queueMicrotask(reportState);
      });
      triggers = new Triggers({
        store: new JsonStore(path.join(init.stateDir, "triggers.json")),
        events,
        runner,
        connected: () => true,
        bot: () => undefined,
        run: (trigger, event, started) =>
          reporter.record({ code: trigger.run, timeoutMs: trigger.timeoutMs, extra: { trigger: trigger.name, event: { seq: event.seq, type: event.type } } }, () => {
            if (runner.running) throw new BusyError();
            started();
            return runner.run(trigger.run, trigger.timeoutMs);
          }),
        register: async () => {},
        failures: init.triggerFailures,
        lost: init.lostFiring,
      });
      if (triggers.list().length === 0) await triggers.add(init.script.reflex);
      reportState();
      send({ kind: "ready" });
      return;
    }
    case "request": {
      const url = new URL(message.url, "http://localhost");
      const body = url.pathname === "/triggers" ? { triggers: triggers.list() } : { pid: process.pid };
      send({ kind: "response", id: message.id, status: 200, body });
      return;
    }
    case "stop":
      reporter.stop();
      return;
    case "run_ack":
      reporter.acknowledge(message.runId, message.error);
      return;
    case "event":
      events.hear(message.event);
      return;
    case "shutdown":
      process.exit(0);
  }
});
