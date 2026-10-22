import { inspect } from "node:util";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type RunResult, type RunStatus } from "../protocol/index.ts";
import { hungCause, restartedError, STOP_GRACE_MS } from "../protocol/host.ts";
import { insideDir, locateFrame } from "./frames.ts";
import type { ProgramEventSource, ProgramScope } from "./scope.ts";

/** A run's result; `hung` marks a program that was aborted and had not settled when the grace ran out, so the host must be restarted. */
export type RunOutcome = RunResult & { hung?: true };

const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

/** The `console` methods that write output; a run's log takes what they are given (see `teeConsole`). */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

export class BusyError extends Error {
  constructor(message = "a program is already running; stop it or wait for it to finish") {
    super(message);
  }
}

export interface RunnerOptions {
  /** Emitter used by the run-scoped `on(event, handler)` helper. */
  events?: () => ProgramEventSource | undefined;
  /** Halts in-flight actions of the body when a program is aborted. */
  onAbort?: () => void;
  maxLogBytes?: number;
  /** How long an aborted program gets to settle before the run reports itself hung. Default: STOP_GRACE_MS. */
  graceMs?: number;
}

interface Running {
  controller: AbortController;
  startedAt: number;
}

/** Runs agent programs (a routine call, a module run, a reflex firing) one at a time. Not a security sandbox. */
export class ProgramRunner {
  readonly #options: RunnerOptions;
  #running: Running | null = null;

  constructor(options: RunnerOptions = {}) {
    this.#options = options;
  }

  get running(): { elapsedMs: number } | null {
    return this.#running && { elapsedMs: Date.now() - this.#running.startedAt };
  }

