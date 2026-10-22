// One Minecraft player: a Mineflayer connection that reconnects, an event log, a program runner,
// kits, the wiki, and persistent notes and milestones. The composition root (the daemon) injects
// the kit catalog and the wiki; Body wires them into the program environment.
import { grade, MilestoneSet, type MilestoneProgress } from "../milestones/milestones.ts";
import { capabilities, type BodyEvent, type BodyFeatures, type Observation, type RunResult, type StatusResponse, type WikiMode } from "../protocol/index.ts";
import { BusyError, ProgramRunner, type RunOutcome } from "../program/runner.ts";
import type { KitHost } from "../kit/kit.ts";
import type { Wiki } from "../wiki/wiki.ts";
import { WikiAccess, wikiView } from "../wiki/access.ts";
import { Connection, type ServerAuth } from "./connection.ts";
import { programFinished, type EventSink, type FiringOf, type LostFiring, type TriggerDisabled, type TriggerFinished } from "../protocol/host.ts";
import { invokeRoutine } from "../routine/invoke.ts";
import type { RoutineContext } from "../routine/public.ts";
import { programGlobals, routineContext, type GlobalsDeps } from "./globals.ts";
import type { Builtins } from "./routines/builtins.ts";
import type { RoutineLoader } from "./routines/loader.ts";
import { briefOf, observation } from "./observation.ts";
import { Notes } from "../notes.ts";
import { StallTracker } from "./progress.ts";
import { requestStats } from "./stats.ts";
import { BodyState } from "./state.ts";
import { Triggers, type StoredReflex } from "./triggers.ts";
import { preemptingRunner } from "./channel.ts";

export interface BodyOptions {
  username: string;
  auth: ServerAuth;
  /** Where Microsoft sign-in tokens are cached. */
  authCacheDir: string;
  host: string;
  port: number;
  /** Owner of the state directory: notes, per-kit stores, milestones, agent kits. */
  state: BodyState;
  /** The kit catalog and active set, built by the composition root. */
  kits: KitHost;
  /** The built-in routine modules the body offers, and the counter of calls into them. */
  builtins: Builtins;
  /** Curated wiki pages; null for none. */
  wiki: Wiki | null;
  /** What the agent may do with the wiki. */
  wikiMode: WikiMode;
  /** Let the agent read, set, and grade milestones. Default: true. A body without them neither mentions nor serves them. */
  milestonesEnabled?: boolean;
  /** Whether agents may save and remove their own kits. */
  agentKits: boolean;
  /** Re-reads the agent-kit directory before each program run, so kits other bodies save appear. */
  syncKits?: () => void;
  /** Authoring hooks for the program globals; wired to the kit library by the daemon. */
  kitAuthoring?: GlobalsDeps["kitAuthoring"];
  /** Let the agent bind reflexes. Default: true. A body without them neither mentions nor serves them. */
  triggersEnabled?: boolean;
  /** Loads the routines a call runs; undefined for a body without routines. */
  routines?: RoutineLoader;
  /** Where the body's events go; the supervisor's log numbers them and echoes them back. */
  events: EventSink;
  /** Where reflex runs and registrations are reported, as calls are. */
  recorder: RunRecorder;
  /** When the supervisor started; /status reports it. */
  startedAt: string;
  /** Deaths and reconnects the previous host counted, when this host replaces one. */
  deaths?: number;
  reconnects?: number;
  /** Each reflex's run of failures, and the firing the replaced host ended in, when this host replaces one. */
  triggerFailures?: Record<string, number>;
  lostFiring?: LostFiring;
}

/** Reports program runs and registrations to whoever keeps the history; user code starts only once `record` has been answered. */
export interface RunRecorder {
  /**
   * Records the start of `execute`, runs it once the history has it, and records its end. A run that
   * throws leaves no end; a start or end the history cannot write fails the run. `requestId` is the
   * API request the run answers and `trigger` the definition it fires, so the supervisor can end the run if this host is killed.
   */
  record(run: { code: string; timeoutMs?: number; extra?: object; requestId?: number; trigger?: FiringOf }, execute: () => Promise<RunOutcome>): Promise<RunResult>;
  /**
   * Ends a reflex's run: `end` is what `record` returned or threw for it. The reflex_finished, the
   * reflex_disabled it caused, and the failures with the firing counted go to the supervisor as
   * that run's delivery. Returns false, sending nothing, for an end with no recorded run (its start
   * was refused, or it never ran): the caller hands it to `counts`.
   */
  deliver(end: unknown, finished: TriggerFinished, disabled: TriggerDisabled | undefined, triggerFailures: Record<string, number>): boolean;
  /**
   * Hands over the reflexes' failures after a change no run's delivery carries; the reflex_finished
   * of a firing that ended with no recorded run, and a reflex_disabled, go in the same message.
   */
  counts(triggerFailures: Record<string, number>, ended?: { finished?: TriggerFinished; disabled?: TriggerDisabled }): void;
  /**
   * Asks the recorded run whose code executes to stop, for a preempting firing that waits on it: true
   * when one does at this moment, and the abort is then on its way (after the history's holder has been told, and only if that run still executes).
   * False when no recorded run executes, a run acked but not started included; nothing is aborted.
   */
  preempt(): boolean;
  /** Records code the body will run later. */
  register(code: string, extra: object): Promise<void>;
}

