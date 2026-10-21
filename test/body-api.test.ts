// Characterization of the body's HTTP API: a real body, started with `startDaemon`, answers the
// routes of the API as it does today. The suite sees the body only through HTTP, the history file,
// the endpoint file, and startDaemon's promise, so it must pass unchanged however the body is
// composed inside (one process or a supervisor and a bot host).
//
// Every scenario starts its own body against a loopback port that refuses connections, so a body is
// never connected: its first connection attempt fails at once and the next one is scheduled 5 s out.
// A scenario therefore finishes well inside that window (one asserts the window's own events).
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { z } from "zod";
import type { DaemonOptions } from "../src/body/daemon.ts";
import type { KitHost } from "../src/kit/kit.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";

// Everything the suite writes lives under ROOT, the typechecker's scratch directories included.
const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-body-api-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
process.env.TMPDIR = ROOT;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads, so nothing that reaches it loads before the line above.
const { startDaemon } = await import("../src/body/daemon.ts");
const { endpointFile, programApiDoc } = await import("../src/protocol/index.ts");
const { MC_VERSION } = await import("../src/mc/version.ts");
const { BUILTIN_KITS } = await import("../src/kit/index.ts");
const { KitHost: KitHostClass } = await import("../src/kit/kit.ts");
const { JsonStore } = await import("../src/store.ts");
const { findEscapeAttempts } = await import("../src/audit.ts");

type Features = BodyFeatures;

/** The largest request body the API reads (MAX_BODY_BYTES in src/body/http.ts). */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NOTES = 200;

// minecraft-protocol arms a 30 s timer when a client ends and keeps the process alive for it. The
// suite unrefs every such timer once its body is closed, so the test process exits when its tests do.
interface DelayedTimer extends NodeJS.Timeout {
  /** Node's own record of the delay; not in the public typings. */
  _idleTimeout: number;
}
const longTimers: NodeJS.Timeout[] = [];
createHook({
  init(_id, type, _trigger, resource) {
    if (type === "Timeout" && (resource as DelayedTimer)._idleTimeout >= 30_000) longTimers.push(resource as NodeJS.Timeout);
  },
}).enable();
function releaseLongTimers(): void {
  for (const timer of longTimers.splice(0)) timer.unref();
}

after(() => {
  releaseLongTimers();
  rmSync(ROOT, { recursive: true, force: true });
});

/** A loopback port that refuses connections: bound once, then released. */
async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Waits for the first buffered or new event of a type, which the body produces on its own (no sleeping).
 * A body's first connection attempt is settled once it has scheduled the next, so every body waits for that before it is used or closed.
 */
async function awaitEvent(url: string, token: string, type: string): Promise<void> {
  const response = await fetch(`${url}/wait`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ types: [type], since: 0, timeoutMs: 20_000 }) });
  const reply: unknown = await response.json();
  assert.ok(response.status === 200 && typeof reply === "object" && reply !== null && "timedOut" in reply && reply.timedOut === false, `no ${type} event arrived: ${JSON.stringify(reply)}`);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MILLISECOND_KEYS = new Set(["time", "durationMs", "elapsedMs"]);

/**
 * The one normalizer of the suite. It replaces what differs between runs and nothing else:
 * timestamps (ISO strings, and the event log's epoch `time`), durations, the token, and ports.
 */
function normalize(value: unknown, env: { token: string; ports: readonly number[] }, key?: string): unknown {
  if (typeof value === "string") {
    if (value === env.token) return "<token>";
    if (ISO_TIMESTAMP.test(value)) return "<timestamp>";
    let text = value;
    for (const port of env.ports) text = text.replaceAll(`:${port}`, ":<port>");
    return text.replaceAll(env.token, "<token>");
  }
  if (typeof value === "number") {
    if (key !== undefined && MILLISECOND_KEYS.has(key)) return "<ms>";
    if (key === "port" && env.ports.includes(value)) return "<port>";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, env));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, env, k)]));
  }
  return value;
}

/** What a response must be on the wire: JSON drops undefined fields. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Every route of the body API, as the suite keys them: "METHOD /path". */
const ROUTES = [
  "GET /health",
  "GET /observe",
  "GET /status",
  "GET /milestones",
  "PUT /milestones",
  "GET /notes",
  "GET /notes/:key",
  "PUT /notes/:key",
  "DELETE /notes/:key",
  "GET /events",
  "POST /run",
  "POST /wait",
  "POST /stop",
  "POST /chat",
  "GET /api",
  "GET /features",
  "GET /kits",
  "POST /kits",
  "GET /kits/docs",
  "GET /kits/schemas",
  "GET /kits/source",
  "POST /kits/save",
  "POST /kits/remove",
  "GET /kits/search",
  "GET /kits/versions",
  "POST /kits/revert",
  "POST /kits/try",
  "GET /triggers",
  "POST /triggers",
  "POST /triggers/remove",
  "POST /triggers/enabled",
  "GET /wiki/search",
  "GET /wiki/page",
  "GET /wiki/list",
  "POST /wiki/lessons",
] as const;

/** The routes a request reached in a body that serves them (not the unknown-route answer). */
const reached = new Set<string>();

function routeKey(method: string, url: string): string {
  const pathname = new URL(url, "http://localhost").pathname;
  return `${method} ${pathname.startsWith("/notes/") ? "/notes/:key" : pathname}`;
}

interface Call {
  /** JSON-encoded as the request body. */
  json?: unknown;
  /** Sent verbatim as the request body. */
  raw?: string;
  /** Authorization header; default: the body's bearer token. null sends none. */
  auth?: string | null;
}

interface Expected {
  status?: number;
  body: unknown;
}

interface Running {
  name: string;
  token: string;
  url: string;
  dirs: { state: string; history: string; lessons: string; wiki: string; agentKits: string };
  ports: number[];
  /** Sends one request. */
  send(method: string, url: string, call?: Call): Promise<{ status: number; body: unknown }>;
  /** Sends one request and asserts its status and whole normalized JSON body. */
  call(method: string, url: string, expected: Expected, call?: Call): Promise<void>;
  close(): Promise<void>;
}

let sequence = 0;

