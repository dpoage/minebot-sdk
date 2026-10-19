// The composition root: builds the body's parts (state, kit library and host, wiki, body,
// history), serves the API over the HTTP transport, and publishes the endpoint file. Each route
// names the capability it belongs to, so a feature the body lacks answers like an unknown route.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, isIPv6 } from "node:net";
import type { Bot } from "mineflayer";
import type { Kit } from "../kit/kit.ts";
import { KitLockedError, KitHost } from "../kit/kit.ts";
import { KitLibrary } from "../kit/library.ts";
import { BUILTIN_KITS } from "../kit/index.ts";
import { KitStats } from "../kit/stats.ts";
import type { MilestoneSet } from "../milestones/milestones.ts";
import { MC_VERSION } from "../mc/version.ts";
import type { ProgramScope } from "../program/scope.ts";
import {
  capabilities,
  ChatInput,
  endpointFile,
  EventsQuery,
  KitDocsQuery,
  KitSearchQuery,
  KitSourceQuery,
  KitVersionsQuery,
  LessonInput,
  MilestonesInput,
  NoteInput,
  NoteKey,
  ObserveQuery,
  programApiDoc,
  RemoveKitInput,
  RevertKitInput,
  RemoveTriggerInput,
  RunInput,
  RUNTIME_DIR,
  SaveKitInput,
  TriggerEnabledInput,
  TryKitInput,
  UseKitsInput,
  WaitInput,
  WikiListQuery,
  WikiPageQuery,
  WikiSearchQuery,
  type Endpoint,
  type KitInfo,
  type KitsResponse,
  type TriggersResponse,
  type WikiMode,
} from "../protocol/index.ts";
import { Wiki } from "../wiki/wiki.ts";
import { Body } from "./body.ts";
import { HttpError, parse, type Route, serveBodyApi } from "./http.ts";
import { ProgramHistory } from "./history.ts";
import { BodyState } from "./state.ts";

