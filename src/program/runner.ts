import { inspect } from "node:util";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type RunResult, type RunStatus } from "../protocol/index.ts";
import { hungCause, restartedError, STOP_GRACE_MS } from "../protocol/host.ts";
import { insideDir, locateFrame } from "./frames.ts";
import type { ProgramEventSource, ProgramScope, WatchOptions } from "./scope.ts";

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

/** Where an error that reached the process came from: a throw nothing caught, or a promise rejection nothing handled. */
export type ContainOrigin = "exception" | "rejection";

/** What a contained rejection's message ends with: the one thing an agent can do about it. */
export const NOT_AWAITED = " - this promise was not awaited; add await before the call";

export interface RunnerOptions {
  /** Emitter used by the run-scoped `on(event, handler)` helper. */
  events?: () => ProgramEventSource | undefined;
  /**
   * Stops what a run may have left in flight (the pathfinder's goal, held controls, digging, the item in use).
   * Called synchronously at every end of a run (ok, error, timeout, stopped, contained), before the run reports
   * its end, and by `contain` before the next tick.
   */
  halt?: () => void;
  /**
   * Called once for every run that ends with status "error", whether its program threw or an error was contained,
   * with the value that was thrown (for a contained error, the one the process handler received). A string it
   * returns is appended as the last line of the run's error; a throw from it is ignored.
   */
  explain?: (err: unknown) => string | undefined;
  maxLogBytes?: number;
  /** How long an aborted program gets to settle before the run reports itself hung. Default: STOP_GRACE_MS. */
  graceMs?: number;
}

interface Running {
  controller: AbortController;
  startedAt: number;
  /** Ends this run with `err`, or adds it to the run's error when the run has ended already; false when the body could not be halted. */
  contain(err: unknown, origin: ContainOrigin): boolean;
}

