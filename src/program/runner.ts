import { inspect } from "node:util";
import vm from "node:vm";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type RunResult, type RunStatus } from "../protocol/index.ts";
import { hungCause, restartedError, STOP_GRACE_MS } from "../protocol/host.ts";
import type { ProgramEventSource, ProgramScope } from "./scope.ts";

/** A run's result; `hung` marks a program that was aborted and had not settled when the grace ran out, so the host must be restarted. */
export type RunOutcome = RunResult & { hung?: true };

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
      const emitter = this.#options.events?.();
      if (!emitter) throw new Error("on() is unavailable: the body has no event source");
      emitter.on(event, handler);
      listeners.push([emitter, event, handler]);
    };
    // Resolve globals before marking the runner busy: if the body is unavailable this throws cleanly.
    const globals = this.#options.globals({ log, sleep, signal, on });
    this.#running = { controller, startedAt };
    Object.assign(this.#context, globals, extraGlobals, {
      log,
      console: { log, info: log, warn: log, error: log, debug: log },
      sleep,
      signal,
      on,
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

    let status: RunStatus;
    let result: unknown;
    let error: string | undefined;
    let program: Promise<unknown> | undefined;
    const timeout = setTimeout(
      () => controller.abort(new Error("timeout")),
      Math.min(Math.max(timeoutMs, 0), MAX_TIMEOUT_MS),
    );
    try {
      try {
        // lineOffset keeps reported line numbers aligned with the agent's source.
        const fn = vm.runInContext(`(async () => {\n${code}\n})`, this.#context, {
          filename: PROGRAM_FILENAME,
          lineOffset: -1,
        }) as () => Promise<unknown>;
        program = fn();
        program.catch(() => {}); // late rejections after an abort are expected
        const aborted = Promise.withResolvers<never>();
        if (signal.aborted) aborted.reject(signal.reason);
        signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
        result = toWire(await Promise.race([program, aborted.promise]));
        status = "ok";
      } catch (err) {
        if (signal.aborted) {
          status = signal.reason instanceof Error && signal.reason.message === "timeout" ? "timeout" : "stopped";
          this.#options.onAbort?.();
        } else {
          status = "error";
          error = formatError(err);
        }
      } finally {
        clearTimeout(timeout);
        if (!signal.aborted) controller.abort(new Error("finished"));
        for (const timer of timers) clearTimeout(timer);
        for (const [emitter, event, handler] of listeners) emitter.off(event, handler);
        for (const name of Object.keys(extraGlobals)) delete this.#context[name];
      }
      // The timers and listeners are gone, so a program waiting on one never settles: it is hung.
      // The runner stays busy meanwhile, so a program that is still running is never joined by another.
      const graceMs = this.#options.graceMs ?? STOP_GRACE_MS;
      if (program && (status === "stopped" || status === "timeout") && !(await settledWithin(program, graceMs))) {
        return { status, result: undefined, error: restartedError(hungCause(graceMs)), logs: logs.toString(), durationMs: Date.now() - startedAt, hung: true };
      }
    } finally {
      this.#running = null;
    }
    return { status, result, error, logs: logs.toString(), durationMs: Date.now() - startedAt };
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
    const line = args
      .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 3, breakLength: 120 })))
      .join(" ");
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
