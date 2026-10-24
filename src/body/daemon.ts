// The supervisor's composition root: forks the bot host, serves the API over the HTTP transport
// (answering health, the event log, waits, and stop itself, and forwarding every other request to
// the host), keeps the program history, and publishes the endpoint file. The body's player and
// programs live in the host process; this process outlives them.
import { randomBytes } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, isIPv6 } from "node:net";
import path from "node:path";
import type { ServerAuth } from "../host/connection.ts";
import type { MilestoneSet } from "../milestones/milestones.ts";
import { MC_VERSION } from "../mc/version.ts";
import { endpointFile, EventsQuery, RUNTIME_DIR, WaitInput, type Endpoint, type WikiMode } from "../protocol/index.ts";
import { HttpError, parse } from "../protocol/request.ts";
import { EventLog } from "./events.ts";
import { HostProcess } from "./host-process.ts";
import { ProgramHistory } from "./history.ts";
import { type Route, serveBodyApi } from "./http.ts";

/**
 * Earlier bodies kept the kits agents saved in `<state>/agent-kits/`. Nothing loads, writes, or deletes the files there now; this only lists
 * the directory and, when it holds kit files, says so once on stderr, so an operator who still has them knows they are not loaded.
 */
function noteLeftoverAgentKits(stateDir: string): void {
  const dir = path.join(stateDir, "agent-kits");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  if (files.length > 0) console.error(`[minebot] ${dir} holds ${files.length} agent kit file${files.length === 1 ? "" : "s"}: agent kits are no longer loaded`);
}

export interface DaemonOptions {
  name: string;
  username: string;
  /** How the player logs in to the server. */
  auth: ServerAuth;
  host: string;
  port: number;
  /** Interface for the body API. Anything other than loopback requires an explicit `token`. */
  apiHost: string;
  /** Port for the body API; 0 picks a free port. */
  apiPort: number;
  /** Bearer token for the API. Generated when omitted. */
  token?: string;
  /** Appends one JSON line per run, call, and reflex firing (code, status, logs, result) to this file. */
  historyFile?: string;
  /** Wiki access for the agent. */
  wikiMode: WikiMode;
  /** Curated wiki pages. Default: the repository's wiki/. */
  wikiDir?: string;
  /** Where agents' lessons are written and read. */
  lessonsDir?: string;
  /** Directory for notes, milestones, routine stores, reflexes, bindings, and routines. */
  stateDir: string;
  /** Milestones to set at start, replacing stored ones. Without them, the body keeps what its state directory holds. */
  milestones?: MilestoneSet;
  /** Let the agent read, set, and grade milestones. */
  milestonesEnabled: boolean;
  /** Let agents bind reflexes: routines the body runs when an event arrives. Default: true. A body without routines offers none either way. */
  triggers?: boolean;
  /** Let agents keep routines: modules they save, bind to names, and call. Default: true. */
  routines?: boolean;
  /** Where routines are saved; default: the state directory's routines/. Bodies that share the directory share their routines. */
  routinesDir?: string;
  /** Built-in routine modules the body offers, by name, with every module they use; undefined offers every built-in module, an empty list none. An unknown name fails the start. */
  builtins?: readonly string[];
}

/** Starts a body and serves its API. Publishes the endpoint to `.minebot/<name>.json`. */
export async function startDaemon(options: DaemonOptions): Promise<{ endpoint: Endpoint; close: () => Promise<void> }> {
  const loopback = options.apiHost === "127.0.0.1" || options.apiHost === "localhost" || options.apiHost === "::1";
  if (!loopback && !options.token) {
    throw new Error(`refusing to serve the body API on ${options.apiHost} without an explicit token`);
  }
  if (options.milestones && !options.milestonesEnabled) throw new Error("milestones were given to a body that has milestones disabled");

  noteLeftoverAgentKits(options.stateDir);
  const { apiHost, apiPort, token: given, historyFile, ...world } = options;
  const events = new EventLog();
  const history = new ProgramHistory({ file: historyFile });
  const host = new HostProcess({ init: { ...world, startedAt: new Date().toISOString(), deaths: 0, reconnects: 0, applyMilestones: true }, events, history });
  try {
    await host.start();
    await history.start();
  } catch (err) {
    await host.close();
    throw err;
  }

  const token = given ?? randomBytes(32).toString("hex");

  const server = serveBodyApi({
    token,
    routes: supervisorRoutes({ events, host }),
    forward: (request) => host.forward(request),
    health: () => ({ name: options.name, connected: host.connected }),
  });

  // Programs and waits hold the request open for their whole duration.
  server.requestTimeout = 0;

  const file = endpointFile(options.name);
  let endpoint: Endpoint;
  try {
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(apiPort, apiHost, () => listening.resolve());
    await listening.promise;
    const { port } = server.address() as AddressInfo;
    // Clients connect to the address the server listens on; a wildcard address is reached through loopback.
    const clientHost = apiHost === "0.0.0.0" ? "127.0.0.1" : apiHost === "::" ? "::1" : apiHost;
    endpoint = {
      name: options.name,
      url: `http://${isIPv6(clientHost) ? `[${clientHost}]` : clientHost}:${port}`,
      token,
      pid: process.pid,
      mcVersion: MC_VERSION,
      server: { host: options.host, port: options.port },
    };
    await mkdir(RUNTIME_DIR, { recursive: true });
    await writeFile(file, `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    await host.close();
    server.close();
    throw err;
  }
  host.join();

  return {
    endpoint,
    close: async () => {
      await host.close();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await rm(file, { force: true });
    },
  };
}

/**
 * The routes the supervisor answers itself, over its event log and its kept finished runs: the event
 * log, waits, stop, and a finished run's record. Every other request the host answers.
 */
export function supervisorRoutes({ events, host }: { events: EventLog; host: HostProcess }): Route[] {
  return [
    {
      method: "GET",
      path: "/events",
      handler: async ({ url }) => {
        const query = parse(EventsQuery, Object.fromEntries(url.searchParams));
        return events.since(query.since, query.limit);
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
        return events.wait({
          types: query.types,
          from: query.from,
          match: query.match === undefined ? undefined : new RegExp(query.match, "i"),
          since: query.since,
          timeoutMs: query.timeoutMs,
          signal: abandoned.signal,
        });
      },
    },
    { method: "POST", path: "/stop", handler: () => host.stop() },
    {
      // A finished run's record: the one <seq> names (the seq its program_finished event carries), or the most recent without one.
      method: "GET",
      path: "/runs",
      pattern: /^\/runs(?:\/.*)?$/,
      handler: ({ url }) => {
        const which = url.pathname.slice("/runs".length + 1);
        try {
          return host.keptRun(which === "" ? undefined : Number(which));
        } catch (err) {
          throw new HttpError(404, err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
