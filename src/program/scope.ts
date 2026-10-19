// The environment a running program or kit action sees. Shared by the runner and the kit
// framework, so nested kit actions receive the calling program's scope unchanged.
export interface ProgramScope {
  log: (...args: unknown[]) => void;
  /** Resolves after `ms`; rejects when the program is aborted. */
  sleep: (ms: number) => Promise<void>;
  /** Fires on timeout or stop. */
  signal: AbortSignal;
  /** Subscribes to an event source event until the program ends. */
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

/** The subset of an event emitter the runner needs; satisfied by node's EventEmitter and mineflayer's Bot. */
export interface ProgramEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}
