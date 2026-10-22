// Triggers: programs the agent registers to run when an event arrives, so it can install
// reflexes (eat when hungry, fight when hurt) that fire while it is not looking. The body acts
// only because the agent registered the trigger; it decides nothing. Triggers persist in the
// state directory, run through the same runner as programs, and never crash the body.
// A definition's body is a program (`run`, a code trigger) or a saved routine (`routine`, a
// reflex). Both kinds share one scheduler, one limit, and the namespace; what is a code trigger and
// what is a reflex is decided here, so the program global and `/triggers*` see code triggers only.
import vm from "node:vm";
import { z } from "zod";
import { BusyError } from "../program/runner.ts";
import {
  MAX_TRIGGER_FAILURES,
  MAX_TRIGGERS,
  ReflexInput,
  TriggerInput,
  type AddTriggerResponse,
  type BodyEvent,
  type RunResult,
  type RunStatus,
  type ReflexBindingInfo,
  type TriggerInfo,
} from "../protocol/index.ts";
import type { JsonStore } from "../store.ts";
import { eventMatches } from "../protocol/event-filter.ts";
import { triggerFinished, type EventSink, type FinishedEnd, type LostFiring, type TriggerDisabled, type TriggerFinished } from "../protocol/host.ts";

/** A trigger's `when` is an expression over two names, so it is cut off quickly. */
const WHEN_TIMEOUT_MS = 100;

export class TriggerInvalidError extends Error {}
export class TriggerLimitError extends Error {}
const HOLDERS = { action: "an action binding", reflex: "a reflex", code: "a trigger" };

/** A name another kind holds: a trigger, a reflex, and an action binding share their names. */
export class NameConflictError extends Error {
  constructor(name: string, held: keyof typeof HOLDERS) {
    super(`"${name}" is ${HOLDERS[held]}; triggers, reflexes, and action bindings share their names, so remove it or pick another name`);
  }
}
export class TriggerNotFoundError extends Error {}

const StoredCode = TriggerInput.extend({
  updated: z.string(),
  disabledReason: z.string().optional(),
});
type StoredCode = z.output<typeof StoredCode>;
/** A reflex is stored as a trigger is, with `routine` where the trigger has `run`. */
const StoredReflex = ReflexInput.extend({
  updated: z.string(),
  disabledReason: z.string().optional(),
});
export type StoredReflex = z.output<typeof StoredReflex>;
type Stored = StoredCode | StoredReflex;
export type StoredTrigger = Stored;

/** Whether a stored definition is a reflex (its body is a routine) rather than a code trigger. */
export function isReflex(def: Stored): def is StoredReflex {
  return "routine" in def;
}

interface Stats {
  fired: number;
  lastFired?: string;
  lastStatus?: RunStatus;
  lastError?: string;
  failures: number;
}

interface Queued {
  /** Arrival order, for equal priorities. */
  id: number;
  name: string;
  event: BodyEvent;
  /** Set once this firing has asked the running program to stop. */
  preempts: boolean;
}

export interface TriggersDeps {
  store: JsonStore;
  events: EventSink;
  runner: { readonly running: unknown; stop(): boolean };
  connected: () => boolean;
  /** The bot a `when` expression sees. */
  bot: () => unknown;
  /** Whether this body can run reflexes (it has routines). Without, a stored reflex is skipped and reported, and never written. */
  reflexes: boolean;
  /**
   * Runs one firing through the body. Calls `started` right before the program starts, and throws
   * BusyError instead when a program is running.
   */
  run: (trigger: StoredTrigger, event: BodyEvent, started: () => void) => Promise<RunResult>;
  /**
   * Ends a firing: `end` is what its `run` returned or threw. Hands over its trigger_finished data,
   * the trigger_disabled it caused, and the triggers' failures with it counted, as one delivery of
   * that run; false when no run waits for that end. Absent or false, the end goes to `counts`.
   */
  deliver?: (end: unknown, finished: TriggerFinished, disabled: TriggerDisabled | undefined, failures: Record<string, number>) => boolean;
  /**
   * Reports the triggers' failures after every change no firing's delivery carries, the counts this
   * host starts with included; a firing that ended with no run behind it comes with them, as one report.
   * Absent, such a firing's events are pushed.
   */
  counts?: (failures: Record<string, number>, ended?: { finished?: TriggerFinished; disabled?: TriggerDisabled }) => void;
  /** Records the source a trigger or reflex being saved will run (its routine's name, for a reflex), so the audit covers it before it ever runs. */
  register: (trigger: StoredTrigger) => Promise<void>;
  /** Each trigger's run of failures that the host this one replaces had counted. */
  failures?: Record<string, number>;
  /** The firing the replaced host ended in, recorded here as if it had finished here. */
  lost?: LostFiring;
}

