// The bot host's entry: forked by the supervisor (src/body/host-process.ts) with its pid as the
// only argument. It builds the world the supervisor's init describes, answers the API requests the
// supervisor forwards, and exits on `shutdown`, when the channel closes, when its supervisor is gone,
// or on an uncaught error that no run's code is active to take, which it reports to the supervisor first.
import { inspect } from "node:util";
import { insideDir, locateFrame } from "../program/frames.ts";
import type { ContainOrigin } from "../program/runner.ts";
import { crashDetail, supervisorPidOf, type FromHost, type HostCrash, type ToHost } from "../protocol/host.ts";
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

/** How long a crashing host waits for its report to be written before it exits without. */
const CRASH_REPORT_MS = 1_000;
let crashing = false;
/** The world, once the init message has built it; a crash's frame is the one inside its routine library. */
let world: World | undefined;

// Not exiting on an uncaught error would resume a host whose state an error left half done. An error that reaches
// here while a run's code is active (or within a macrotask of its end) belongs to that run: the runner ends the
// run with it and halts the body before the next tick, and the host goes on. Any other error — no run, a run whose
// end was reported, a world not built yet — is reported to the supervisor, and the host exits and is replaced.
process.on("uncaughtException", (err) => handleUncaught(err, "exception"));
process.on("unhandledRejection", (reason) => handleUncaught(reason, "rejection"));

function handleUncaught(err: unknown, origin: ContainOrigin): void {
  // The exit is on its way: a second error is not given to a run that will not report.
  if (crashing) return;
  let contained = false;
  try {
    contained = world?.body.runner.contain(err, origin) ?? false;
  } catch {} // a failed containment is a crash
  if (!contained) {
    crash(err);
    return;
  }
  try {
    // Not through `console`: during a run it would add the error to the run's log a second time.
    process.stderr.write(`[minebot] contained in the active run (${origin}): ${crashDetail(describeCrash(err, world?.routinesDir))}\n`);
  } catch {}
}

const modules = Promise.all([import("./channel.ts"), import("./world.ts")]);

/** Sends a message to the supervisor; `written` is called once it is written, or when it could not be. */
function send(message: FromHost, written?: () => void): void {
  if (!written) {
    process.send!(message);
    return;
  }
  try {
    process.send!(message, () => written());
  } catch {
    written();
  }
}

/** Sends a message and resolves once it is written; one sent after it is written too. */
function sendWritten(message: FromHost): Promise<void> {
  const written = Promise.withResolvers<void>();
  send(message, written.resolve);
  return written.promise;
}

/** Sends what the host knows of its uncaught error in one message, and exits once that is written. */
function crash(err: unknown): void {
  // The exit is on its way: a second error is not reported over the first.
  if (crashing) return;
  crashing = true;
  try {
    console.error("[minebot] bot host crashed:", err);
  } catch {}
  // The channel may be gone or stuck: the report is bounded, and the host exits with 1 however it ends.
  setTimeout(() => process.exit(1), CRASH_REPORT_MS);
  send({ kind: "crashed", ...describeCrash(err, world?.routinesDir) }, () => process.exit(1));
}

/** An uncaught error's message, and its top frame: the first inside `library`, else the first. Never throws, whatever was thrown. */
function describeCrash(err: unknown, library: string | undefined): HostCrash {
  try {
    if (typeof err !== "object" || err === null || !("message" in err) || typeof err.message !== "string") return { message: String(err) };
    const name = "name" in err && typeof err.name === "string" ? err.name : "Error";
    const message = `${name}: ${err.message}`;
    const frame = "stack" in err && typeof err.stack === "string" ? topFrame(err.stack, library) : undefined;
    return frame === undefined ? { message } : { message, frame };
  } catch {
    try {
      return { message: inspect(err, { depth: 2, breakLength: 120 }) };
    } catch {
      return { message: "a thrown value that cannot be shown" };
    }
  }
}

/** A stack's first frame inside `library` as `path:line:column`, else its first frame; undefined when it has none. */
function topFrame(stack: string, library: string | undefined): string | undefined {
  const inside = library === undefined ? undefined : insideDir(library);
  let first: string | undefined;
  for (const line of stack.split("\n")) {
    if (!line.startsWith("    at ")) continue;
    const frame = locateFrame(line);
    const located = frame && `${frame.file}:${frame.position}`;
    first ??= located ?? line.trim().slice("at ".length);
    if (frame !== undefined && inside !== undefined && frame.file.startsWith(inside)) return located;
  }
  return first;
}

let handling = modules.then(() => {});
process.on("message", (message: ToHost) => {
  handling = handling.then(() => handle(message)).catch((err: unknown) => {
    console.error("[minebot] bot host message failed:", err);
  });
});

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

function currentState({ body }: World): FromHost {
  return { kind: "state", connected: body.connected, deaths: body.deaths, reconnects: body.reconnects };
}

async function handle(message: ToHost): Promise<void> {
  const [{ HostEvents, RunReporter }, { buildWorld }] = await modules;
  switch (message.kind) {
    case "init":
      events = new HostEvents((m) => {
        send(m);
        reportState();
      });
      reporter = new RunReporter({
        send,
        stop: () => world?.body.runner.stop() ?? false,
        running: () => Boolean(world?.body.runner.running),
      });
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
    // Closing right after start can throw; the stats are flushed and the host still goes.
    console.error("[minebot] closing the body failed:", err);
  }
  // Runs the abort ended report their end, and everything sent so far is written, before the host goes.
  await reporter.drained();
  if (world) await sendWritten(currentState(world));
  process.exit(0);
}