interface Scenario extends Partial<Omit<DaemonOptions, "name" | "port" | "apiHost" | "apiPort" | "token" | "stateDir" | "historyFile" | "lessonsDir" | "wikiDir">> {
  /** Written into the state directory (relative path to JSON value) before the body starts. */
  stateFiles?: Record<string, unknown>;
  /** Written verbatim into the agent-kits directory before the body starts. */
  agentKitFiles?: Record<string, string>;
  /** Written into the lessons directory before the body starts. */
  lessonFiles?: Record<string, string>;
  /** The body writes a program history. */
  history?: boolean;
  /** Use the repository's own wiki instead of the fixture wiki. */
  repositoryWiki?: boolean;
}

function writeTree(root: string, files: Record<string, string | unknown>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

const page = (meta: string, body: string) => `---\n${meta}\n---\n\n${body}\n`;

/** Curated pages every scenario's wiki starts from; two of them depend on features a body may lack. */
function writeFixtureWiki(dir: string): void {
  writeTree(dir, {
    "quirks/drops.md": page(`title: Drops fall out of reach\ntags: [items, drops]\nmc_version: "${MC_VERSION}"\nverified_by: body-api test`, "Walk over the drop to pick it up.\nDrops despawn after five minutes."),
    "mechanics/smelting.md": page("title: Smelting\ntags: [furnace]\nverified_by: body-api test", "A furnace smelts raw iron into ingots."),
    "mechanics/kit-use.md": page("title: Using kits\ntags: [kits]\nverified_by: body-api test\nrequires: [kits]", "Call kit actions with one object argument."),
    "mechanics/saved-kits.md": page("title: Saving your own kits\ntags: [kits]\nverified_by: body-api test\nrequires: [agentKits]", "Save a kit and it joins the active set."),
  });
}

async function startBody(scenario: Scenario = {}): Promise<Running> {
  const name = `charz${++sequence}`;
  const token = `token-${name}`;
  const base = mkdtempSync(path.join(ROOT, `${name}-`));
  const dirs = {
    state: path.join(base, "state"),
    history: path.join(base, "history", "programs.jsonl"),
    lessons: path.join(base, "lessons"),
    wiki: path.join(base, "wiki"),
    agentKits: path.join(base, "state", "agent-kits"),
  };
  writeFixtureWiki(dirs.wiki);
  if (scenario.stateFiles) writeTree(dirs.state, scenario.stateFiles);
  if (scenario.agentKitFiles) writeTree(dirs.agentKits, scenario.agentKitFiles);
  if (scenario.lessonFiles) writeTree(dirs.lessons, scenario.lessonFiles);
  const { stateFiles: _state, agentKitFiles: _agentKits, lessonFiles: _lessons, history, repositoryWiki, ...options } = scenario;
  const mcPort = await refusedPort();
  const daemon = await startDaemon({
    username: name,
    auth: "offline",
    lockKits: false,
    wikiMode: "read",
    milestonesEnabled: true,
    agentKits: true,
    ...options,
    name,
    host: "127.0.0.1",
    port: mcPort,
    apiHost: "127.0.0.1",
    apiPort: 0,
    token,
    stateDir: dirs.state,
    lessonsDir: dirs.lessons,
    ...(repositoryWiki ? {} : { wikiDir: dirs.wiki }),
    ...(history && { historyFile: dirs.history }),
  });
  const apiPort = Number(new URL(daemon.endpoint.url).port);
  const ports = [mcPort, apiPort];
  try {
    await awaitEvent(daemon.endpoint.url, token, "reconnect_scheduled");
  } catch (error) {
    await daemon.close();
    throw error;
  }

  async function send(method: string, url: string, call: Call = {}) {
    const headers: Record<string, string> = {};
    const auth = call.auth === undefined ? `Bearer ${token}` : call.auth;
    if (auth !== null) headers.authorization = auth;
    const body = call.raw ?? (call.json === undefined ? undefined : JSON.stringify(call.json));
    const response = await fetch(`${daemon.endpoint.url}${url}`, { method, headers, body });
    return { status: response.status, body: await response.json() };
  }

  const running: Running = {
    name,
    token,
    url: daemon.endpoint.url,
    dirs,
    ports,
    send,
    async call(method, url, expected, call) {
      const actual = await send(method, url, call);
      const message = `${method} ${url} answered ${actual.status} ${JSON.stringify(actual.body)}`;
      assert.deepStrictEqual({ status: actual.status, body: normalize(actual.body, { token, ports }) }, { status: expected.status ?? 200, body: expected.body }, message);
      const error = typeof actual.body === "object" && actual.body !== null && "error" in actual.body ? String(actual.body.error) : "";
      if (!error.startsWith("no route for")) reached.add(routeKey(method, url));
    },
    async close() {
      await daemon.close();
      releaseLongTimers();
    },
  };
  return running;
}

/** What a kit host over `kits` lists, searches, documents, and describes: the reference for the kit routes. */
function referenceKits(names: readonly string[], locked = false): KitHost {
  const kits = BUILTIN_KITS.filter((kit) => names.includes(kit.name));
  return new KitHostClass({ kits, stores: () => JsonStore.memory(), locked, active: names });
}

const FEATURES_ALL: Features = { kits: ["move"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true };

const NOT_CONNECTED = { error: "the body is not connected to a server" };
const NO_ROUTE = (method: string, pathname: string) => ({ error: `no route for ${method} ${pathname}` });
const MILESTONES = { milestones: [{ id: "sticks", description: "Craft a stick", obtained: ["stick"], via: "crafted", count: 4 }] };

/** A tiny valid agent kit; `description` tells versions apart. */
const kitSource = (description: string) =>
  `import { defineKit, action, z } from "minebot-sdk/kit";\n` +
  `export default defineKit({ name: "greeter", description: "${description}", uses: ["move"] }, { hi: action({ doc: "Returns a greeting.", args: z.object({}), run: () => "hello" }) });\n`;

describe("body API on a body with every feature on", () => {
  let body: Running;
  const ref = referenceKits(["move"]);

  before(async () => {
    body = await startBody({
      kits: ["move"],
      wikiMode: "write",
      stateFiles: {
        "stores/notes.json": {
          oldest: { text: "first", updated: "2020-01-01T00:00:00.000Z" },
          newest: { text: "second", updated: "2020-03-01T00:00:00.000Z" },
          middle: { text: "third", updated: "2020-02-01T00:00:00.000Z" },
        },
      },
    });
  });
  after(() => body.close());

  it("answers GET /health without a token", async () => {
    await body.call("GET", "/health", { body: { name: body.name, connected: false } }, { auth: null });
  });

  it("answers 401 without a token and with a wrong one, on every method and before routing", async () => {
    const unauthorized = { status: 401, body: { error: "missing or invalid bearer token" } };
    await body.call("GET", "/status", unauthorized, { auth: null });
    await body.call("GET", "/status", unauthorized, { auth: "Bearer wrong" });
    await body.call("GET", "/status", unauthorized, { auth: body.token });
    await body.call("POST", "/run", unauthorized, { auth: null, json: { code: "return 1" } });
    await body.call("GET", "/nope", unauthorized, { auth: null });
    await body.call("POST", "/health", unauthorized, { auth: null });
  });

  it("answers 404 for an unknown route or method, whatever the body", async () => {
    await body.call("GET", "/nope", { status: 404, body: NO_ROUTE("GET", "/nope") });
    await body.call("DELETE", "/status", { status: 404, body: NO_ROUTE("DELETE", "/status") });
    await body.call("GET", "/notes/", { status: 404, body: NO_ROUTE("GET", "/notes/") });
    await body.call("POST", "/nope", { status: 404, body: NO_ROUTE("POST", "/nope") }, { raw: "{ not json" });
  });

  it("reads the request body lazily: 404 before 400, 400 for bad JSON, 413 over 1 MiB", async () => {
    // A route that does not exist never reads its body.
    await body.call("POST", "/nope", { status: 404, body: NO_ROUTE("POST", "/nope") }, { raw: "x".repeat(MAX_BODY_BYTES + 1) });
    // A route that takes no body never reads it either.
    await body.call("POST", "/stop", { body: { stopped: false } }, { raw: "x".repeat(MAX_BODY_BYTES + 1) });
    await body.call("PUT", "/notes/lazy", { status: 400, body: { error: "request body is not valid JSON" } }, { raw: "{ not json" });
    await body.call("POST", "/run", { status: 400, body: { error: "request body is not valid JSON" } }, { raw: "nope" });
    // Exactly MAX_BODY_BYTES is read whole (and is not JSON); one byte more is refused.
    await body.call("PUT", "/notes/lazy", { status: 400, body: { error: "request body is not valid JSON" } }, { raw: "x".repeat(MAX_BODY_BYTES) });
    await body.call("PUT", "/notes/lazy", { status: 413, body: { error: "request body too large" } }, { raw: "x".repeat(MAX_BODY_BYTES + 1) });
    await body.call("GET", "/notes/lazy", { status: 404, body: { error: 'no note "lazy"' } });
  });

  it("GET /status: connected false, counters, milestones null", async () => {
    await body.call("GET", "/status", { body: { connected: false, startedAt: "<timestamp>", deaths: 0, reconnects: 0, milestones: null } });
  });

  it("GET /observe and ?brief: the body is disconnected and reconnecting", async () => {
    const observation = { connected: false, reconnecting: true, lastDisconnect: "socketClosed" };
    await body.call("GET", "/observe", { body: observation });
    await body.call("GET", "/observe?brief=0", { body: observation });
    await body.call("GET", "/observe?brief=false", { body: observation });
    await body.call("GET", "/observe?brief=1", { body: { brief: "disconnected, reconnecting (socketClosed)" } });
    await body.call("GET", "/observe?brief=true", { body: { brief: "disconnected, reconnecting (socketClosed)" } });
    await body.call("GET", "/observe?brief=maybe", { status: 400, body: { error: '✖ Invalid option: expected one of "0"|"1"|"true"|"false"\n  → at brief' } });
  });

  it("GET /features and GET /api come from the same features", async () => {
    await body.call("GET", "/features", { body: FEATURES_ALL });
    await body.call("GET", "/api", { body: { doc: programApiDoc(FEATURES_ALL) } });
  });

  it("answers programs, /chat, and /kits/try with 503 while disconnected, and /stop with stopped false", async () => {
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1" } });
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1", timeoutMs: 1000 } });
    await body.call("POST", "/run", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at code" } }, { json: {} });
    await body.call("POST", "/run", { status: 400, body: { error: "✖ Too big: expected number to be <=1800000\n  → at timeoutMs" } }, { json: { code: "x", timeoutMs: 1_800_001 } });
    await body.call("POST", "/chat", { status: 503, body: NOT_CONNECTED }, { json: { message: "hello" } });
    await body.call("POST", "/chat", { status: 400, body: { error: "✖ Too small: expected string to have >=1 characters\n  → at message" } }, { json: { message: "" } });
    await body.call("POST", "/kits/try", { status: 503, body: NOT_CONNECTED }, { json: { source: kitSource("try"), action: "hi" } });
    await body.call("POST", "/kits/try", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at action" } }, { json: { source: kitSource("try") } });
    await body.call("POST", "/stop", { body: { stopped: false } });
  });

  it("notes: list newest first, read, write, delete, and refuse bad keys", async () => {
    const note = (key: string, text: string) => ({ key, text, updated: "<timestamp>" });
    await body.call("GET", "/notes", { body: { notes: [note("newest", "second"), note("middle", "third"), note("oldest", "first")] } });
    await body.call("GET", "/notes/middle", { body: note("middle", "third") });
    await body.call("GET", "/notes/missing", { status: 404, body: { error: 'no note "missing"' } });
    await body.call("PUT", "/notes/places%2Fbase", { body: note("places/base", "x 10 y 64") }, { json: { text: "x 10 y 64" } });
    await body.call("GET", "/notes/places%2Fbase", { body: note("places/base", "x 10 y 64") });
    await body.call("GET", "/notes/places/base", { body: note("places/base", "x 10 y 64") });
    await body.call("GET", "/notes", { body: { notes: [note("places/base", "x 10 y 64"), note("newest", "second"), note("middle", "third"), note("oldest", "first")] } });
    await body.call("PUT", "/notes/middle", { body: note("middle", "changed") }, { json: { text: "changed" } });
    await body.call("PUT", "/notes/Bad", { status: 400, body: { error: JSON.stringify([{ origin: "string", code: "invalid_format", format: "regex", pattern: "/^[a-z0-9][a-z0-9._/-]{0,63}$/", path: [], message: "use 1-64 lowercase letters, digits, and . _ / -; start with a letter or digit" }], null, 2) } }, { json: { text: "x" } });
    await body.call("PUT", "/notes/empty", { status: 400, body: { error: "✖ Too small: expected string to have >=1 characters\n  → at text" } }, { json: { text: "" } });
    await body.call("DELETE", "/notes/places%2Fbase", { body: { deleted: true } });
    await body.call("DELETE", "/notes/places%2Fbase", { body: { deleted: false } });
    await body.call("DELETE", "/notes/middle", { body: { deleted: true } });
    await body.call("GET", "/notes", { body: { notes: [note("newest", "second"), note("oldest", "first")] } });
  });

  it("triggers: add, replace, list, enable, disable, remove; refuse invalid ones and unknown names", async () => {
    const definition = { name: "eat", on: ["hurt"], run: "log('eat')" };
    const listed = (extra: object = {}) => ({
      name: "eat",
      on: ["hurt"],
      run: "log('eat')",
      cooldownMs: 1000,
      timeoutMs: 30_000,
      enabled: true,
      preempt: false,
      priority: 0,
      updated: "<timestamp>",
      fired: 0,
      failures: 0,
      ...extra,
    });
    await body.call("GET", "/triggers", { body: { triggers: [] } });
    await body.call("POST", "/triggers", { body: { trigger: listed(), replaced: false } }, { json: definition });
    await body.call("POST", "/triggers", { body: { trigger: listed({ priority: 5 }), replaced: true } }, { json: { ...definition, priority: 5 } });
    await body.call("GET", "/triggers", { body: { triggers: [listed({ priority: 5 })] } });
    await body.call("POST", "/triggers/enabled", { body: { trigger: listed({ priority: 5, enabled: false }) } }, { json: { name: "eat", enabled: false } });
    await body.call("POST", "/triggers/enabled", { body: { trigger: listed({ priority: 5 }) } }, { json: { name: "eat", enabled: true } });
    await body.call("POST", "/triggers/enabled", { status: 404, body: { error: 'no trigger "ghost"' } }, { json: { name: "ghost", enabled: true } });
    await body.call("POST", "/triggers/enabled", { status: 400, body: { error: "✖ Invalid input: expected boolean, received undefined\n  → at enabled" } }, { json: { name: "eat" } });
    await body.call("POST", "/triggers", { status: 400, body: { error: "✖ Invalid input: expected array, received undefined\n  → at on\n✖ Invalid input: expected string, received undefined\n  → at run" } }, { json: { name: "bad" } });
    await body.call("POST", "/triggers", { status: 400, body: { error: "✖ a trigger cannot listen to trigger events\n  → at on" } }, { json: { ...definition, on: ["trigger_fired"] } });
    await body.call("POST", "/triggers", { status: 400, body: { error: "run does not compile: Unexpected token '}'" } }, { json: { ...definition, name: "broken", run: "log(" } });
    await body.call("POST", "/triggers", { status: 400, body: { error: "when does not compile: Unexpected token ')'" } }, { json: { ...definition, name: "broken", when: "1 +" } });
    await body.call("POST", "/triggers/remove", { status: 404, body: { error: 'no trigger "ghost"' } }, { json: { name: "ghost" } });
    await body.call("POST", "/triggers/remove", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at name" } }, { json: {} });
    await body.call("POST", "/triggers/remove", { body: { removed: "eat" } }, { json: { name: "eat" } });
    await body.call("GET", "/triggers", { body: { triggers: [] } });
  });

  it("milestones: read, set, replace, clear, refuse malformed ones", async () => {
    const stored = { milestones: [{ id: "sticks", description: "Craft a stick", obtained: ["stick"], via: "crafted", count: 4 }] };
    await body.call("GET", "/milestones", { body: { milestones: null } });
    await body.call("PUT", "/milestones", { body: { milestones: stored } }, { json: { milestones: MILESTONES } });
    await body.call("GET", "/milestones", { body: { milestones: stored } });
    await body.call("PUT", "/milestones", { status: 400, body: { error: "✖ Invalid input: expected object, received number\n  → at milestones" } }, { json: { milestones: 1 } });
    await body.call("PUT", "/milestones", { body: { milestones: null } }, { json: { milestones: null } });
    await body.call("GET", "/milestones", { body: { milestones: null } });
  });

  it("kits: list, switch, documentation, search, schemas", async () => {
    const listing = { kits: ref.info(), active: ["move"], locked: false };
    await body.call("GET", "/kits", { body: wire(listing) });
    await body.call("POST", "/kits", { body: wire(listing) }, { json: { use: ["move"] } });
    await body.call("POST", "/kits", { status: 400, body: { error: 'unknown kit "nope"; available: move' } }, { json: { use: ["nope"] } });
    await body.call("POST", "/kits", { status: 400, body: { error: "✖ Too small: expected array to have >=1 items\n  → at use" } }, { json: { use: [] } });
    await body.call("GET", "/kits/docs", { body: { docs: ref.docs([]) } });
    await body.call("GET", "/kits/docs?names=move", { body: { docs: ref.docs(["move"]) } });
    await body.call("GET", "/kits/docs?names=move,", { body: { docs: ref.docs(["move"]) } });
    await body.call("GET", "/kits/docs?names=nope", { status: 400, body: { error: 'unknown kit "nope"; available: move' } });
    await body.call("GET", "/kits/search?q=walk", { body: wire({ hits: ref.search("walk", 5) }) });
    await body.call("GET", "/kits/search?q=walk&limit=1", { body: wire({ hits: ref.search("walk", 1) }) });
    await body.call("GET", "/kits/search", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at q" } });
    await body.call("GET", "/kits/schemas", { body: wire({ kits: ref.schemas() }) });
  });

  it("wiki: list, search, page, lessons", async () => {
    const summary = (id: string, title: string, tags: string[], status: string) => ({ id, title, tags, status });
    const pages = [
      summary("mechanics/kit-use", "Using kits", ["kits"], "unverified"),
      summary("mechanics/saved-kits", "Saving your own kits", ["kits"], "unverified"),
      summary("mechanics/smelting", "Smelting", ["furnace"], "unverified"),
      summary("quirks/drops", "Drops fall out of reach", ["items", "drops"], "verified"),
    ];
    await body.call("GET", "/wiki/list", { body: { pages, mode: "write" } });
    await body.call("GET", "/wiki/list?section=mechanics", { body: { pages: pages.slice(0, 3), mode: "write" } });
    await body.call("GET", "/wiki/list?section=nothing", { body: { pages: [], mode: "write" } });
    await body.call("GET", "/wiki/search?q=drop", { body: { hits: [{ ...pages[3], score: 0.55, snippet: "Walk over the drop to pick it up." }] } });
    await body.call("GET", "/wiki/search?q=kits", { body: { hits: [{ ...pages[1], score: 3.53, snippet: "Save a kit and it joins the active set." }, { ...pages[0], score: 2.97, snippet: "Call kit actions with one object argument." }] } });
    await body.call("GET", "/wiki/search?q=kits&limit=1", { body: { hits: [{ ...pages[1], score: 3.53, snippet: "Save a kit and it joins the active set." }] } });
    await body.call("GET", "/wiki/search?q=zzzz", { body: { hits: [] } });
    await body.call("GET", "/wiki/search", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at q" } });
    await body.call("GET", "/wiki/page?id=mechanics/smelting", {
      body: {
        page: { id: "mechanics/smelting", meta: { title: "Smelting", tags: ["furnace"], verified_by: "body-api test", requires: [] }, status: "unverified", body: "A furnace smelts raw iron into ingots." },
        text: "# Smelting\n[mechanics/smelting | unverified | body-api test]\n\nA furnace smelts raw iron into ingots.",
      },
    });
    await body.call("GET", "/wiki/page?id=smelting", { status: 404, body: { error: 'no wiki page "smelting"; did you mean mechanics/smelting?' } });
    await body.call("GET", "/wiki/page?id=nothing-like-it", { status: 404, body: { error: 'no wiki page "nothing-like-it"; did you mean mechanics/saved-kits, quirks/drops?' } });
    await body.call("GET", "/wiki/page?id=zzzz", { status: 404, body: { error: 'no wiki page "zzzz"' } });
    await body.call("GET", "/wiki/page", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at id" } });
    const lesson = { title: "Mind the lava", tags: ["lava"], body: "Never dig straight down without looking." };
    await body.call("POST", "/wiki/lessons", { body: { id: "lessons/mind-the-lava", title: "Mind the lava", tags: ["lava"], status: "lesson" } }, { json: lesson });
    await body.call("POST", "/wiki/lessons", { body: { id: "lessons/mind-the-lava-2", title: "Mind the lava", tags: ["lava"], status: "lesson" } }, { json: lesson });
    await body.call("POST", "/wiki/lessons", { status: 400, body: { error: "✖ Too small: expected string to have >=3 characters\n  → at title\n✖ Too small: expected string to have >=10 characters\n  → at body" } }, { json: { title: "ab", body: "x" } });
    await body.call("GET", "/wiki/list?section=lessons", {
      body: {
        pages: [
          { id: "lessons/mind-the-lava", title: "Mind the lava", tags: ["lava"], status: "lesson" },
          { id: "lessons/mind-the-lava-2", title: "Mind the lava", tags: ["lava"], status: "lesson" },
        ],
        mode: "write",
      },
    });
  });

  it("GET /events and POST /wait: the first connection attempt's events, and refused queries", async () => {
    await body.call("GET", "/events?limit=0", { status: 400, body: { error: "✖ Too small: expected number to be >0\n  → at limit" } });
    await body.call("GET", "/events?since=-1", { status: 400, body: { error: "✖ Too small: expected number to be >=0\n  → at since" } });
    await body.call("POST", "/wait", { status: 400, body: { error: "✖ must be a regular expression\n  → at match" } }, { json: { match: "(" } });
    await body.call("POST", "/wait", { status: 400, body: { error: "✖ Too small: expected array to have >=1 items\n  → at types" } }, { json: { types: [] } });
  });
});

describe("body API: agent kits", () => {
  let body: Running;

  before(async () => {
    body = await startBody({ kits: ["move"] });
  });
  after(() => body.close());

  it("saves, reads, versions, reverts, and removes a kit; refuses what does not validate", async () => {
    const info = (description: string) => ({ name: "greeter", description, uses: ["move"], active: true, agent: true, actions: ["hi"], stats: {} });
    const version = (n: number, extra: object = {}, current = false) => ({ version: n, savedAt: "<timestamp>", savedBy: body.name, ...extra, current });
    await body.call("GET", "/kits/source?name=greeter", { status: 404, body: { error: 'no kit "greeter"' } });
    await body.call("POST", "/kits/save", { body: { ...info("first"), typeCheck: { status: "passed" } } }, { json: { source: kitSource("first") } });
    await body.call("POST", "/kits/save", { body: { ...info("second"), typeCheck: { status: "passed" } } }, { json: { source: kitSource("second") } });
    await body.call("GET", "/kits/source?name=greeter", { body: { name: "greeter", source: kitSource("second") } });
    await body.call("GET", "/kits/versions?name=greeter", { body: { name: "greeter", versions: [version(1), version(2, {}, true)] } });
    await body.call("POST", "/kits/revert", { body: info("first") }, { json: { name: "greeter", version: 1 } });
    await body.call("GET", "/kits/versions?name=greeter", { body: { name: "greeter", versions: [version(1), version(2), version(3, { revertedFrom: 1 }, true)] } });
    await body.call("POST", "/kits/revert", { status: 400, body: { error: 'kit "greeter" has no version 9; saved versions: 1, 2, 3' } }, { json: { name: "greeter", version: 9 } });
    await body.call("GET", "/kits/versions?name=Bad", { status: 400, body: { error: "✖ use 1-32 lowercase letters, digits, and _; start with a letter\n  → at name" } });
    await body.call("POST", "/kits/save", { status: 400, body: { error: 'kit source must import defineKit from "minebot-sdk/kit" (defineKit, action, and z are no longer globals): import { defineKit, action, z } from "minebot-sdk/kit";' } }, { json: { source: "export default 1" } });
    await body.call("POST", "/kits/save", { status: 400, body: { error: "✖ Too small: expected string to have >=1 characters\n  → at source" } }, { json: { source: "" } });
    await body.call("POST", "/kits/save", { status: 400, body: { error: "kit source matches the escape audit (process); write it without those names" } }, { json: { source: `${kitSource("audited")}// process\n` } });
    await body.call("POST", "/kits/remove", { body: { removed: "greeter" } }, { json: { name: "greeter" } });
    await body.call("GET", "/kits/source?name=greeter", { status: 404, body: { error: 'no kit "greeter"' } });
    // Base behavior, pinned as observed: the library forgets a removed kit at once, but the host keeps offering it (listed, no longer marked as an agent kit, still active) until the body restarts.
    const lingering = { name: "greeter", description: "first", uses: ["move"], active: true, agent: false, actions: ["hi"], stats: {} };
    await body.call("GET", "/kits", { body: { kits: [...wire(referenceKits(["move"]).info()), lingering], active: ["move", "greeter"], locked: false } });
    await body.call("POST", "/kits/remove", { status: 400, body: { error: "✖ use 1-32 lowercase letters, digits, and _; start with a letter\n  → at name" } }, { json: { name: "Bad" } });
  });
});

describe("body API on a body with every optional feature off", () => {
  let body: Running;
  const features: Features = { kits: [], kitsLocked: true, agentKits: false, wiki: "off", lessons: false, milestones: false, triggers: false };

  before(async () => {
    body = await startBody({ kits: [], lockKits: true, wikiMode: "off", milestonesEnabled: false, agentKits: false, triggers: false });
  });
  after(() => body.close());

  it("answers 404 for the routes of every capability the body lacks, before reading their bodies", async () => {
    const absent = (method: string, url: string, call?: Call) => body.call(method, url, { status: 404, body: NO_ROUTE(method, new URL(url, "http://x").pathname) }, call);
    await absent("GET", "/milestones");
    await absent("PUT", "/milestones", { raw: "{ not json" });
    await absent("GET", "/kits");
    await absent("POST", "/kits", { raw: "{ not json" });
    await absent("GET", "/kits/docs?names=move");
    await absent("GET", "/kits/schemas");
    await absent("GET", "/kits/search?q=walk");
    await absent("GET", "/kits/source?name=greeter");
    await absent("POST", "/kits/save", { raw: "{ not json" });
    await absent("POST", "/kits/remove", { json: { name: "greeter" } });
    await absent("GET", "/kits/versions?name=greeter");
    await absent("POST", "/kits/revert", { json: { name: "greeter", version: 1 } });
    await absent("POST", "/kits/try", { raw: "{ not json" });
    await absent("GET", "/triggers");
    await absent("POST", "/triggers", { raw: "{ not json" });
    await absent("POST", "/triggers/remove", { json: { name: "eat" } });
    await absent("POST", "/triggers/enabled", { json: { name: "eat", enabled: true } });
    await absent("GET", "/wiki/search?q=drop");
    await absent("GET", "/wiki/page?id=quirks/drops");
    await absent("GET", "/wiki/list");
    await absent("POST", "/wiki/lessons", { raw: "{ not json" });
  });

  it("still serves the routes every body has, with the features it lacks left out", async () => {
    await body.call("GET", "/features", { body: features });
    await body.call("GET", "/api", { body: { doc: programApiDoc(features) } });
    await body.call("GET", "/status", { body: { connected: false, startedAt: "<timestamp>", deaths: 0, reconnects: 0 } });
    await body.call("GET", "/notes", { body: { notes: [] } });
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1" } });
    await body.call("POST", "/stop", { body: { stopped: false } });
  });
});

describe("body API on a body with locked kits, agent kits off, and a read-only wiki that holds a lesson", () => {
  let body: Running;
  const ref = referenceKits(["move"], true);
  const features: Features = { kits: ["move"], kitsLocked: true, agentKits: false, wiki: "read", lessons: true, milestones: true, triggers: true };

  before(async () => {
    body = await startBody({
      kits: ["move"],
      lockKits: true,
      wikiMode: "read",
      agentKits: false,
      lessonFiles: { "dig-down.md": page("title: Dig down carefully\nverified_by: unreviewed lesson from earlier\nauthor: earlier", "Check the block below before digging.") },
    });
  });
  after(() => body.close());

  it("answers the gated routes: kit switching, agent kits, and lessons are 404; the kits it offers are listed", async () => {
    const absent = (method: string, url: string, call?: Call) => body.call(method, url, { status: 404, body: NO_ROUTE(method, new URL(url, "http://x").pathname) }, call);
    await body.call("GET", "/features", { body: features });
    await body.call("GET", "/api", { body: { doc: programApiDoc(features) } });
    await absent("POST", "/kits", { json: { use: ["move"] } });
    await absent("GET", "/kits/source?name=greeter");
    await absent("POST", "/kits/save", { json: { source: kitSource("x") } });
    await absent("POST", "/kits/remove", { json: { name: "greeter" } });
    await absent("GET", "/kits/versions?name=greeter");
    await absent("POST", "/kits/revert", { json: { name: "greeter", version: 1 } });
    await absent("POST", "/kits/try", { json: { source: kitSource("x"), action: "hi" } });
    await absent("POST", "/wiki/lessons", { json: { title: "A lesson", body: "Some text for the lesson." } });
    await body.call("GET", "/kits", { body: wire({ kits: ref.info(), active: ["move"], locked: true }) });
    await body.call("GET", "/kits/docs", { body: { docs: ref.docs([]) } });
    await body.call("GET", "/kits/search?q=walk&limit=2", { body: wire({ hits: ref.search("walk", 2) }) });
    await body.call("GET", "/kits/schemas", { body: wire({ kits: ref.schemas() }) });
  });

  it("shows the wiki the body's features allow: pages for missing features are hidden, the lesson is listed", async () => {
    await body.call("GET", "/wiki/list", {
      body: {
        pages: [
          { id: "lessons/dig-down", title: "Dig down carefully", tags: [], status: "lesson" },
          { id: "mechanics/kit-use", title: "Using kits", tags: ["kits"], status: "unverified" },
          { id: "mechanics/smelting", title: "Smelting", tags: ["furnace"], status: "unverified" },
          { id: "quirks/drops", title: "Drops fall out of reach", tags: ["items", "drops"], status: "verified" },
        ],
        mode: "read",
      },
    });
  });
});

describe("body API: limits", () => {
  let body: Running;

  before(async () => {
    const notes = Object.fromEntries(Array.from({ length: MAX_NOTES }, (_, i) => [`note-${String(i).padStart(3, "0")}`, { text: `text ${i}`, updated: "2020-01-01T00:00:00.000Z" }]));
    body = await startBody({ stateFiles: { "stores/notes.json": notes } });
  });
  after(() => body.close());

  it("refuses a new note at 200 notes with 409, still updates an existing one, and accepts one again after a delete", async () => {
    const limit = { status: 409, body: { error: `a body keeps at most ${MAX_NOTES} notes; delete or merge some first` } };
    await body.call("PUT", "/notes/one-too-many", limit, { json: { text: "no room" } });
    await body.call("PUT", "/notes/note-000", { body: { key: "note-000", text: "updated", updated: "<timestamp>" } }, { json: { text: "updated" } });
    await body.call("DELETE", "/notes/note-001", { body: { deleted: true } });
    await body.call("PUT", "/notes/one-too-many", { body: { key: "one-too-many", text: "room now", updated: "<timestamp>" } }, { json: { text: "room now" } });
    await body.call("PUT", "/notes/another", limit, { json: { text: "no room again" } });
  });
});

describe("body API: events and waits", () => {
  let body: Running;
  const event = (seq: number, type: string, data: object) => ({ seq, time: "<ms>", type, data });

  before(async () => {
    body = await startBody({
      kits: ["move"],
      stateFiles: { "triggers.json": { broken: { on: "chat", run: "log(1)" } } },
      agentKitFiles: {
        "orphan.ts":
          `import { defineKit, action, z } from "minebot-sdk/kit";\n` +
          `export default defineKit({ name: "orphan", description: "Needs a kit this body does not offer.", uses: ["dig"] }, { hi: action({ doc: "Says hi.", args: z.object({}), run: () => "hi" }) });\n`,
      },
    });
  });
  after(() => body.close());

  // What the body produced from start to its first failed connection attempt, in order, as the normalizer shows it.
  const events = [
    event(1, "trigger_error", { name: "broken", error: "✖ Invalid input: expected array, received string\n  → at on\n✖ Invalid input: expected string, received undefined\n  → at updated" }),
    event(2, "kit_error", { file: "orphan.ts", error: "it uses kits this body does not offer: dig" }),
    event(3, "error", { message: "connect ECONNREFUSED 127.0.0.1:<port>" }),
    event(4, "disconnected", { reason: "socketClosed" }),
    event(5, "reconnect_scheduled", { inMs: 5000, attempt: 1 }),
  ];

  it("lists exactly the startup events, in order, from 0", async () => {
    await body.call("GET", "/events?since=0", { body: { events, next: 5 } });
    await body.call("GET", "/events", { body: { events, next: 5 } });
  });

  it("honors limit and since: the first two events with next at the second, then the rest", async () => {
    await body.call("GET", "/events?since=0&limit=2", { body: { events: events.slice(0, 2), next: 2 } });
    await body.call("GET", "/events?since=2&limit=2", { body: { events: events.slice(2, 4), next: 4 } });
    await body.call("GET", "/events?since=4", { body: { events: events.slice(4), next: 5 } });
    await body.call("GET", "/events?since=5", { body: { events: [], next: 5 } });
  });

  it("restarts from the beginning when the cursor is ahead of the log", async () => {
    await body.call("GET", "/events?since=999", { body: { events, next: 5 } });
    await body.call("GET", "/events?since=999&limit=1", { body: { events: events.slice(0, 1), next: 1 } });
  });

  it("POST /wait returns a buffered matching event with next, and filters by type and message", async () => {
    await body.call("POST", "/wait", { body: { event: events[1], next: 2, timedOut: false } }, { json: { types: ["kit_error"], since: 0, timeoutMs: 5000 } });
    await body.call("POST", "/wait", { body: { event: events[2], next: 3, timedOut: false } }, { json: { since: 2, match: "econnrefused", types: ["error"], timeoutMs: 5000 } });
    await body.call("POST", "/wait", { body: { event: events[3], next: 4, timedOut: false } }, { json: { types: ["disconnected", "error"], since: 3, timeoutMs: 5000 } });
  });

  it("POST /wait times out with the log's end as next, and a cursor ahead of the log starts over", async () => {
    await body.call("POST", "/wait", { body: { event: null, next: 5, timedOut: true } }, { json: { types: ["chat"], since: 0, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: null, next: 5, timedOut: true } }, { json: { types: ["kit_error"], since: 2, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: null, next: 5, timedOut: true } }, { json: { from: "someone", since: 0, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: events[2], next: 3, timedOut: false } }, { json: { types: ["error"], since: 999, timeoutMs: 5000 } });
  });
});

describe("body API: the program history file", () => {
  let body: Running;
  const flagged = "return process.pid";

  const lines = (): unknown[] =>
    readFileSync(body.dirs.history, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => normalize(JSON.parse(line), { token: body.token, ports: body.ports }));

  before(async () => {
    body = await startBody({ kits: ["move"], history: true });
  });
  after(() => body.close());

  it("exists, empty, as soon as the body is up", () => {
    assert.equal(readFileSync(body.dirs.history, "utf8"), "");
  });

  it("writes nothing for an unflagged program that failed to run", async () => {
    assert.deepStrictEqual(findEscapeAttempts("return 1"), []);
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1" } });
    assert.deepStrictEqual(lines(), []);
  });

  it("writes the flagged program's started line before it runs, so a failed run still leaves it, and the failed run consumed a seq", async () => {
    assert.deepStrictEqual(findEscapeAttempts(flagged), ["process"]);
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: flagged } });
    // A run that threw before producing a result has ended: stopping answers at once that nothing runs.
    const stopped = Date.now();
    await body.call("POST", "/stop", { body: { stopped: false } });
    assert.ok(Date.now() - stopped < 1000, "POST /stop answered within a second");
    assert.deepStrictEqual(lines(), [{ seq: 2, startedAt: "<timestamp>", kits: ["move"], code: flagged, escapeAttempts: ["process"], status: "started" }]);
  });

  it("writes one registered line, with the next seq, for a trigger added after it", async () => {
    const trigger = { name: "flagged", on: ["chat"], run: flagged, when: "event.data.from !== 'x'" };
    await body.call("POST", "/triggers", { body: { trigger: { ...trigger, cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "<timestamp>", fired: 0, failures: 0 }, replaced: false } }, { json: trigger });
    assert.deepStrictEqual(lines(), [
      { seq: 2, startedAt: "<timestamp>", kits: ["move"], code: flagged, escapeAttempts: ["process"], status: "started" },
      { seq: 3, startedAt: "<timestamp>", kits: ["move"], code: `${flagged}\n${trigger.when}`, escapeAttempts: ["process"], trigger: "flagged", on: ["chat"], when: trigger.when, status: "registered" },
    ]);
  });

  it("numbers every later program too, flagged or not: an unflagged run leaves no line but takes a seq", async () => {
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 2" } });
    const trigger = { name: "plain", on: ["chat"], run: "log('hi')" };
    await body.call("POST", "/triggers", { body: { trigger: { ...trigger, cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "<timestamp>", fired: 0, failures: 0 }, replaced: false } }, { json: trigger });
    assert.deepStrictEqual(lines().slice(2), [{ seq: 5, startedAt: "<timestamp>", kits: ["move"], code: "log('hi')\n", escapeAttempts: [], trigger: "plain", on: ["chat"], status: "registered" }]);
  });

  it("records a /kits/try as a program: its code, flagged by what it carries", async () => {
    const source = `${kitSource("tried")}// require(\n`;
    const code = `return await kits.try(${JSON.stringify(source)}, ${JSON.stringify({ action: "hi" })});`;
    assert.deepStrictEqual(findEscapeAttempts(code), ["require("]);
    await body.call("POST", "/kits/try", { status: 503, body: NOT_CONNECTED }, { json: { source, action: "hi" } });
    assert.deepStrictEqual(lines().slice(3), [{ seq: 6, startedAt: "<timestamp>", kits: ["move"], code, escapeAttempts: ["require("], status: "started" }]);
  });
});

describe("body API: the wiki is the repository's by default", () => {
  let body: Running;

  before(async () => {
    body = await startBody({ repositoryWiki: true });
  });
  after(() => body.close());

  it("serves the repository's curated pages when no wiki directory is given", async () => {
    const reply = await body.send("GET", "/wiki/list");
    assert.equal(reply.status, 200);
    const { pages, mode } = z.object({ pages: z.array(z.object({ id: z.string() })), mode: z.string() }).parse(reply.body);
    assert.equal(mode, "read");
    assert.ok(pages.some((p) => p.id === "minebot/kits"), "the repository's minebot/kits page is listed");
    assert.ok(!pages.some((p) => p.id === "quirks/drops"), "the fixture wiki is not in use");
  });
});

describe("body API: start and stop", () => {
  const base = {
    username: "charz-start",
    auth: "offline" as const,
    host: "127.0.0.1",
    apiHost: "127.0.0.1",
    apiPort: 0,
    lockKits: false,
    wikiMode: "off" as const,
    milestonesEnabled: true,
    agentKits: true,
  };
  let sequenceNumber = 0;
  const options = async (extra: Partial<DaemonOptions>): Promise<DaemonOptions> => {
    const dir = mkdtempSync(path.join(ROOT, "start-"));
    return { ...base, name: `charz-start-${++sequenceNumber}`, port: await refusedPort(), stateDir: path.join(dir, "state"), ...extra };
  };

  it("rejects an unknown kit with the available ones named, and publishes nothing", async () => {
    const opts = await options({ kits: ["nope"] });
    await assert.rejects(startDaemon(opts), { message: `unknown built-in kit "nope"; available: ${BUILTIN_KITS.map((kit) => kit.name).join(", ")}` });
    assert.equal(existsSync(endpointFile(opts.name)), false);
  });

  it("rejects a non-loopback API address without an explicit token, and publishes nothing", async () => {
    const opts = await options({ apiHost: "0.0.0.0" });
    await assert.rejects(startDaemon(opts), { message: "refusing to serve the body API on 0.0.0.0 without an explicit token" });
    assert.equal(existsSync(endpointFile(opts.name)), false);
  });

  it("rejects milestones given to a body that has them disabled", async () => {
    const opts = await options({ milestonesEnabled: false, milestones: { milestones: [{ id: "a", description: "d", obtained: ["stick"], via: "gathered", count: 1 }] } });
    await assert.rejects(startDaemon(opts), { message: "milestones were given to a body that has milestones disabled" });
    assert.equal(existsSync(endpointFile(opts.name)), false);
  });

  it("publishes the endpoint file while up, and removes it and frees the API port on close", async () => {
    const opts = await options({ token: "fixed-token" });
    const daemon = await startDaemon(opts);
    const file = endpointFile(opts.name);
    try {
      await awaitEvent(daemon.endpoint.url, "fixed-token", "reconnect_scheduled");
      const ports = [opts.port, Number(new URL(daemon.endpoint.url).port)];
      const published = JSON.parse(readFileSync(file, "utf8"));
      assert.deepStrictEqual(published, daemon.endpoint);
      assert.deepStrictEqual(normalize(published, { token: "fixed-token", ports }), {
        name: opts.name,
        url: "http://127.0.0.1:<port>",
        token: "<token>",
        pid: process.pid,
        mcVersion: MC_VERSION,
        server: { host: "127.0.0.1", port: "<port>" },
      });
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const health = await fetch(`${daemon.endpoint.url}/health`);
      assert.deepStrictEqual(await health.json(), { name: opts.name, connected: false });
    } finally {
      await daemon.close();
      releaseLongTimers();
    }
    assert.equal(existsSync(file), false);
    await assert.rejects(fetch(`${daemon.endpoint.url}/health`), (error: unknown) => error instanceof Error && error.cause instanceof Error && "code" in error.cause && error.cause.code === "ECONNREFUSED");
  });

  it("generates a token when none is given, and serves with it", async () => {
    const opts = await options({});
    const daemon = await startDaemon(opts);
    try {
      await awaitEvent(daemon.endpoint.url, daemon.endpoint.token, "reconnect_scheduled");
      assert.match(daemon.endpoint.token, /^[0-9a-f]{64}$/);
      const response = await fetch(`${daemon.endpoint.url}/notes`, { headers: { authorization: `Bearer ${daemon.endpoint.token}` } });
      assert.deepStrictEqual({ status: response.status, body: await response.json() }, { status: 200, body: { notes: [] } });
    } finally {
      await daemon.close();
      releaseLongTimers();
    }
  });
});

describe("body API: every route has been exercised", () => {
  it("reached each route of the table on a body that serves it", () => {
    assert.deepStrictEqual(
      ROUTES.filter((route) => !reached.has(route)),
      [],
    );
  });
});
