/** The line the run's check writes into its logs when it cannot answer: typescript absent, over budget, or a failure. */
const CHECK_SKIP = /^type check skipped: [^\n]*(?:\n|$)/gm;

/**
 * `logs` without the `type check skipped: <reason>` line of a check that could not answer (see
 * `RoutineLoader.run`). A run's own logs compare the same whether the check answered or was skipped: under
 * full-suite load the check can run out of its budget, and the run goes on with that one line in its logs.
 */
export function withoutCheckSkip(logs: string): string {
  return logs.replace(CHECK_SKIP, "");
}
