// The bot host's entry: forked by the supervisor (src/body/host-process.ts) with its pid as the
// only argument. It builds the world the supervisor's init describes, answers the API requests the
// supervisor forwards, and exits on `shutdown`, when the channel closes, or when its supervisor is gone.
import { supervisorPidOf, type FromHost, type ToHost } from "../protocol/host.ts";
import type { HostEvents, RunReporter } from "./channel.ts";
import { watchSupervisor } from "./supervisor-watch.ts";
import type { World } from "./world.ts";

// A terminal or service manager signals the whole process group; the supervisor decides when the
// host ends and says so with `shutdown`. These handlers are the first thing that runs, before the
// world's modules load.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const supervisorPid = supervisorPidOf(process.argv);
if (supervisorPid === undefined || !process.send) {
  console.error("[minebot] the bot host is started by the body supervisor, not directly");
  process.exit(1);
}
// The channel closing means the supervisor is gone.
process.once("disconnect", () => process.exit(0));
// A program can block this thread, and then the closing of the channel is never seen.
watchSupervisor(supervisorPid);

const modules = Promise.all([import("./channel.ts"), import("./world.ts")]);

function send(message: FromHost): void {
  process.send!(message);
}

/** Sends a message and resolves once it is written; one sent after it is written too. */
function sendWritten(message: FromHost): Promise<void> {
  const written = Promise.withResolvers<void>();
  try {
    process.send!(message, (err: Error | null) => (err ? written.reject(err) : written.resolve()));
  } catch (err) {
    written.reject(err);
  }
  return written.promise.catch(() => {});
}

let handling = modules.then(() => {});
process.on("message", (message: ToHost) => {
  handling = handling.then(() => handle(message)).catch((err: unknown) => {
    console.error("[minebot] bot host message failed:", err);
  });
});

let world: World | undefined;
let events: HostEvents;
let reporter: RunReporter;
let lastState = "";

/** Tells the supervisor what it mirrors of the body (its health, a restart's carry-over) when it changed. */
function reportState(): void {
  if (!world) return;
  const state = currentState(world);
  const text = JSON.stringify(state);
  if (text === lastState) return;
  lastState = text;
  send(state);
}

function currentState({ body, kits }: World): FromHost {
  return { kind: "state", connected: body.connected, deaths: body.deaths, reconnects: body.reconnects, active: kits.active, triggerFailures: body.triggers?.failures() ?? {} };
}

async function handle(message: ToHost): Promise<void> {
  const [{ HostEvents, RunReporter }, { buildWorld }] = await modules;
  switch (message.kind) {
    case "init":
      events = new HostEvents((m) => {
        send(m);
        // Once what pushed the event has changed in the same turn: a trigger counts its failure after its trigger_finished.
        queueMicrotask(reportState);
      });
      reporter = new RunReporter({ send, kits: () => world?.kits.active ?? [], stop: () => world?.body.runner.stop() ?? false });
      try {
        world = buildWorld(message.init, { events, recorder: reporter });
      } catch (err) {
        await sendWritten({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      }
      reportState();
      send({ kind: "ready" });
      return;
    case "start":
      world?.start();
      return;
    case "request":
      void world?.serve(message).then(({ status, body }) => {
        // The reporter delivers the run the answer carries the end of, after the answer.
        reporter.answer({ id: message.id, status, body });
        reportState();
      });
      return;
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
      // Off the message chain: the runs it ends settle only on the supervisor's `run_ack`, which arrives behind it.
      void shutdown();
  }
}

async function shutdown(): Promise<void> {
  try {
    world?.close();
  } catch (err) {
    // Closing right after start can throw (mb-1mk); the stats are flushed and the host still goes.
    console.error("[minebot] closing the body failed:", err);
  }
  // Runs the abort ended report their end, and everything sent so far is written, before the host goes.
  await reporter.drained();
  if (world) await sendWritten(currentState(world));
  process.exit(0);
}