export interface DaemonOptions {
  name: string;
  username: string;
  host: string;
  port: number;
  /** Interface for the body API. Anything other than loopback requires an explicit `token`. */
  apiHost: string;
  /** Port for the body API; 0 picks a free port. */
  apiPort: number;
  /** Bearer token for the API. Generated when omitted. */
  token?: string;
  /** Appends one JSON line per program run (code, status, logs, result) to this file. */
  historyFile?: string;
  /** Built-in kits the body offers, by name; undefined offers every built-in kit. */
  kits?: readonly string[];
  /** Forbid changing the active kits while the body runs. */
  lockKits: boolean;
  /** Wiki access for the agent. */
  wikiMode: WikiMode;
  /** Curated wiki pages. Default: the repository's wiki/. */
  wikiDir?: string;
  /** Where agents' lessons are written and read. */
  lessonsDir?: string;
  /** Directory for notes, milestones, kit stores, and agent kits. */
  stateDir: string;
  /** Milestones to set at start, replacing stored ones. Without them, the body keeps what its state directory holds. */
  milestones?: MilestoneSet;
  /** Let the agent read, set, and grade milestones. */
  milestonesEnabled: boolean;
  /** Let agents save and remove their own kits. */
  agentKits: boolean;
  /** Where agents' kits are written; default: the state directory's agent-kits/. */
  agentKitsDir?: string;
  /** Let agents register triggers: programs the body runs when an event arrives. Default: true. */
  triggers?: boolean;
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

/** Starts a body and serves its API. Publishes the endpoint to `.minebot/<name>.json`. */
export async function startDaemon(options: DaemonOptions): Promise<{ endpoint: Endpoint; close: () => Promise<void> }> {
  const loopback = options.apiHost === "127.0.0.1" || options.apiHost === "localhost" || options.apiHost === "::1";
  if (!loopback && !options.token) {
    throw new Error(`refusing to serve the body API on ${options.apiHost} without an explicit token`);
  }
  if (options.milestones && !options.milestonesEnabled) throw new Error("milestones were given to a body that has milestones disabled");

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
    active: options.lockKits ? catalog.filter((kit) => !library.isAgent(kit.name)).map((kit) => kit.name) : undefined,
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

  /** Validates and writes an agent kit, then offers it. Nothing is written when validation fails. */
  async function saveKit(source: string): Promise<KitInfo> {
    const kit = await library.save(source, resolvable);
    try {
      syncKits();
    } catch (err) {
      await library.remove(kit.name).catch(() => {});
      throw err;
    }
    return host.infoFor(kit);
  }

  /** Saves an earlier version of an agent kit again and offers it. */
  async function revertKit(name: string, version: number): Promise<KitInfo> {
    const kit = await library.revert(name, version, resolvable);
    syncKits();
    return host.infoFor(kit);
  }

  /** Compiles and audits kit source like a save, then runs one action once inside the calling program. Nothing is written or registered. */
  async function tryKit(source: string, run: { action: string; args?: unknown }, scope: ProgramScope, bot: Bot): Promise<unknown> {
    syncKits();
    return host.tryKit(library.check(source, resolvable), run.action, run.args, scope, bot);
  }

  const wiki = options.wikiMode === "off" ? null : Wiki.load(options.wikiDir, options.lessonsDir);
  const history = new ProgramHistory({ file: options.historyFile, activeKits: () => host.active });
  await history.start();
  const body = new Body({
    username: options.username,
    host: options.host,
    port: options.port,
    state,
    kits: host,
    wiki,
    wikiMode: options.wikiMode,
    milestonesEnabled: options.milestonesEnabled,
    agentKits: options.agentKits && library.enabled,
    triggersEnabled: options.triggers ?? true,
    history,
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
  if (options.milestones) body.setMilestones(options.milestones);
  reportKitError = (file, error) => {
    if (reported.has(`${file}: ${error}`)) return;
    reported.add(`${file}: ${error}`);
    body.events.push("kit_error", { file, error });
  };
  for (const problem of startupProblems) body.events.push("kit_error", problem);

  const token = options.token ?? randomBytes(32).toString("hex");

  function kitsResponse(): KitsResponse {
    return { kits: host.info(), active: host.active, locked: host.locked };
  }

  function triggersResponse(): TriggersResponse {
    return { triggers: body.triggers?.list() ?? [] };
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/observe",
      handler: async ({ url }) => {
        const { brief } = parse(ObserveQuery, Object.fromEntries(url.searchParams));
        return brief === "1" || brief === "true" ? { brief: body.brief() } : body.observe();
      },
    },
    { method: "GET", path: "/status", handler: () => body.status() },
    { method: "GET", path: "/milestones", capability: "milestones", handler: () => ({ milestones: body.milestones }) },
    {
      method: "PUT",
      path: "/milestones",
      capability: "milestones",
      handler: async ({ read }) => {
        const { milestones } = parse(MilestonesInput, await read());
        body.setMilestones(milestones);
        return { milestones: body.milestones };
      },
    },
    { method: "GET", path: "/notes", handler: () => ({ notes: body.notes.list() }) },
    {
      method: "GET",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url }) => {
        const note = body.notes.get(decodeURIComponent(url.pathname.slice("/notes/".length)));
        if (!note) throw new HttpError(404, `no note "${decodeURIComponent(url.pathname.slice("/notes/".length))}"`);
        return note;
      },
    },
    {
      method: "PUT",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url, read }) => {
        const key = decodeURIComponent(url.pathname.slice("/notes/".length));
        const { text } = parse(NoteInput, await read());
        NoteKey.parse(key);
        return body.notes.set(key, text);
      },
    },
    {
      method: "DELETE",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url }) => ({ deleted: body.notes.delete(decodeURIComponent(url.pathname.slice("/notes/".length))) }),
    },
    {
      method: "GET",
      path: "/events",
      handler: async ({ url }) => {
        const query = parse(EventsQuery, Object.fromEntries(url.searchParams));
        return body.events.since(query.since, query.limit);
      },
    },
    {
      method: "POST",
      path: "/run",
      handler: async ({ read }) => {
        const { code, timeoutMs } = parse(RunInput, await read());
        return history.record(code, () => body.run(code, timeoutMs));
      },
    },
    {
      method: "POST",
      path: "/wait",
      handler: async ({ read, res }) => {
        const query = parse(WaitInput, await read());
        // A client that hangs up must not hold a waiter for the rest of the timeout.
        const abandoned = new AbortController();
        res.once("close", () => abandoned.abort());
        return body.events.wait({
          types: query.types,
          from: query.from,
          match: query.match === undefined ? undefined : new RegExp(query.match, "i"),
          since: query.since,
          timeoutMs: query.timeoutMs,
          signal: abandoned.signal,
        });
      },
    },
    { method: "POST", path: "/stop", handler: () => ({ stopped: body.runner.stop() }) },
    {
      method: "POST",
      path: "/chat",
      handler: async ({ read }) => {
        const { message } = parse(ChatInput, await read());
        body.chat(message);
        return { sent: true };
      },
    },
    { method: "GET", path: "/api", handler: () => ({ doc: programApiDoc(body.features) }) },
    { method: "GET", path: "/features", handler: () => body.features },
    { method: "GET", path: "/kits", capability: "kits", handler: () => (syncKits(), kitsResponse()) },
    {
      method: "POST",
      path: "/kits",
      capability: "kitSwitching",
      handler: async ({ read }) => {
        const { use } = parse(UseKitsInput, await read());
        try {
          host.use(use);
        } catch (err) {
          if (err instanceof KitLockedError) throw new HttpError(403, err.message);
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        return kitsResponse();
      },
    },
    {
      method: "GET",
      path: "/kits/docs",
      capability: "kits",
      handler: async ({ url }) => {
        const { names } = parse(KitDocsQuery, Object.fromEntries(url.searchParams));
        try {
          syncKits();
          return { docs: host.docs(names ? names.split(",").filter(Boolean) : []) };
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: "GET",
      path: "/kits/source",
      capability: "agentKits",
      handler: async ({ url }) => {
        const { name } = parse(KitSourceQuery, Object.fromEntries(url.searchParams));
        const source = library.source(name);
        if (source === undefined) throw new HttpError(404, `no kit "${name}"`);
        return { name, source };
      },
    },
    {
      method: "POST",
      path: "/kits/save",
      capability: "agentKits",
      handler: async ({ read }) => saveKit(parse(SaveKitInput, await read()).source),
    },
    {
      method: "POST",
      path: "/kits/remove",
      capability: "agentKits",
      handler: async ({ read }) => {
        const { name } = parse(RemoveKitInput, await read());
        await library.remove(name);
        syncKits();
        return { removed: name };
      },
    },
    {
      method: "GET",
      path: "/kits/search",
      capability: "kits",
      handler: async ({ url }) => {
        const { q, limit } = parse(KitSearchQuery, Object.fromEntries(url.searchParams));
        syncKits();
        return { hits: host.search(q, limit) };
      },
    },
    {
      method: "GET",
      path: "/kits/versions",
      capability: "agentKits",
      handler: async ({ url }) => {
        const { name } = parse(KitVersionsQuery, Object.fromEntries(url.searchParams));
        return { name, versions: await library.versions(name) };
      },
    },
    {
      method: "POST",
      path: "/kits/revert",
      capability: "agentKits",
      handler: async ({ read }) => {
        const { name, version } = parse(RevertKitInput, await read());
        return revertKit(name, version);
      },
    },
    {
      // Runs as a program: the action needs the live bot and the program's scope, and the run is recorded like any other.
      method: "POST",
      path: "/kits/try",
      capability: "agentKits",
      handler: async ({ read }) => {
        const { source, action, args, timeoutMs } = parse(TryKitInput, await read());
        const code = `return await kits.try(${JSON.stringify(source)}, ${JSON.stringify({ action, args })});`;
        return history.record(code, () => body.run(code, timeoutMs));
      },
    },
    { method: "GET", path: "/triggers", capability: "triggers", handler: () => triggersResponse() },
    {
      method: "POST",
      path: "/triggers",
      capability: "triggers",
      handler: async ({ read }) => body.triggers!.add(await read()),
    },
    {
      method: "POST",
      path: "/triggers/remove",
      capability: "triggers",
      handler: async ({ read }) => {
        const { name } = parse(RemoveTriggerInput, await read());
        if (!body.triggers!.remove(name)) throw new HttpError(404, `no trigger "${name}"`);
        return { removed: name };
      },
    },
    {
      method: "POST",
      path: "/triggers/enabled",
      capability: "triggers",
      handler: async ({ read }) => {
        const { name, enabled } = parse(TriggerEnabledInput, await read());
        return { trigger: body.triggers!.setEnabled(name, enabled) };
      },
    },
    {
      method: "GET",
      path: "/wiki/search",
      capability: "wiki",
      handler: async ({ url }) => {
        const { q, limit } = parse(WikiSearchQuery, Object.fromEntries(url.searchParams));
        return { hits: body.wiki.search(q, limit) };
      },
    },
    {
      method: "GET",
      path: "/wiki/page",
      capability: "wiki",
      handler: async ({ url }) => {
        const { id } = parse(WikiPageQuery, Object.fromEntries(url.searchParams));
        return body.wiki.readFormatted(id);
      },
    },
    {
      method: "GET",
      path: "/wiki/list",
      capability: "wiki",
      handler: async ({ url }) => {
        const { section } = parse(WikiListQuery, Object.fromEntries(url.searchParams));
        return { pages: body.wiki.list(section), mode: body.wiki.mode };
      },
    },
    {
      method: "POST",
      path: "/wiki/lessons",
      capability: "lessons",
      handler: async ({ read }) => body.wiki.addLesson(parse(LessonInput, await read())),
    },
  ];

  const server = serveBodyApi({
    token,
    routes,
    offered: (capability) => capabilities(body.features)[capability],
    health: () => ({ name: options.name, connected: body.connected }),
  });
  // Programs and waits hold the request open for their whole duration.
  server.requestTimeout = 0;

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(options.apiPort, options.apiHost, () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as AddressInfo;
  // Clients connect to the address the server listens on; a wildcard address is reached through loopback.
  const clientHost = options.apiHost === "0.0.0.0" ? "127.0.0.1" : options.apiHost === "::" ? "::1" : options.apiHost;
  const endpoint: Endpoint = {
    name: options.name,
    url: `http://${isIPv6(clientHost) ? `[${clientHost}]` : clientHost}:${port}`,
    token,
    pid: process.pid,
    mcVersion: MC_VERSION,
    server: { host: options.host, port: options.port },
  };
  await mkdir(RUNTIME_DIR, { recursive: true });
  const file = endpointFile(options.name);
  await writeFile(file, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 });
  body.start();

  return {
    endpoint,
    close: async () => {
      body.close();
      stats.flush();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(file, { force: true });
    },
  };
}
