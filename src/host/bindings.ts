// Bindings: the names an agent has given to saved routines. An action binding is called by name
// (`POST /call`); a reflex fires when events arrive. Actions persist in the state directory
// (bindings.json); a reflex lives in the reflexes' store (triggers.json) and shares its scheduler,
// limit, and names. Both survive body and host restarts. A binding names a routine and nothing
// else: binding never loads the module, so no agent code runs until something calls it or an event fires it.
import { z } from "zod";
import { BindingName, RoutineName, type BindInput, type BindingInfo, type BindResponse, type ActionBindingInfo } from "../protocol/index.ts";
import type { EventSink } from "../protocol/host.ts";
import type { JsonStore } from "../store.ts";
import { NameConflictError, type Triggers } from "./triggers.ts";
import { RoutineNotFoundError } from "./routines/loader.ts";
import type { RoutineLibrary } from "./routines/library.ts";

/** A bind this body cannot take: a reflex on a body without reflexes. */
export class BindingInvalidError extends Error {}

/** What the store keeps under a binding's name. */
const Stored = z.object({ kind: z.literal("action"), routine: RoutineName });

export interface BindingsDeps {
  store: JsonStore;
  library: Pick<RoutineLibrary, "source">;
  /** The body's reflexes, which hold the reflexes and the skipped stored entries and share the namespace; null on a body without them. */
  triggers: Pick<Triggers, "holds" | "reflexes" | "addReflex" | "removeReflex" | "removeSkipped" | "shareNamesWith"> | null;
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
      const held = deps.triggers?.holds(name);
      if (parsed.success && stored.success && held !== undefined) {
        // The reflexes' store is read first and a name is held once: the reflex or the skipped entry wins, the action's entry waits in the file.
        deps.events.push("binding_error", { name, error: `"${name}" is also ${held === "reflex" ? "a reflex" : "a stored entry the reflexes skipped"}, which takes the name; unbind it, then restart the body to use this action` });
      } else if (parsed.success && stored.success) this.#actions.set(name, { kind: "action", name, routine: stored.data.routine });
      else deps.events.push("binding_error", { name, error: z.prettifyError(parsed.success ? stored.error! : parsed.error) });
    }
    deps.triggers?.shareNamesWith((name) => this.#actions.has(name));
  }

  /** Every binding, by name. */
  list(): BindingInfo[] {
    return [...this.#actions.values(), ...(this.#deps.triggers?.reflexes() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The action bound to `name`, if one is. */
  action(name: string): ActionBindingInfo | undefined {
    return this.#actions.get(name);
  }

  /**
   * Binds `input.name` to the saved routine `input.routine`, as an action or a reflex; a binding of the same name and kind is replaced.
   * Refuses a name another kind holds, or a stored entry the reflexes skipped (`NameConflictError`), a reflex
   * on a body without reflexes (`BindingInvalidError`), and a routine the library does not hold (`RoutineNotFoundError`).
   */
  async bind(input: BindInput): Promise<BindResponse> {
    const { name, routine } = input;
    const { triggers } = this.#deps;
    if (input.kind === "reflex") {
      if (!triggers) throw new BindingInvalidError("this body does not offer reflexes: it was started without them");
      if (this.#deps.library.source(routine) === undefined) throw new RoutineNotFoundError(`no routine named "${routine}"`);
      const { reflex, replaced } = await triggers.addReflex(input);
      return { binding: reflex, replaced };
    }
    const held = triggers?.holds(name);
    if (held !== undefined) throw new NameConflictError(name, held);
    if (this.#deps.library.source(routine) === undefined) throw new RoutineNotFoundError(`no routine named "${routine}"`);
    const binding: ActionBindingInfo = { kind: "action", name, routine };
    this.#deps.store.set(name, { kind: binding.kind, routine });
    const replaced = this.#actions.has(name);
    this.#actions.set(name, binding);
    return { binding, replaced };
  }

  /** Removes the binding of `name`, an action or a reflex, or the stored entry of that name that the reflexes skipped at start; false when there was none. */
  unbind(name: string): boolean {
    if (this.#actions.delete(name)) {
      this.#deps.store.delete(name);
      return true;
    }
    const { triggers } = this.#deps;
    return (triggers?.removeReflex(name) || triggers?.removeSkipped(name)) ?? false;
  }
}
