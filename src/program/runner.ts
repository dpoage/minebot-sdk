import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import vm from "node:vm";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type RunResult, type RunStatus } from "../protocol/index.ts";
import { hungCause, restartedError, STOP_GRACE_MS } from "../protocol/host.ts";
import type { ProgramEventSource, ProgramScope } from "./scope.ts";

/** A run's result; `hung` marks a program that was aborted and had not settled when the grace ran out, so the host must be restarted. */
export type RunOutcome = RunResult & { hung?: true };

/** What one entry hands the lifecycle: how to start the program, how to undo what starting it added, how to report its error. */
interface Program {
  start(): Promise<unknown>;
  cleanup(): void;
  formatError(err: unknown): string;
}

const PROGRAM_FILENAME = "program.js";
const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

export class BusyError extends Error {
  constructor(message = "a program is already running; stop it or wait for it to finish") {
    super(message);
  }
}

export interface RunnerOptions {
  /** Globals injected before each program; called per run so values such as a reconnected bot stay current. */
  globals: (scope: ProgramScope) => Record<string, unknown>;
  /** Emitter used by the program-scoped `on(event, handler)` helper. */
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

/** Runs agent programs one at a time in a persistent VM context. Not a security sandbox. */
export class ProgramRunner {
  readonly #options: RunnerOptions;
  readonly #context = vm.createContext({});
  #running: Running | null = null;

  constructor(options: RunnerOptions) {
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
   * `extraGlobals` are visible to this run only, on top of the injected globals; they are removed when it ends.
   * An aborted program gets `graceMs` to settle (resolve or reject); one that does not ends the run with `hung`.
   */
  async run(code: string, timeoutMs = DEFAULT_TIMEOUT_MS, extraGlobals: Record<string, unknown> = {}): Promise<RunOutcome> {
    return this.#execute(timeoutMs, (scope, timers) => {
      // Resolve globals before the runner is marked busy: if the body is unavailable this throws cleanly.
      const globals = this.#options.globals(scope);
      return {
        start: () => {
          Object.assign(this.#context, globals, extraGlobals, {
            log: scope.log,
            console: { log: scope.log, info: scope.log, warn: scope.log, error: scope.log, debug: scope.log },
            sleep: scope.sleep,
            signal: scope.signal,
            on: scope.on,
            setTimeout: (fn: () => void, ms?: number) => {
              const timer = setTimeout(() => {
                timers.delete(timer);
                fn();
              }, ms);
              timers.add(timer);
              return timer;
            },
            setInterval: (fn: () => void, ms?: number) => {
              const timer = setInterval(fn, ms);
              timers.add(timer);
              return timer;
            },
            clearTimeout: (timer: NodeJS.Timeout) => {
              clearTimeout(timer);
              timers.delete(timer);
            },
            clearInterval: (timer: NodeJS.Timeout) => {
              clearInterval(timer);
              timers.delete(timer);
            },
          });
          // lineOffset keeps reported line numbers aligned with the agent's source.
          const fn = vm.runInContext(`(async () => {\n${code}\n})`, this.#context, {
            filename: PROGRAM_FILENAME,
            lineOffset: -1,
          }) as () => Promise<unknown>;
          return fn();
        },
        cleanup: () => {
          for (const name of Object.keys(extraGlobals)) delete this.#context[name];
        },
        formatError,
      };
    });
  }

  /**
   * Runs `fn` with this run's scope, with the lifecycle of `run`: busy while another run is active, the
   * timeout and stop, the grace and `hung`, the log, the duration, the result as JSON. `sourceDir` is the
   * directory the routine's modules load from; an error reports the stack frames inside it, as file paths.
   * Timers and bot listeners a routine creates itself are not cleared; only the scope's `sleep` and `on` are run-scoped.
   */
  async call(
    fn: (scope: ProgramScope) => Promise<unknown>,
    options: { timeoutMs?: number; sourceDir: string },
  ): Promise<RunOutcome> {
    return this.#execute(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, (scope) => ({
      start: async () => fn(scope),
      cleanup: () => {},
      formatError: (err) => formatRoutineError(err, options.sourceDir),
    }));
  }

  async #execute(timeoutMs: number, prepare: (scope: ProgramScope, timers: Set<NodeJS.Timeout>) => Program): Promise<RunOutcome> {
    if (this.#running) throw new BusyError();
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
    const program = prepare({ log, sleep, signal, on }, timers);
    this.#running = { controller, startedAt };

    let status: RunStatus;
    let result: unknown;
    let error: string | undefined;
    let started: Promise<unknown> | undefined;
    /** The log as of the abort: a program that settles within its grace returns this, as one that stopped at once does. */
    let loggedAtAbort: string | undefined;
    const timeout = setTimeout(
      () => controller.abort(new Error("timeout")),
      Math.min(Math.max(timeoutMs, 0), MAX_TIMEOUT_MS),
    );
    try {
      try {
        started = program.start();
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
          error = program.formatError(err);
        }
      } finally {
        clearTimeout(timeout);
        if (!signal.aborted) controller.abort(new Error("finished"));
        for (const timer of timers) clearTimeout(timer);
        for (const [emitter, event, handler] of listeners) emitter.off(event, handler);
        program.cleanup();
      }
      // With its timers and listeners gone, a program waiting on one never settles: it is hung.
      // The runner stays busy meanwhile, so no other program joins one that is still running.
      const graceMs = this.#options.graceMs ?? STOP_GRACE_MS;
      if (started && (status === "stopped" || status === "timeout") && !(await settledWithin(started, graceMs))) {
        return { status, result: undefined, error: restartedError(hungCause(graceMs)), logs: logs.toString(), durationMs: Date.now() - startedAt, hung: true };
      }
    } finally {
      this.#running = null;
    }
    return { status, result, error, logs: loggedAtAbort ?? logs.toString(), durationMs: Date.now() - startedAt };
  }
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
 * Keeps the message and the stack frames inside the agent's program.
 * Errors thrown by programs come from the VM realm, so `instanceof Error` is false for them.
 */
