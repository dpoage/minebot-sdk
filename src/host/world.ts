// The bot host's world: what the supervisor's daemon used to build in one process: the state
// directory, the kit library and host with their sync/save/revert/try, the wiki, and the Body,
// served through the route table. Everything a program reads synchronously lives here.
import path from "node:path";
import type { Bot } from "mineflayer";
import type { Kit } from "../kit/kit.ts";
import { KitHost } from "../kit/kit.ts";
import { KitLibrary } from "../kit/library.ts";
import { BUILTIN_KITS } from "../kit/index.ts";
import { KitStats } from "../kit/stats.ts";
import type { ProgramScope } from "../program/scope.ts";
import type { HostInit, EventSink } from "../protocol/host.ts";
import type { KitInfo, SaveKitResponse } from "../protocol/index.ts";
import { Wiki } from "../wiki/wiki.ts";
import { Body, type RunRecorder } from "./body.ts";
import { type ApiRequest, bodyRoutes, serve } from "./routes.ts";
import { BodyState } from "./state.ts";
import { typeCheckKit, typeCheckLog } from "./typecheck.ts";

export interface World {
  readonly body: Body;
  readonly kits: KitHost;
  /** Answers one API request. */
  serve(request: ApiRequest): Promise<{ status: number; body: unknown }>;
  /** Joins the server. */
  start(): void;
  /** Closes the body and writes the kit stats still buffered. */
  close(): void;
}

/** Names of a kit list's transitive closure over the built-ins' `uses`. */
function builtinClosure(names: readonly string[] | undefined): string[] {
  if (names === undefined) return BUILTIN_KITS.map((kit) => kit.name);
  const byName = new Map(BUILTIN_KITS.map((kit) => [kit.name, kit] as const));
  const order: string[] = [];
  const visit = (name: string) => {
    if (order.includes(name)) return;
    const kit = byName.get(name);
    if (!kit) throw new Error(`unknown built-in kit "${name}"; available: ${[...byName.keys()].join(", ")}`);
    for (const dep of kit.uses) visit(dep);
    order.push(name);
  };
  for (const name of names) visit(name);
  return order;
}

/**
 * The agent kits that fit an offer: an agent kit joins when its uses are all offered (built-ins
 * or agent kits already added). Kits left out are reported with the reason.
 */
function fittingAgentKits(builtinOffer: readonly string[], agents: Map<string, Kit>): { kits: Kit[]; skipped: { name: string; reason: string }[] } {
  const offered = new Set(builtinOffer);
  const kits: Kit[] = [];
  const remaining = [...agents.values()];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < remaining.length; i++) {
      const kit = remaining[i]!;
      if (!kit.uses.every((dep) => offered.has(dep))) continue;
      offered.add(kit.name);
      kits.push(kit);
      remaining.splice(i, 1);
      i--;
      changed = true;
    }
  }
  return { kits, skipped: remaining.map((kit) => ({ name: kit.name, reason: `it uses kits this body does not offer: ${kit.uses.filter((dep) => !offered.has(dep)).join(", ")}` })) };
}

