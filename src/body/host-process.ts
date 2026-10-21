// The supervisor's side of the bot host: forks the child process that holds the Minecraft player
// and runs agent programs, forwards API requests to it, and turns what it reports into the event
// log and the program history. Callers do not know the body lives in another process.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostArguments, type FromHost, type HostInit, type ToHost } from "../protocol/host.ts";
import type { EventLog } from "./events.ts";
import type { ForwardedRequest } from "./http.ts";
import type { ProgramHistory, RunEnd } from "./history.ts";

/** How long the host gets to run its shutdown before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;

/** The host's entry, with this module's own extension: `.ts` from source, `.js` from a build. */
const DEFAULT_ENTRY = fileURLToPath(new URL(`../host/main${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url));

interface RunInFlight {
  end: RunEnd;
  finished: PromiseWithResolvers<void>;
}

export class HostProcess {
  readonly #init: HostInit;
  readonly #events: EventLog;
  readonly #history: ProgramHistory;
  readonly #entry: string;
  readonly #unsubscribe: () => void;
  readonly #ready = Promise.withResolvers<void>();
  readonly #requests = new Map<number, PromiseWithResolvers<{ status: number; body: unknown }>>();
  readonly #runs = new Map<number, RunInFlight>();
  #child: ChildProcess | undefined;
  #exited: Promise<void> | undefined;
  #nextRequest = 0;
  #connected = false;
  #built = false;
  /** Set when the supervisor ends the host on purpose, so its exit is not a failure. */
  #ending = false;
  /** The host's messages are handled one at a time, in order: a history line is on disk before the response that follows it is relayed. */
  #handling = Promise.resolve();

  constructor(o: { init: HostInit; events: EventLog; history: ProgramHistory; entry?: string /* tests only */ }) {
    this.#init = o.init;
    this.#events = o.events;
    this.#history = o.history;
    this.#entry = o.entry ?? DEFAULT_ENTRY;
    // The host's own copy of the log: its triggers hear events with the seq the log gave them.
    this.#unsubscribe = o.events.subscribe((event) => {
      if (this.#child?.connected) this.#send({ kind: "event", event });
    });
  }

  /** Whether the host's player is in the world. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Forks the host and resolves once it has built its world; rejects with the reason it could not. */
  start(): Promise<void> {
    // The host watches this pid: it exits when its supervisor is gone, even with its main thread blocked.
    const child = fork(this.#entry, hostArguments(process.pid));
    this.#child = child;
    this.#exited = new Promise((resolve) => child.once("exit", () => resolve()));
    child.on("message", (message: FromHost) => {
      this.#handling = this.#handling.then(() => this.#handle(message)).catch((err: unknown) => console.error("[minebot] bot host message failed:", err));
    });
    child.once("exit", (code, signal) => this.#onExit(code, signal));
    child.once("error", (err) => this.#ready.reject(err));
    this.#send({ kind: "init", init: this.#init });
    return this.#ready.promise;
  }

  /** Tells the host to join the server. */
  join(): void {
    this.#send({ kind: "start" });
  }

  /** Relays one API request the supervisor does not answer itself. */
  forward(r: ForwardedRequest): Promise<{ status: number; body: unknown }> {
    const id = ++this.#nextRequest;
    const answer = Promise.withResolvers<{ status: number; body: unknown }>();
    this.#requests.set(id, answer);
    try {
      this.#send({ kind: "request", id, method: r.method, url: r.url, body: r.body?.toString("utf8") ?? null, tooLarge: r.tooLarge });
    } catch (err) {
      this.#requests.delete(id);
      throw err;
    }
    return answer.promise;
  }

  /** Aborts the running program, if there is one, and resolves once it has ended. */
  async stop(): Promise<{ stopped: boolean }> {
    if (this.#runs.size === 0) return { stopped: false };
    const ending = [...this.#runs.values()].map((run) => run.finished.promise);
    this.#send({ kind: "stop" });
    await Promise.all(ending);
    return { stopped: true };
  }

  /** Has the host close the body and exit; kills it when it does not within the grace period. */
  async close(): Promise<void> {
    this.#unsubscribe();
    this.#ending = true;
    await this.#terminate();
    this.#failRequests(new Error("the body is shutting down"));
  }

  async #terminate(): Promise<void> {
    const child = this.#child;
    if (!child || !this.#exited) return;
    this.#ending = true;
    if (child.connected) this.#send({ kind: "shutdown" });
    const killer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
    await this.#exited;
    clearTimeout(killer);
  }

  #send(message: ToHost): void {
    if (!this.#child?.connected) throw new Error("the bot host is not running");
    this.#child.send(message);
  }

  async #handle(message: FromHost): Promise<void> {
    switch (message.kind) {
      case "ready":
        this.#built = true;
        this.#ready.resolve();
        return;
      case "failed":
        // The host exits on its own after reporting; wait for it so nothing outlives the failed start.
        await this.#terminate();
        this.#ready.reject(new Error(message.message));
        return;
      case "response":
        this.#requests.get(message.id)?.resolve({ status: message.status, body: message.body });
        this.#requests.delete(message.id);
        return;
      case "event":
        this.#events.push(message.type, message.data);
        return;
      case "state":
        this.#connected = message.connected;
        return;
      case "run_started":
        try {
          const end = await this.#history.begin(message.code, message.kits, message.extra);
          this.#runs.set(message.runId, { end, finished: Promise.withResolvers<void>() });
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId });
        } catch (err) {
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        return;
      case "run_finished": {
        const run = this.#runs.get(message.runId);
        try {
          if (run && message.result) await run.end(message.result);
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId });
        } catch (err) {
          // The run fails as it did when the history was written in-process.
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        this.#runs.delete(message.runId);
        run?.finished.resolve();
        return;
      }
      case "register":
        try {
          await this.#history.register(message.code, message.kits, message.extra);
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId });
        } catch (err) {
          this.#sendIfOpen({ kind: "run_ack", runId: message.runId, error: errorText(err) });
        }
        return;
    }
  }

  #sendIfOpen(message: ToHost): void {
    if (this.#child?.connected) this.#send(message);
  }

  #failRequests(err: Error): void {
    for (const request of this.#requests.values()) request.reject(err);
    this.#requests.clear();
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (this.#ending) return;
    if (!this.#built) {
      // startDaemon rejects with this; the supervisor has nothing running to stop.
      this.#ready.reject(new Error(`the bot host exited before it was ready (${how})`));
      return;
    }
    this.#failRequests(new Error(`the bot host exited (${how})`));
    exitWithHost(how);
  }
}

/** What the supervisor does when the host dies on its own: stop. A later round replaces this with restarting the host. */
function exitWithHost(how: string): never {
  console.error(`[minebot] the bot host exited unexpectedly (${how}); stopping`);
  process.exit(1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
