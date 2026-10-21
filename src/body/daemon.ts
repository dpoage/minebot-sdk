// The supervisor's composition root: forks the bot host, serves the API over the HTTP transport
// (answering health, the event log, waits, and stop itself, and forwarding every other request to
// the host), keeps the program history, and publishes the endpoint file. The body's player and
// programs live in the host process; this process outlives them.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, isIPv6 } from "node:net";
import type { ServerAuth } from "../host/connection.ts";
import type { MilestoneSet } from "../milestones/milestones.ts";
import { MC_VERSION } from "../mc/version.ts";
import { endpointFile, EventsQuery, RUNTIME_DIR, WaitInput, type Endpoint, type WikiMode } from "../protocol/index.ts";
import { parse } from "../protocol/request.ts";
import { EventLog } from "./events.ts";
import { HostProcess } from "./host-process.ts";
import { ProgramHistory } from "./history.ts";
import { type Route, serveBodyApi } from "./http.ts";

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
  /** Let agents keep routines: modules they save, bind to names, and call. Default: true. */
  routines?: boolean;
  /** Where routines are saved; default: the state directory's routines/. Bodies that share the directory share their routines. */
  routinesDir?: string;
}

/** Starts a body and serves its API. Publishes the endpoint to `.minebot/<name>.json`. */
export async function startDaemon(options: DaemonOptions): Promise<{ endpoint: Endpoint; close: () => Promise<void> }> {
  const loopback = options.apiHost === "127.0.0.1" || options.apiHost === "localhost" || options.apiHost === "::1";
  if (!loopback && !options.token) {
    throw new Error(`refusing to serve the body API on ${options.apiHost} without an explicit token`);
  }
  if (options.milestones && !options.milestonesEnabled) throw new Error("milestones were given to a body that has milestones disabled");

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
  const routes: Route[] = [
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
  ];

  const server = serveBodyApi({
    token,
    routes,
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