/** What ends a run's race when an error is contained while its code is active. */
class Contained {
  readonly err: unknown;
  readonly text: string;
  constructor(err: unknown, text: string) {
    this.err = err;
    this.text = text;
  }
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
   * Ends the run whose code is active as if its program threw `err`: status "error", the error's message and
   * frame. A run that has settled but not yet reported its end (the macrotask after its program settled, and a
   * stopped or timed-out program's grace) stays containable: `err` is then added to its error, as a line after
   * the error it already has, and a status "ok" becomes "error". The body is halted synchronously, before the
   * next tick. `origin` "rejection" is for a promise nothing handled: the message then says to add `await`.
   * Returns false when no run is containable (the caller must treat `err` as a crash).
   */
  contain(err: unknown, origin: ContainOrigin = "exception"): boolean {
    return this.#running?.contain(err, origin) ?? false;
  }

  /**
   * Runs `fn` with this run's scope as one run: busy while another run is active, the timeout and stop, the
   * grace and `hung`, the log, the duration, the result as JSON. An aborted program gets `graceMs` to settle
   * (resolve or reject); one that does not ends the run with `hung`. `sourceDir` is the directory the
   * program's modules load from; an error reports the stack frames inside it, as file paths.
   * Timers a program creates itself are not cleared, and neither are listeners it adds to an emitter other than the
   * body's bot: the scope's `sleep`, `on`, and `watch` are run-scoped, and `routineContext` routes the bot's listener
   * methods through `watch`, so a listener the run adds to `ctx.bot` is removed at every end of the run and a throw
   * from it ends the run rather than the packet dispatch that called it.
   * While the runner is busy with the run (an aborted program's grace included), the `console` output methods also append
   * to its log, and still write where they wrote; the methods that were there are back when the runner is free.
   * The body is halted (`halt`) at every end, and an error that reaches the process while the run is active or
   * within one macrotask of its program's end is the run's (see `contain`).
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
    /** Every listener the run registered through `on` or `watch`, with the emitter it went to: removed at every end. */
    const listeners: { emitter: ProgramEventSource; event: string; listener: (...args: unknown[]) => void }[] = [];
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
    // The errors that reached the process once the program's end was decided (or its abort was under way), in order:
    // they are added to the run's error, or are its error when it had none.
    const late: { err: unknown; text: string }[] = [];
    let decided = false;
    /** Whether `contain` already halted the body for the end that was decided. */
    let halted = false;
    const containedEnd = Promise.withResolvers<never>();
    containedEnd.promise.catch(() => {}); // only the race below listens, and only while the program is undecided
    const contain = (err: unknown, origin: ContainOrigin): boolean => {
      // Before the next tick: a bad goal the pathfinder throws on every tick is gone before the second throw.
      try {
        this.#options.halt?.();
      } catch {
        return false; // a body that cannot be halted is not one to go on with
      }
      const text = formatRoutineError(err, options.sourceDir, { suffix: origin === "rejection" ? NOT_AWAITED : "", nearestFrame: true });
      if (!decided && !signal.aborted) {
        decided = true;
        halted = true;
        containedEnd.reject(new Contained(err, text));
      } else {
        late.push({ err, text });
      }
      return true;
    };
    /** Registers a listener as the run's own: every end removes it, and a throw from it ends the run, not the dispatch that called it. */
    const watch: NonNullable<ProgramScope["watch"]> = (emitter, event, handler, options: WatchOptions = {}) => {
      // A subscription after the run's abort (stop, timeout, or its end) would outlive the run: nothing clears it.
      if (signal.aborted) return () => {};
      const selfRemoving = options.once === true;
      const listener = function (this: unknown, ...args: unknown[]) {
        if (selfRemoving) remove();
        try {
          handler.apply(this, args);
        } catch (err) {
          // The throw is the run's: it ends with that error, and the emitter goes on to its next listener.
          if (!contain(err, "exception")) throw err;
        }
      };
      const entry = { emitter, event, listener };
      const remove = () => {
        const at = listeners.indexOf(entry);
        if (at < 0) return;
        listeners.splice(at, 1);
        emitter.off(event, listener);
      };
      listeners.push(entry);
      if (options.prepend && emitter.prependListener) emitter.prependListener(event, listener);
      else emitter.on(event, listener);
      return remove;
    };
    const on = (event: string, handler: (...args: unknown[]) => void) => {
      // A subscription after the run's abort (stop, timeout, or its end) would outlive the run: nothing clears it.
      if (signal.aborted) return;
      const emitter = this.#options.events?.();
      if (!emitter) throw new Error("on() is unavailable: the body has no event source");
      watch(emitter, event, handler);
    };
    this.#running = { controller, startedAt, contain };

    let status: RunStatus;
    let result: unknown;
    let error: string | undefined;
    /** What the run's error came from: the value its program threw, or the first that was contained. */
    let thrown: unknown;
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
        // `watch` stays off the enumerated members: a run's context spreads the scope and must not show it.
        const scope = Object.defineProperty({ log, sleep, signal, on } as ProgramScope, "watch", { value: watch });
        started = fn(scope);
        started.catch(() => {}); // late rejections after an abort are expected
        const aborted = Promise.withResolvers<never>();
        if (signal.aborted) aborted.reject(signal.reason);
        signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
        result = toWire(await Promise.race([started, aborted.promise, containedEnd.promise]));
        decided = true;
        status = "ok";
      } catch (err) {
        decided = true;
        if (err instanceof Contained) {
          status = "error";
          error = err.text;
          thrown = err.err;
        } else if (signal.aborted) {
          status = signal.reason instanceof Error && signal.reason.message === "timeout" ? "timeout" : "stopped";
          loggedAtAbort = logs.toString();
        } else {
          status = "error";
          error = formatRoutineError(err, options.sourceDir);
          thrown = err;
        }
      } finally {
        clearTimeout(timeout);
        if (!signal.aborted) controller.abort(new Error("finished"));
        for (const timer of timers) clearTimeout(timer);
        for (const { emitter, event, listener } of listeners) emitter.off(event, listener);
      }
      // Whatever the end, nothing the program started keeps the body busy into the next run.
      if (!halted) this.#options.halt?.();
      // With its timers and listeners gone, a program waiting on one never settles: it is hung.
      // The runner stays busy meanwhile, so no other program joins one that is still running.
      const graceMs = this.#options.graceMs ?? STOP_GRACE_MS;
      if (started && (status === "stopped" || status === "timeout") && !(await settledWithin(started, graceMs))) {
        const hung = [restartedError(hungCause(graceMs)), ...late.map(({ text }) => text)].join("\n");
        return { status, result: undefined, error: hung, logs: logs.toString(), durationMs: Date.now() - startedAt, hung: true };
      }
      // A promise the program did not await that rejects as it ends is reported as unhandled once the microtasks it
      // ran in have drained: still within this macrotask. The run stays containable until the next one.
      await nextMacrotask();
      if (late.length > 0) {
        if (status === "ok") {
          status = "error";
          result = undefined;
          thrown = late[0]!.err;
          error = late.map(({ text }) => text).join("\n");
        } else {
          error = [error, ...late.map(({ text }) => text)].filter((text) => text !== undefined).join("\n");
        }
      }
      if (status === "error") {
        try {
          const explained = this.#options.explain?.(thrown);
          if (explained) error = error === undefined ? explained : `${error}\n${explained}`;
        } catch {} // an explanation that fails is no reason to lose the error it was for
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
 * `suffix` ends the message. `nearestFrame` names the stack's first frame when none is inside `sourceDir`, as
 * the host's crash report does: an error that comes from a listener or a timer, not from the program's own call.
 */
function formatRoutineError(err: unknown, sourceDir: string, { suffix = "", nearestFrame = false } = {}): string {
  try {
    if (typeof err !== "object" || err === null || !("stack" in err) || typeof err.stack !== "string") return `${String(err)}${suffix}`;
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
    const stackLines = rest.filter((line) => line.trimStart().startsWith("at "));
    let frames = stackLines.flatMap((line) => located(line) ?? []);
    if (nearestFrame && frames.length === 0 && stackLines[0] !== undefined) frames = [locateFrame(stackLines[0])?.text ?? stackLines[0]];
    return [...excerpt, `${name}: ${message}${suffix}`, ...frames].join("\n");
  } catch {
    // The value has no string form (a null prototype) or one of its accessors threw: show it as inspect does.
    try {
      return `${inspect(err, { depth: 2, breakLength: 120 })}${suffix}`;
    } catch {
      return `a thrown value that cannot be shown${suffix}`;
    }
  }
}