  /** Aborts the running program. Returns false when nothing is running. */
  stop(): boolean {
    if (!this.#running) return false;
    this.#running.controller.abort(new Error("stopped"));
    return true;
  }

  /**
   * Runs `fn` with this run's scope as one run: busy while another run is active, the timeout and stop, the
   * grace and `hung`, the log, the duration, the result as JSON. An aborted program gets `graceMs` to settle
   * (resolve or reject); one that does not ends the run with `hung`. `sourceDir` is the directory the
   * program's modules load from; an error reports the stack frames inside it, as file paths.
   * Timers and bot listeners a program creates itself are not cleared; only the scope's `sleep` and `on` are run-scoped.
   * While the runner is busy with the run (an aborted program's grace included), the `console` output methods also append
   * to its log, and still write where they wrote; the methods that were there are back when the runner is free.
   */
  async call(
    fn: (scope: ProgramScope) => Promise<unknown>,
    options: { timeoutMs?: number; sourceDir: string },
  ): Promise<RunOutcome> {
    if (this.#running) throw new BusyError();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const controller = new AbortController();

    const logs = new LogBuffer(this.#options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES);
    const timers = new Set<NodeJS.Timeout>();
    const listeners: [ProgramEventSource, string, (...args: unknown[]) => void][] = [];
    const { signal } = controller;

    const sleep = (ms: number): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      if (signal.aborted) {
        reject(signal.reason);
        return promise;
      }
      const onAbort = () => {
        clearTimeout(timer);
        timers.delete(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        timers.delete(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timers.add(timer);
      signal.addEventListener("abort", onAbort, { once: true });
      return promise;
    };

    const log = (...args: unknown[]) => logs.append(args);
    const on = (event: string, handler: (...args: unknown[]) => void) => {
      // A subscription after the run's abort (stop, timeout, or its end) would outlive the run: nothing clears it.
      if (signal.aborted) return;
      const emitter = this.#options.events?.();
      if (!emitter) throw new Error("on() is unavailable: the body has no event source");
      emitter.on(event, handler);
      listeners.push([emitter, event, handler]);
    };
    this.#running = { controller, startedAt };

    let status: RunStatus;
    let result: unknown;
    let error: string | undefined;
    let started: Promise<unknown> | undefined;
    /** The log as of the abort: a program that settles within its grace returns this, as one that stopped at once does. */
    let loggedAtAbort: string | undefined;
    const restoreConsole = teeConsole(log);
    const timeout = setTimeout(
      () => controller.abort(new Error("timeout")),
      Math.min(Math.max(timeoutMs, 0), MAX_TIMEOUT_MS),
    );
    try {
      try {
        started = fn({ log, sleep, signal, on });
        started.catch(() => {}); // late rejections after an abort are expected
        const aborted = Promise.withResolvers<never>();
        if (signal.aborted) aborted.reject(signal.reason);
        signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
        result = toWire(await Promise.race([started, aborted.promise]));
        status = "ok";
      } catch (err) {
        if (signal.aborted) {
          status = signal.reason instanceof Error && signal.reason.message === "timeout" ? "timeout" : "stopped";
          this.#options.onAbort?.();
          loggedAtAbort = logs.toString();
        } else {
          status = "error";
          error = formatRoutineError(err, options.sourceDir);
        }
      } finally {
        clearTimeout(timeout);
        if (!signal.aborted) controller.abort(new Error("finished"));
        for (const timer of timers) clearTimeout(timer);
        for (const [emitter, event, handler] of listeners) emitter.off(event, handler);
      }
      // With its timers and listeners gone, a program waiting on one never settles: it is hung.
      // The runner stays busy meanwhile, so no other program joins one that is still running.
      const graceMs = this.#options.graceMs ?? STOP_GRACE_MS;
      if (started && (status === "stopped" || status === "timeout") && !(await settledWithin(started, graceMs))) {
        return { status, result: undefined, error: restartedError(hungCause(graceMs)), logs: logs.toString(), durationMs: Date.now() - startedAt, hung: true };
      }
    } finally {
      restoreConsole();
      this.#running = null;
    }
    return { status, result, error, logs: loggedAtAbort ?? logs.toString(), durationMs: Date.now() - startedAt };
  }
}

/**
 * Makes each console output method also append its arguments to `log`, after writing them where the
 * method wrote them. Returns the function that puts the methods that were there back.
 */
function teeConsole(log: (...args: unknown[]) => void): () => void {
  const previous = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  for (const [method, write] of previous) {
    console[method] = (...args: unknown[]) => {
      write.apply(console, args);
      log(...args);
    };
  }
  return () => {
    for (const [method, write] of previous) console[method] = write;
  };
}

class LogBuffer {
  readonly #max: number;
  #bytes = 0;
  #lines: string[] = [];
  #truncated = false;

  constructor(max: number) {
    this.#max = max;
  }

  append(args: unknown[]): void {
    if (this.#truncated) return;
    const line = formatLogLine(args);
    const size = Buffer.byteLength(line) + 1;
    if (this.#bytes + size > this.#max) {
      this.#truncated = true;
      this.#lines.push(`[logs truncated at ${this.#max} bytes]`);
      return;
    }
    this.#bytes += size;
    this.#lines.push(line);
  }

  toString(): string {
    return this.#lines.join("\n");
  }
}

/** One log line from the arguments of one `log` call: strings as they are, other values as `util.inspect` shows them. */
export function formatLogLine(args: readonly unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 3, breakLength: 120 }))).join(" ");
}

function toWire(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return inspect(value, { depth: 2, breakLength: 120 });
  }
}

/** Whether the program's promise resolved or rejected within `ms`. */
async function settledWithin(program: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([program.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A routine's error: its message and the stack frames inside `sourceDir`, each naming `<file>:<line>:<column>`.
 * Frames name library modules by `file:` URL; what a URL adds to the file (a query, a fragment) names an
 * evaluation and not a file, so frames give the file's path. Never throws, whatever the routine threw.
 */
function formatRoutineError(err: unknown, sourceDir: string): string {
  try {
    if (typeof err !== "object" || err === null || !("stack" in err) || typeof err.stack !== "string") return String(err);
    const name = "name" in err && typeof err.name === "string" ? err.name : "Error";
    const message = "message" in err && typeof err.message === "string" ? err.message : "";
    // Modules load from the directory's real path, so its frames name that.
    const inside = insideDir(sourceDir);
    const located = (line: string): string | undefined => {
      const frame = locateFrame(line);
      return frame?.file.startsWith(inside) ? frame.text : undefined;
    };
    const [first = "", ...rest] = err.stack.split("\n");
    // A module that does not compile starts with a source excerpt ("<file>:N", the line, a caret) before a blank line.
    const excerptStart = located(first);
    const excerpt = excerptStart === undefined ? [] : [excerptStart, ...rest.slice(0, Math.max(rest.indexOf(""), 0))];
    const frames = rest.flatMap((line) => (line.trimStart().startsWith("at ") ? (located(line) ?? []) : []));
    return [...excerpt, `${name}: ${message}`, ...frames].join("\n");
  } catch {
    // The value has no string form (a null prototype) or one of its accessors threw: show it as inspect does.
    try {
      return inspect(err, { depth: 2, breakLength: 120 });
    } catch {
      return "a thrown value that cannot be shown";
    }
  }
}
