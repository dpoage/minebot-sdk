// Detects when programs stop changing anything in the world, so the observation can say so on request.

export interface BodyState {
  /** Floored position, e.g. "-85,75,169". */
  position: string;
  /** Item counts by name. */
  inventory: Record<string, number>;
}

function signature(state: BodyState): string {
  const items = Object.entries(state.inventory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name}=${n}`)
    .join(",");
  return `${state.position}|${items}`;
}

/** Counts consecutive programs that end with the same position and inventory as the program before. */
export class StallTracker {
  #last: string | undefined;
  #streak = 0;

  /** The number of programs in a row without a change, after recording this one. */
  get streak(): number {
    return this.#streak;
  }

  record(state: BodyState): number {
    const sig = signature(state);
    this.#streak = sig === this.#last ? this.#streak + 1 : 0;
    this.#last = sig;
    return this.#streak;
  }
}