/** Builds the world from the host's init. Throws with the reason when it cannot (an unknown kit, an unreadable state). */
export function buildWorld(options: HostInit, io: { events: EventSink; recorder: RunRecorder }): World {
  const state = new BodyState(options.stateDir);
  // Problems found before the body exists are held here and flushed into its event log.
  const startupProblems: { file: string; error: string }[] = [];
  const reported = new Set<string>();
  let reportKitError = (file: string, error: string) => {
    if (reported.has(`${file}: ${error}`)) return;
    reported.add(`${file}: ${error}`);
    startupProblems.push({ file, error });
  };
  // Per-action call counts live in the state directory; a changed or removed agent kit starts from zero.
  const stats = new KitStats(state.kitStats);
  const library = new KitLibrary({
    dir: options.agentKits ? (options.agentKitsDir ?? state.agentKitsDir) : undefined,
    onProblem: (file, error) => reportKitError(file, error),
    onChange: (kit) => stats.reset(kit),
    savedBy: options.name,
  });
  const builtinOffer = builtinClosure(options.kits);
  const initial = fittingAgentKits(builtinOffer, library.agentKits());
  for (const { name, reason } of initial.skipped) reportKitError(`${name}.ts`, reason);
  const catalog = [...BUILTIN_KITS.filter((kit) => builtinOffer.includes(kit.name)), ...initial.kits];
  const host = new KitHost({
    kits: catalog,
    stores: (kit) => state.store(kit),
    // A locked body fixes its active set: saved kits are offered, but only a restart without the lock activates them.
    // A replacement host carries the previous host's set over, less the kits this catalog no longer offers (a deleted agent kit).
    active: options.lockKits
      ? catalog.filter((kit) => !library.isAgent(kit.name)).map((kit) => kit.name)
      : options.active?.filter((name) => catalog.some((kit) => kit.name === name)),
    locked: options.lockKits,
    agent: (name) => library.isAgent(name),
    stats,
  });

  /** Brings the host's catalog in line with the library: new kits join, updated ones are replaced, deleted ones drop out. */
  function syncKits(): void {
    const agents = library.agentKits();
    const builtinNames = host.offered.filter((name) => !library.isAgent(name));
    const fit = fittingAgentKits(builtinNames, agents);
    for (const kit of fit.kits) {
      if (host.offeredKit(kit.name) === kit) continue;
      if (host.offeredKit(kit.name)) {
        host.update(kit);
        continue;
      }
      try {
        host.add(kit);
      } catch (err) {
        reportKitError(`${kit.name}.ts`, err instanceof Error ? err.message : String(err));
      }
    }
    for (const name of host.offered) {
      if (library.isAgent(name) && !agents.has(name)) host.remove(name);
    }
    for (const { name, reason } of fit.skipped) reportKitError(`${name}.ts`, reason);
  }

  /** Whether a kit's `uses` entry names a kit this body offers. */
  const resolvable = (name: string) => host.offered.includes(name) || library.agentKits().has(name);

  /** Validates and writes an agent kit, then offers it and reports its type check. Nothing is written when validation fails; type errors do not stop the save. */
  async function saveKit(source: string): Promise<SaveKitResponse> {
    const kit = await library.save(source, resolvable);
    try {
      syncKits();
    } catch (err) {
      await library.remove(kit.name).catch(() => {});
      throw err;
    }
    return { ...host.infoFor(kit), typeCheck: await typeCheckKit(source, kit.name, host.schemas().filter((schema) => schema.agent)) };
  }

  /** Saves an earlier version of an agent kit again and offers it. */
  async function revertKit(name: string, version: number): Promise<KitInfo> {
    const kit = await library.revert(name, version, resolvable);
    syncKits();
    return host.infoFor(kit);
  }

  /** Compiles and audits kit source like a save, then runs one action once inside the calling program while the source is type-checked; type errors go to the program log. Nothing is written or registered. */
  async function tryKit(source: string, run: { action: string; args?: unknown }, scope: ProgramScope, bot: Bot): Promise<unknown> {
    syncKits();
    const kit = library.check(source, resolvable);
    const checked = typeCheckKit(source, kit.name, host.schemas().filter((schema) => schema.agent), scope.signal);
    try {
      return await host.tryKit(kit, run.action, run.args, scope, bot);
    } finally {
      const line = typeCheckLog(await checked);
      if (line) scope.log(line);
    }
  }

  const wiki = options.wikiMode === "off" ? null : Wiki.load(options.wikiDir, options.lessonsDir);
  const body = new Body({
    username: options.username,
    auth: options.auth,
    authCacheDir: path.join(options.stateDir, "auth"),
    host: options.host,
    port: options.port,
    state,
    kits: host,
    wiki,
    wikiMode: options.wikiMode,
    milestonesEnabled: options.milestonesEnabled,
    agentKits: options.agentKits && library.enabled,
    triggersEnabled: options.triggers ?? true,
    events: io.events,
    recorder: io.recorder,
    startedAt: options.startedAt,
    deaths: options.deaths,
    reconnects: options.reconnects,
    syncKits,
    kitAuthoring: {
      save: saveKit,
      remove: (name: string) => library.remove(name),
      source: (name: string) => {
        const source = library.source(name);
        if (source === undefined) throw new Error(`no kit "${name}"`);
        return source;
      },
      versions: (name: string) => library.versions(name),
      revert: revertKit,
      try: tryKit,
    },
  });
  if (options.applyMilestones && options.milestones) body.setMilestones(options.milestones);
  reportKitError = (file, error) => {
    if (reported.has(`${file}: ${error}`)) return;
    reported.add(`${file}: ${error}`);
    io.events.push("kit_error", { file, error });
  };
  for (const problem of startupProblems) io.events.push("kit_error", problem);

  const routes = bodyRoutes({ body, kits: host, library, syncKits, saveKit, revertKit, recorder: io.recorder });
  return {
    body,
    kits: host,
    serve: (request) => serve(routes, body, request),
    start: () => body.start(),
    close: () => {
      try {
        body.close();
      } finally {
        stats.flush();
      }
    },
  };
}