function formatError(err: unknown): string {
  if (typeof err !== "object" || err === null || !("stack" in err) || typeof err.stack !== "string") {
    return String(err);
  }
  const name = "name" in err && typeof err.name === "string" ? err.name : "Error";
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const lines = err.stack.split("\n");
  // Compile errors start with a source excerpt ("program.js:N", the line, a caret) before a blank line.
  const excerptEnd = lines[0]?.startsWith(`${PROGRAM_FILENAME}:`) ? lines.indexOf("") : 0;
  const excerpt = lines.slice(0, Math.max(excerptEnd, 0));
  const frames = lines.filter((line) => line.trimStart().startsWith("at ") && line.includes(PROGRAM_FILENAME));
  return [...excerpt, `${name}: ${message}`, ...frames].join("\n");
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
    // Modules load from the directory's real path, so its frames name that (a directory gone since has none to resolve).
    let real = path.resolve(sourceDir);
    try {
      real = realpathSync(real);
    } catch {}
    const inside = path.join(real, path.sep);
    // A frame ends with `<url>:<line>:<column>`, maybe in parentheses; a compile error's excerpt starts with `<url>:<line>`.
    // A URL that names no file path (`%zz`, an encoded `/`) is not located: the stack text is the routine's to write.
    const located = (line: string): string | undefined => {
      const match = /file:\/\/\/\S*?(?=:\d+(?::\d+)?\)?$)/.exec(line);
      if (!match) return undefined;
      let file: string;
      try {
        file = fileURLToPath(match[0]);
      } catch {
        return undefined;
      }
      return file.startsWith(inside) ? line.slice(0, match.index) + file + line.slice(match.index + match[0].length) : undefined;
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
