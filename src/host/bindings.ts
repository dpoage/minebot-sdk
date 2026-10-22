// Bindings: the names an agent has given to saved routines. An action binding is called by name
// (`POST /call`). Bindings persist in the state directory, so they survive body and host restarts.
// A binding names a routine and nothing else: binding never loads the module, so no agent code runs
// until something calls it.
import { z } from "zod";
import { BindingName, RoutineName, type BindInput, type BindingInfo, type BindResponse, type ActionBindingInfo } from "../protocol/index.ts";
import type { EventSink } from "../protocol/host.ts";
import type { JsonStore } from "../store.ts";
import type { Triggers } from "./triggers.ts";
import { RoutineNotFoundError } from "./routines/loader.ts";
import type { RoutineLibrary } from "./routines/library.ts";

/** A bind the registry refuses because the name is taken by something that is not an action binding. */
export class BindingConflictError extends Error {}

/** What the store keeps under a binding's name. */
const Stored = z.object({ kind: z.literal("action"), routine: RoutineName });

export interface BindingsDeps {
  store: JsonStore;
  library: Pick<RoutineLibrary, "source">;
  /** The body's code triggers, which share the namespace; null on a body without them. */
  triggers: Pick<Triggers, "list"> | null;
  events: EventSink;
}

export class Bindings {
  readonly #deps: BindingsDeps;
  readonly #actions = new Map<string, ActionBindingInfo>();

  constructor(deps: BindingsDeps) {
    this.#deps = deps;
    for (const name of deps.store.keys()) {
      // A bad entry on disk never stops the body: it is skipped, left in the file, and reported.
      const parsed = BindingName.safeParse(name);
      const stored = Stored.safeParse(deps.store.get(name));
      if (parsed.success && stored.success) this.#actions.set(name, { kind: "action", name, routine: stored.data.routine });
      else deps.events.push("binding_error", { name, error: z.prettifyError(parsed.success ? stored.error! : parsed.error) });
    }
  }

  /** Every binding, by name. */
  list(): BindingInfo[] {
    return [...this.#actions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The action bound to `name`, if one is. */
  action(name: string): ActionBindingInfo | undefined {
    return this.#actions.get(name);
  }

  /**
   * Binds `input.name` to the saved routine `input.routine`; a binding of the same name is replaced.
   * Refuses a name that is a code trigger (`BindingConflictError`) and a routine the library does not hold (`RoutineNotFoundError`).
   */
  bind(input: BindInput): BindResponse {
    const { name, routine } = input;
    if (this.#deps.triggers?.list().some((trigger) => trigger.name === name)) {
      throw new BindingConflictError(`"${name}" is a trigger; bindings and triggers share their names, so remove the trigger or pick another name`);
    }
    if (this.#deps.library.source(routine) === undefined) throw new RoutineNotFoundError(`no routine named "${routine}"`);
    const binding: ActionBindingInfo = { kind: "action", name, routine };
    this.#deps.store.set(name, { kind: binding.kind, routine });
    const replaced = this.#actions.has(name);
    this.#actions.set(name, binding);
    return { binding, replaced };
  }

  /** Removes the binding of `name`; false when there was none. */
  unbind(name: string): boolean {
    if (!this.#actions.delete(name)) return false;
    this.#deps.store.delete(name);
    return true;
  }
}