/** The agent's triggers: stored definitions, the matching of events to them, and the queue of firings. */
export class Triggers {
  readonly #deps: TriggersDeps;
  readonly #defs = new Map<string, Stored>();
  readonly #when = new Map<string, vm.Script>();
  readonly #stats = new Map<string, Stats>();
  /** When each trigger's latest firing started, for the cooldown. */
  readonly #lastFired = new Map<string, number>();
  readonly #predicates = vm.createContext({});
  readonly #unsubscribe: () => void;
  /** Whether a name is an action binding: none is until the bindings say so. */
  #isAction: (name: string) => boolean = () => false;
  #queue: Queued[] = [];
  /** The firing that runs now. Each firing has its own object, so a firing that ends late cannot clear a newer one. */
  #active: { priority: number } | null = null;
  #preempting = false;
  #seq = 0;
  #closed = false;

  constructor(deps: TriggersDeps) {
    this.#deps = deps;
    for (const name of deps.store.keys()) {
      // A bad entry on disk never stops the body: it is skipped, left in the file, and reported.
      const entry = { ...(deps.store.get(name) as object), name };
      try {
        const reflex = "routine" in entry;
        if (reflex && !deps.reflexes) throw new Error("a reflex needs routines, which this body does not offer");
        const parsed = (reflex ? StoredReflex : StoredCode).safeParse(entry);
        if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
        if (parsed.data.when) this.#when.set(name, compileWhen(parsed.data.when));
        if (!isReflex(parsed.data)) compileRun(parsed.data.run);
        this.#defs.set(name, parsed.data);
      } catch (err) {
        this.#when.delete(name);
        deps.events.push("trigger_error", { name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // A replacement host goes on counting where the one it replaces stopped, and counts the firing that ended it.
    for (const [name, failures] of Object.entries(deps.failures ?? {})) {
      if (this.#defs.has(name)) this.#statsOf(name).failures = failures;
    }
    // Only to the definition that fired: one replaced during the firing has no say, as in #record.
    const lostDef = deps.lost && this.#defs.get(deps.lost.name);
    const disabled = deps.lost && lostDef?.updated === deps.lost.updated ? this.#record(lostDef, deps.lost) : undefined;
    // One report holds the starting counts and the disable the lost firing caused: once the supervisor has them it stops passing the firing on.
    if (deps.counts) deps.counts(this.failures(), disabled && { disabled });
    else if (disabled) deps.events.push("trigger_disabled", disabled);
    this.#unsubscribe = deps.events.subscribe((event) => this.#onEvent(event));
  }

  /** Lets the triggers ask whether a name is an action binding, which they may not take: the bindings call this once. */
  shareNamesWith(isAction: (name: string) => boolean): void {
    this.#isAction = isAction;
  }

  /** The code triggers, by name; reflexes are listed by `reflexes()`. */
  list(): TriggerInfo[] {
    return [...this.#defs.values()]
      .filter((def): def is StoredCode => !isReflex(def))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((def) => this.#info(def));
  }

  /** The reflexes, by name. */
  reflexes(): ReflexBindingInfo[] {
    return [...this.#defs.values()]
      .filter(isReflex)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((def) => this.#reflexInfo(def));
  }

  /** The kind of definition that holds `name`, if one does. */
  holds(name: string): "code" | "reflex" | undefined {
    const def = this.#defs.get(name);
    return def === undefined ? undefined : isReflex(def) ? "reflex" : "code";
  }

  /** Each trigger's current run of failures, for the triggers that have one. */
  failures(): Record<string, number> {
    return Object.fromEntries([...this.#stats].filter(([name, stats]) => stats.failures > 0 && this.#defs.has(name)).map(([name, stats]) => [name, stats.failures]));
  }

  /** Validates and saves a code trigger; one of the same name is replaced. Nothing is stored when validation fails. */
  async add(input: unknown): Promise<AddTriggerResponse> {
    const parsed = TriggerInput.safeParse(input);
    if (!parsed.success) throw new TriggerInvalidError(z.prettifyError(parsed.error));
    const { data } = parsed;
    this.#admit(data.name, "code");
    const when = this.#compileWhenOf(data.when);
    try {
      compileRun(data.run);
    } catch (err) {
      throw new TriggerInvalidError(`run does not compile: ${err instanceof Error ? err.message : String(err)}`);
    }
    const def: StoredCode = { ...data, updated: new Date().toISOString() };
    const replaced = await this.#install(def, when);
    return { trigger: this.#info(def), replaced };
  }

  /** Validates and saves a reflex, a routine that fires like a trigger; one of the same name is replaced. Nothing is stored when validation fails. */
  async addReflex(input: unknown): Promise<{ reflex: ReflexBindingInfo; replaced: boolean }> {
    const parsed = ReflexInput.safeParse(input);
    if (!parsed.success) throw new TriggerInvalidError(z.prettifyError(parsed.error));
    const { data } = parsed;
    this.#admit(data.name, "reflex");
    const when = this.#compileWhenOf(data.when);
    const def: StoredReflex = { ...data, updated: new Date().toISOString() };
    const replaced = await this.#install(def, when);
    return { reflex: this.#reflexInfo(def), replaced };
  }

  /** Removes the code trigger `name`; false when there is none (a reflex is not one). */
  remove(name: string): boolean {
    return this.#drop(name, "code");
  }

  /** Removes the reflex `name`; false when there is none. */
  removeReflex(name: string): boolean {
    return this.#drop(name, "reflex");
  }

  #drop(name: string, kind: "code" | "reflex"): boolean {
    if (this.holds(name) !== kind) return false;
    this.#defs.delete(name);
    this.#when.delete(name);
    this.#stats.delete(name);
    this.#lastFired.delete(name);
    this.#dequeue(name);
    this.#deps.store.delete(name);
    this.#deps.counts?.(this.failures());
    return true;
  }

  /**
   * Checks that a definition of `kind` may take `name`: not an action's, not another kind's, and
   * within the limit unless it replaces one. True when it replaces one.
   */
  #admit(name: string, kind: "code" | "reflex"): boolean {
    if (this.#isAction(name)) throw new NameConflictError(name, "action");
    const held = this.holds(name);
    if (held !== undefined && held !== kind) throw new NameConflictError(name, held);
    if (held === undefined && this.#defs.size >= MAX_TRIGGERS) {
      throw new TriggerLimitError(`a body keeps at most ${MAX_TRIGGERS} triggers and reflexes together; remove some first`);
    }
    return held !== undefined;
  }

  #compileWhenOf(when: string | undefined): vm.Script | undefined {
    try {
      return when ? compileWhen(when) : undefined;
    } catch (err) {
      throw new TriggerInvalidError(`when does not compile: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Records and stores a definition, replacing the one of its name and starting its numbers over; true when it replaced one. */
  async #install(def: Stored, when: vm.Script | undefined): Promise<boolean> {
    await this.#deps.register(def);
    // The registration was awaited: another claim of the name may have been stored meanwhile.
    const replaced = this.#admit(def.name, isReflex(def) ? "reflex" : "code");
    this.#defs.set(def.name, def);
    if (when) this.#when.set(def.name, when);
    else this.#when.delete(def.name);
    this.#stats.delete(def.name);
    this.#lastFired.delete(def.name);
    this.#dequeue(def.name);
    this.#save(def);
    this.#deps.counts?.(this.failures());
    return replaced;
  }

  /** Enabling clears the reason a trigger was disabled and its run of failures. */
  setEnabled(name: string, enabled: boolean): TriggerInfo {
    const def = this.#defs.get(name);
    if (!def || isReflex(def)) throw new TriggerNotFoundError(`no trigger "${name}"`);
    def.enabled = enabled;
    delete def.disabledReason;
    if (enabled) this.#statsOf(name).failures = 0;
    else this.#dequeue(name);
    this.#save(def);
    this.#deps.counts?.(this.failures());
    return this.#info(def);
  }

  /** Called when the program runner may have become idle: starts the next waiting firing. */
  idle(): void {
    queueMicrotask(() => this.#pump());
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    this.#queue = [];
  }

  #info(def: StoredCode): TriggerInfo {
    const { name, on, from, match, when, run, cooldownMs, timeoutMs, enabled, preempt, priority, updated, disabledReason } = def;
    return {
      name,
      on,
      ...(from !== undefined && { from }),
      ...(match !== undefined && { match }),
      ...(when !== undefined && { when }),
      run,
      cooldownMs,
      timeoutMs,
      enabled,
      preempt,
      priority,
      updated,
      ...(disabledReason !== undefined && { disabledReason }),
      ...this.#numbersOf(name),
    };
  }

  #reflexInfo(def: StoredReflex): ReflexBindingInfo {
    const { name, routine, on, from, match, when, cooldownMs, timeoutMs, enabled, preempt, priority, updated, disabledReason } = def;
    return {
      kind: "reflex",
      name,
      routine,
      on,
      ...(from !== undefined && { from }),
      ...(match !== undefined && { match }),
      ...(when !== undefined && { when }),
      cooldownMs,
      timeoutMs,
      enabled,
      preempt,
      priority,
      updated,
      ...(disabledReason !== undefined && { disabledReason }),
      ...this.#numbersOf(name),
    };
  }

  /** What the body has counted for a definition since it started. */
  #numbersOf(name: string) {
    const stats = this.#statsOf(name);
    return {
      fired: stats.fired,
      ...(stats.lastFired !== undefined && { lastFired: stats.lastFired }),
      ...(stats.lastStatus !== undefined && { lastStatus: stats.lastStatus }),
      ...(stats.lastError !== undefined && { lastError: stats.lastError }),
      failures: stats.failures,
    };
  }

  #statsOf(name: string): Stats {
    let stats = this.#stats.get(name);
    if (!stats) {
      stats = { fired: 0, failures: 0 };
      this.#stats.set(name, stats);
    }
    return stats;
  }

  #save(def: Stored): void {
    this.#deps.store.set(def.name, def);
  }

  #dequeue(name: string): void {
    this.#queue = this.#queue.filter((entry) => entry.name !== name);
  }

  #onEvent(event: BodyEvent): void {
    // A trigger never fires on the events of triggers, so reflexes cannot feed each other.
    if (this.#closed || event.type.startsWith("trigger_")) return;
    const now = Date.now();
    for (const def of [...this.#defs.values()]) {
      if (!def.enabled || !def.on.includes(event.type)) continue;
      const filter = { from: def.from, match: def.match === undefined ? undefined : new RegExp(def.match, "i") };
      if (!eventMatches(event, filter)) continue;
      if (this.#queue.some((entry) => entry.name === def.name)) continue;
      // The cooldown runs between the starts of two firings, not from when an event was accepted:
      // a firing that waited behind a long program does not let the next one in right after it.
      const last = this.#lastFired.get(def.name);
      if (last !== undefined && now - last < def.cooldownMs) continue;
      const when = this.#when.get(def.name);
      if (when) {
        try {
          if (!this.#evaluate(when, event)) continue;
        } catch (err) {
          this.#finish(def, { status: "error", error: `when: ${messageOf(err)}`, durationMs: 0 });
          continue;
        }
      }
      this.#queue.push({ id: ++this.#seq, name: def.name, event, preempts: false });
    }
    this.idle();
  }

  /** Runs a `when` expression against a copy of the event; cut off when it takes too long. */
  #evaluate(script: vm.Script, event: BodyEvent): boolean {
    this.#predicates.event = JSON.parse(JSON.stringify(event));
    this.#predicates.bot = this.#deps.bot();
    try {
      return Boolean(script.runInContext(this.#predicates, { timeout: WHEN_TIMEOUT_MS }));
    } finally {
      this.#predicates.event = undefined;
      this.#predicates.bot = undefined;
    }
  }

  #mayPreempt(entry: Queued): boolean {
    const def = this.#defs.get(entry.name);
    return def !== undefined && def.preempt && (this.#active === null || this.#active.priority < def.priority);
  }

  #pump(): void {
    if (this.#closed || this.#queue.length === 0) return;
    if (this.#deps.runner.running) {
      // One stop is enough: the end of the running program calls idle(), which lands here again.
      if (this.#preempting) return;
      const entry = this.#queue.find((queued) => this.#mayPreempt(queued));
      if (!entry) return;
      entry.preempts = true;
      this.#preempting = this.#deps.runner.stop();
      return;
    }
    this.#preempting = false;
    const [next] = this.#queue.toSorted(
      (a, b) => Number(b.preempts) - Number(a.preempts) || (this.#defs.get(b.name)?.priority ?? 0) - (this.#defs.get(a.name)?.priority ?? 0) || a.id - b.id,
    );
    if (!next) return;
    this.#queue = this.#queue.filter((entry) => entry !== next);
    const def = this.#defs.get(next.name);
    if (!def?.enabled) return this.#pump();
    // Events of a body that is not connected have nothing to act on.
    if (!this.#deps.connected()) return this.#pump();
    void this.#execute(def, next);
  }

  async #execute(def: Stored, entry: Queued): Promise<void> {
    const startedAt = Date.now();
    const active = { priority: def.priority };
    this.#active = active;
    const announce = () => {
      // A trigger replaced or removed while its firing was starting keeps none of the numbers.
      if (this.#defs.get(def.name) === def) {
        const stats = this.#statsOf(def.name);
        stats.fired++;
        stats.lastFired = new Date().toISOString();
        this.#lastFired.set(def.name, Date.now());
      }
      this.#deps.events.push("trigger_fired", {
        name: def.name,
        event: { seq: entry.event.seq, type: entry.event.type },
        ...(entry.preempts && { preempted: true }),
      });
    };
    let outcome: FinishedEnd;
    // What the run returned or threw: the end the run's delivery is about.
    let end: unknown;
    try {
      const ran = await this.#deps.run(def, entry.event, announce);
      end = ran;
      outcome = { status: ran.status, durationMs: ran.durationMs, ...(ran.error !== undefined && { error: ran.error }), logs: ran.logs };
    } catch (err) {
      if (err instanceof BusyError) {
        // A program slipped in between the check and the start; the firing waits for the next idle.
        if (this.#active === active) this.#active = null;
        this.#preempting = false;
        if (this.#defs.get(def.name) === def) this.#queue.unshift(entry);
        this.#pump();
        return;
      }
      end = err;
      outcome = { status: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt };
    }
    if (this.#active === active) this.#active = null;
    // Whatever was stopped for a preempting firing has ended; a program that started since is a new one to stop.
    this.#preempting = false;
    this.#finish(def, outcome, end);
    this.#pump();
  }

  /**
   * Reports how a firing ended and records it. A run's own end (`end`, what it returned or threw) is
   * delivered as that run's; any other end is reported with the counts it leaves, in one report.
   */
  #finish(def: Stored, outcome: FinishedEnd, end?: unknown): void {
    const finished = triggerFinished(def.name, outcome);
    const disabled = this.#record(def, outcome);
    if (this.#deps.deliver?.(end, finished, disabled, this.failures())) return;
    if (this.#deps.counts) {
      this.#deps.counts(this.failures(), { finished, ...(disabled && { disabled }) });
      return;
    }
    this.#deps.events.push("trigger_finished", finished);
    if (disabled) this.#deps.events.push("trigger_disabled", disabled);
  }

  /**
   * Records how a firing ended in the trigger's numbers; a trigger that fails MAX_TRIGGER_FAILURES times in a row disables itself.
   * Returns the trigger_disabled event's data when it did, for the caller to push after the firing's end.
   */
  #record(def: Stored, outcome: { status: RunStatus; error?: string }): TriggerDisabled | undefined {
    // A removed or replaced trigger has no say in what the new one shows or stores.
    if (this.#defs.get(def.name) !== def) return undefined;
    const stats = this.#statsOf(def.name);
    stats.lastStatus = outcome.status;
    if (outcome.error !== undefined) stats.lastError = outcome.error;
    else delete stats.lastError;
    if (outcome.status === "ok") stats.failures = 0;
    else if (outcome.status === "error" || outcome.status === "timeout") stats.failures++;
    if (stats.failures < MAX_TRIGGER_FAILURES || !def.enabled) return undefined;
    def.enabled = false;
    def.disabledReason = `failed ${stats.failures} times in a row; last: ${(outcome.error ?? outcome.status).split("\n")[0]}`;
    this.#dequeue(def.name);
    this.#save(def);
    return { name: def.name, failures: stats.failures, reason: def.disabledReason };
  }
}

/** Compiles a `when` expression; throws with the syntax error when it does not parse. */
function compileWhen(when: string): vm.Script {
  return new vm.Script(`(${when}\n)`, { filename: "when.js" });
}

/** Compiles a trigger's program, the way the runner wraps programs, only to reject bad code early. */
function compileRun(code: string): vm.Script {
  return new vm.Script(`(async () => {\n${code}\n})`, { filename: "trigger.js" });
}

/** The message of a thrown value; errors from the expression's VM context are not instances of this realm's Error. */
function messageOf(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err ? String(err.message) : String(err);
}
