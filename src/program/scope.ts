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
}

/** The subset of an event emitter the runner needs; satisfied by node's EventEmitter and mineflayer's Bot. */
export interface ProgramEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}