/**
 * One Minecraft player: a Mineflayer connection that reconnects, an event log, a program runner,
 * kits, the wiki, and persistent notes and milestones.
 */
export class Body {
  readonly events: EventSink;
  readonly runner: ProgramRunner;
  readonly kits: KitHost;
  readonly wiki: WikiAccess;
  readonly notes: Notes;
  /** The agent's reflexes; null on a body that has them turned off. */
  readonly triggers: Triggers | null;
  readonly state: BodyState;
  readonly #options: BodyOptions;
  readonly #connection: Connection;
  readonly #stall = new StallTracker();

  constructor(options: BodyOptions) {
    this.#options = options;
    this.events = options.events;
    this.state = options.state;
    this.kits = options.kits;
    this.notes = options.state.notes;
    this.#connection = new Connection({
      username: options.username,
      auth: options.auth,
      authCacheDir: options.authCacheDir,
      host: options.host,
      port: options.port,
      events: this.events,
      deaths: options.deaths,
      reconnects: options.reconnects,
    });
    this.wiki = new WikiAccess(options.wiki, options.wikiMode, options.username, () => wikiView(this.features));
    this.runner = new ProgramRunner({
      // Only the features the body offers become globals, so a program cannot find the others.
      globals: (scope) => programGlobals(scope, this.#environment()),
      events: () => this.#connection.bot ?? undefined,
      onAbort: () => this.#connection.halt(),
    });
    this.triggers =
      options.triggersEnabled === false
        ? null
        : new Triggers({
            store: options.state.triggers,
            events: this.events,
            runner: preemptingRunner(this.runner, options.recorder),
            connected: () => this.#connection.spawned,
            bot: () => this.#connection.bot ?? undefined,
            reflexes: options.routines !== undefined,
            run: (reflex, event, started) => this.#runTrigger(reflex, event, started),
            deliver: (end, finished, disabled, failures) => options.recorder.deliver(end, finished, disabled, failures),
            counts: (failures, ended) => options.recorder.counts(failures, ended),
            register: (reflex) => this.#register(reflex),
            failures: options.triggerFailures,
            lost: options.lostFiring,
          });
  }

  /** What programs and routines are built from: the body's facilities, with the optional ones only where the body offers them. */
  #environment(): GlobalsDeps {
    return {
      connection: this.#connection,
      kits: this.kits,
      wiki: this.wiki,
      notes: this.notes,
      store: (namespace) => this.#options.state.routineStore(namespace),
      observe: this.#options.builtins.observe,
      features: () => this.features,
      status: () => this.status(),
      ...(capabilities(this.features).agentKits && this.#options.kitAuthoring && { kitAuthoring: this.#options.kitAuthoring }),
    };
  }

  /** The optional parts of this body. Everything an agent can see derives from this. */
  get features(): BodyFeatures {
    return {
      kits: this.kits.active,
      kitsLocked: this.kits.locked,
      agentKits: this.#options.agentKits,
      wiki: this.wiki.mode,
      lessons: this.wiki.lessons,
      milestones: this.#options.milestonesEnabled ?? true,
      reflexes: this.triggers !== null,
      routines: this.#options.routines !== undefined,
      builtins: [...this.#options.builtins.offered],
    };
  }

  /**
   * Runs a program and records its end in the event log. The result is exactly what the program
   * produced: facts such as an unchanged world stay in the observation, read on request.
   * A hung run comes back flagged: its host is about to be killed, and the supervisor logs its end.
   */
  async run(code: string, timeoutMs?: number): Promise<RunOutcome> {
    this.#options.syncKits?.();
    return this.#ended(await this.runner.run(code, timeoutMs));
  }

  /**
   * Calls routine `routine` with `args` (as given: absent stays absent) as one run, with the duties of `run`: the routine's module is
   * loaded and its default export called inside the run, so what its top level does is bounded by the
   * run's timeout, stop, and kill deadline. `result` is the routine's awaited return as JSON.
   * Throws when the body is not connected, and `BusyError` while another run is active.
   */
  async call(routine: string, args: unknown, timeoutMs?: number): Promise<RunOutcome> {
    const loader = this.#options.routines;
    if (!loader) throw new Error("this body has no routines");
    return this.#called(async (ctx) => invokeRoutine(await loader.load(routine), routine, ctx, args), loader.dir, timeoutMs);
  }

  /**
   * Calls the built-in routine `name` (`<module>.<routine>`) as `call` calls a library routine: one run with the same duties,
   * the arguments as given, the result the routine's validated return as JSON. Throws when the body does not offer that routine.
   */
  async callBuiltin(name: string, args: unknown, timeoutMs?: number): Promise<RunOutcome> {
    const { builtins } = this.#options;
    const routine = builtins.routine(name);
    if (!routine) throw new Error(`no built-in routine "${name}"`);
    return this.#called(async (ctx) => invokeRoutine({ default: routine }, name, ctx, args), builtins.dir, timeoutMs);
  }

  /** One call as a run: `invoke` runs inside it with the context of the run, and an error reports the frames inside `sourceDir`. */
  async #called(invoke: (ctx: RoutineContext) => Promise<unknown>, sourceDir: string, timeoutMs?: number): Promise<RunOutcome> {
    this.#options.syncKits?.();
    const environment = this.#environment();
    // Not connected answers as a program does, not as a run that failed.
    this.#connection.requireBot();
    const result = await this.runner.call(async (scope) => invoke(routineContext(scope, environment)), { timeoutMs, sourceDir });
    return this.#ended(result);
  }

  /** What a program's or a call's end does for the body: the event, the reflexes waiting for an idle runner, the stall record. */
  #ended(result: RunOutcome): RunOutcome {
    // A hung run ends with its host: the supervisor, which kills it, logs the end of the program.
    if (result.hung) return result;
    this.events.push("program_finished", programFinished(result));
    this.triggers?.idle();
    const bot = this.#connection.bot;
    if (!bot || !this.#connection.spawned) return result;
    const inventory: Record<string, number> = {};
    for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    this.#stall.record({ position: bot.entity.position.floored().toString(), inventory });
    return result;
  }

  /** Records what a reflex being bound will run: its `when` expression (the routine's source is the library's). */
  #register(reflex: StoredReflex): Promise<void> {
    return this.#options.recorder.register(reflex.when ?? "", { trigger: reflex.name, routine: reflex.routine, on: reflex.on });
  }

  /**
   * Runs one firing of a reflex through the same runner and history as calls. Its end is a
   * `reflex_finished` event, not `program_finished`, so an agent waiting on its own programs is not woken by reflexes.
   */
  async #runTrigger(reflex: StoredReflex, event: BodyEvent, started: () => void): Promise<RunResult> {
    this.#options.syncKits?.();
    const run = () => {
      if (this.runner.running) throw new BusyError();
      started();
      return this.#callReflex(reflex, event);
    };
    return this.#options.recorder.record(
      {
        code: "",
        timeoutMs: reflex.timeoutMs,
        extra: { trigger: reflex.name, routine: reflex.routine, event: { seq: event.seq, type: event.type } },
        trigger: { name: reflex.name, updated: reflex.updated },
      },
      run,
    );
  }

  /** Calls a reflex's routine with `{ event }` as one run, loading its module inside the run as a call does. */
  #callReflex(reflex: StoredReflex, event: BodyEvent): Promise<RunOutcome> {
    const loader = this.#options.routines;
    if (!loader) throw new Error("this body has no routines");
    const environment = this.#environment();
    return this.runner.call(
      async (scope) => {
        const ctx = routineContext(scope, environment);
        return invokeRoutine(await loader.load(reflex.routine), reflex.routine, ctx, { event: structuredClone(event) });
      },
      { timeoutMs: reflex.timeoutMs, sourceDir: loader.dir },
    );
  }

  get milestones(): MilestoneSet | null {
    const parsed = MilestoneSet.safeParse(this.state.milestones);
    return parsed.success ? parsed.data : null;
  }

  /** Replaces the milestones; null removes them. */
  setMilestones(spec: MilestoneSet | null): void {
    this.state.setMilestones(spec);
  }

  async status(): Promise<StatusResponse> {
    const base = {
      connected: this.#connection.spawned,
      startedAt: this.#options.startedAt,
      deaths: this.#connection.deaths,
      reconnects: this.#connection.reconnects,
    };
    if (!capabilities(this.features).milestones) return base;
    const spec = this.milestones;
    const bot = this.#connection.bot;
    if (!spec || !bot || !this.#connection.spawned) return { ...base, milestones: null };
    try {
      const graded: MilestoneProgress = grade(spec, await requestStats(bot));
      return { ...base, milestones: graded };
    } catch (err) {
      return { ...base, milestones: null, milestonesError: err instanceof Error ? err.message : String(err) };
    }
  }

  get connected(): boolean {
    return this.#connection.spawned;
  }

  get deaths(): number {
    return this.#connection.deaths;
  }

  get reconnects(): number {
    return this.#connection.reconnects;
  }

  start(): void {
    this.#connection.start();
  }

  close(): void {
    this.triggers?.close();
    this.#connection.close();
    this.runner.stop();
  }

  chat(message: string): void {
    this.#connection.requireBot().chat(message);
  }

  observe(): Observation {
    const connection = this.#connection;
    const bot = connection.bot;
    if (!bot || !connection.spawned) {
      return {
        connected: false,
        reconnecting: connection.reconnecting,
        ...(connection.lastDisconnect && { lastDisconnect: connection.lastDisconnect }),
      };
    }
    const running = this.runner.running;
    const kitsOffered = capabilities(this.features).kits;
    return observation(bot, {
      programsWithoutChange: this.#stall.streak,
      activeKits: kitsOffered ? this.kits.active : undefined,
      program: running ? { running: true, elapsedMs: running.elapsedMs } : { running: false },
    });
  }

  /** The observation as one short line, for agents with small context windows. */
  brief(): string {
    return briefOf(this.observe(), this.runner.running);
  }
}
