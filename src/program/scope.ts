// The environment one run sees: its log, sleep, signal, and event subscription. The runner builds it
// and `routineContext` spreads it into the context of a routine call, a module run, or a reflex firing.
export interface ProgramScope {
  log: (...args: unknown[]) => void;
  /** Resolves after `ms`; rejects when the run is aborted. */
  sleep: (ms: number) => Promise<void>;
  /** Fires on timeout or stop. */
  signal: AbortSignal;
  /** Subscribes to an event source event until the run ends. */
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  /**
   * Registers `handler` on `emitter` as the run's own: it hears events until the run ends, and a throw from it ends
   * the run with that error. `options.once` removes it after its first call; `options.prepend` puts it before the
   * emitter's other listeners. Returns the function that removes it before the run ends.
   * The runner defines this on its scope without enumerating it, so a run's context does not show it; a scope
   * without it (a hand-built one, such as a test's) has no registration to scope.
   */
  watch?: (
    emitter: ProgramEventSource,
    event: string,
    handler: (...args: unknown[]) => void,
    options?: WatchOptions,
  ) => () => void;
}

/** How `ProgramScope.watch` registers a listener. */
export interface WatchOptions {
  once?: boolean;
  prepend?: boolean;
}

/** The subset of an event emitter the runner needs; satisfied by node's EventEmitter and mineflayer's Bot. */
export interface ProgramEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Registers before the emitter's other listeners; an emitter without it registers at the end. */
  prependListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}
