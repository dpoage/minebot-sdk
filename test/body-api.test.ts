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
import type { BodyFeatures, Capability } from "../src/protocol/index.ts";

// Everything the suite writes lives under ROOT, the typechecker's scratch directories included.
const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-body-api-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
process.env.TMPDIR = ROOT;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads, so nothing that reaches it loads before the line above.
const { startDaemon } = await import("../src/body/daemon.ts");
const { endpointFile, programApiDoc } = await import("../src/protocol/index.ts");
const { MC_VERSION } = await import("../src/mc/version.ts");
const { BUILTIN_MODULES } = await import("../src/routines/index.ts");
const { JsonStore } = await import("../src/store.ts");
const { Builtins } = await import("../src/host/routines/builtins.ts");
const { KitStats } = await import("../src/host/routines/stats.ts");
const { findEscapeAttempts } = await import("../src/audit.ts");

type Features = BodyFeatures;

/** The largest request body the API reads (MAX_BODY_BYTES in src/body/http.ts). */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NOTES = 200;
const MAX_TRIGGERS = 50;

// minecraft-protocol arms a 30 s timer when a client ends and keeps the process alive for it. The
// suite unrefs those timers, and only those, once their body is closed, so the test process exits
// when its tests do; any other timer a closed body leaves running still holds the process.
interface DelayedTimer extends NodeJS.Timeout {
  /** Node's own record of the delay; not in the public typings. */
  _idleTimeout: number;
}
const MINECRAFT_PROTOCOL_FRAME = /[\\/]node_modules[\\/]minecraft-protocol[\\/]/;
/** Whether minecraft-protocol's code is on the stack that is creating the timer. */
function createdByMinecraftProtocol(): boolean {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const site: { stack?: string } = {};
  Error.captureStackTrace(site);
  Error.stackTraceLimit = limit;
  return MINECRAFT_PROTOCOL_FRAME.test(site.stack ?? "");
}
const longTimers: NodeJS.Timeout[] = [];
createHook({
  init(_id, type, _trigger, resource) {
    if (type === "Timeout" && (resource as DelayedTimer)._idleTimeout >= 30_000 && createdByMinecraftProtocol()) longTimers.push(resource as NodeJS.Timeout);
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
  "GET /wiki/search",
  "GET /wiki/page",
  "GET /wiki/list",
  "POST /wiki/lessons",
  "GET /routines",
  "GET /routines/source",
  "POST /routines/save",
  "GET /routines/versions",
  "POST /routines/revert",
  "GET /bindings",
  "POST /bind",
  "POST /unbind",
  "POST /call",
  "GET /builtins",
  "GET /builtins/docs",
  "GET /builtins/search",
  "GET /builtins/source",
] as const;

/** The routes a request reached in a body that serves them (not the missing-token or unknown-route answer). */
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
  dirs: { state: string; history: string; lessons: string; wiki: string };
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
    "mechanics/kit-use.md": page("title: Using kits\ntags: [kits]\nverified_by: body-api test\nrequires: [builtins]", "Call kit actions with one object argument."),
    "mechanics/saved-kits.md": page("title: Saving your own kits\ntags: [kits]\nverified_by: body-api test\nrequires: [routines]", "Save a kit and it joins the active set."),
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
  };
  writeFixtureWiki(dirs.wiki);
  if (scenario.stateFiles) writeTree(dirs.state, scenario.stateFiles);
  if (scenario.lessonFiles) writeTree(dirs.lessons, scenario.lessonFiles);
  const { stateFiles: _state, lessonFiles: _lessons, history, repositoryWiki, ...options } = scenario;
  const mcPort = await refusedPort();
  const daemon = await startDaemon({
    username: name,
    auth: "offline",
    wikiMode: "read",
    milestonesEnabled: true,
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
      // Neither the answer to a missing token nor the unknown-route answer comes from the route.
      const error = typeof actual.body === "object" && actual.body !== null && "error" in actual.body ? String(actual.body.error) : "";
      if (actual.status !== 401 && !error.startsWith("no route for")) reached.add(routeKey(method, url));
    },
    async close() {
      await daemon.close();
      releaseLongTimers();
    },
  };
  return running;
}

const ALL_BUILTINS = BUILTIN_MODULES.map((module) => module.name);
const FEATURES_ALL: Features = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ALL_BUILTINS };

const NOT_CONNECTED = { error: "the body is not connected to a server" };
const NO_ROUTE = (method: string, pathname: string) => ({ error: `no route for ${method} ${pathname}` });
const MILESTONES = { milestones: [{ id: "sticks", description: "Craft a stick", obtained: ["stick"], via: "crafted", count: 4 }] };

describe("body API on a body with every feature on", () => {
  let body: Running;

  before(async () => {
    body = await startBody({
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
    await body.call("POST", "/call", unauthorized, { auth: null, json: { name: "act" } });
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
    await body.call("POST", "/call", { status: 400, body: { error: "request body is not valid JSON" } }, { raw: "nope" });
    // Exactly MAX_BODY_BYTES is read whole (and is not JSON); one byte more is refused.
    await body.call("PUT", "/notes/lazy", { status: 400, body: { error: "request body is not valid JSON" } }, { raw: "x".repeat(MAX_BODY_BYTES) });
    await body.call("PUT", "/notes/lazy", { status: 413, body: { error: "request body too large" } }, { raw: "x".repeat(MAX_BODY_BYTES + 1) });
    await body.call("GET", "/notes/lazy", { status: 404, body: { error: 'no note "lazy"' } });
  });

  it("reads an empty request body as an empty object", async () => {
    const missing = (field: string) => ({ status: 400, body: { error: `✖ Invalid input: expected string, received undefined\n  → at ${field}` } });
    await body.call("PUT", "/notes/empty-body", missing("text"));
    await body.call("PUT", "/notes/empty-body", missing("text"), { raw: "" });
    await body.call("POST", "/unbind", missing("name"));
    await body.call("POST", "/unbind", missing("name"), { raw: "" });
    await body.call("POST", "/run", missing("code"));
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

  it("answers programs and /chat with 503 while disconnected, and /stop with stopped false", async () => {
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1" } });
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1", timeoutMs: 1000 } });
    await body.call("POST", "/run", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at code" } }, { json: {} });
    await body.call("POST", "/run", { status: 400, body: { error: "✖ Too big: expected number to be <=1800000\n  → at timeoutMs" } }, { json: { code: "x", timeoutMs: 1_800_001 } });
    await body.call("POST", "/chat", { status: 503, body: NOT_CONNECTED }, { json: { message: "hello" } });
    await body.call("POST", "/chat", { status: 400, body: { error: "✖ Too small: expected string to have >=1 characters\n  → at message" } }, { json: { message: "" } });
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

  it("answers the routes of the code triggers like any unknown route, whatever the body offers", async () => {
    for (const [method, url] of [["GET", "/triggers"], ["POST", "/triggers"], ["POST", "/triggers/remove"], ["POST", "/triggers/enabled"]] as const) {
      await body.call(method, url, { status: 404, body: NO_ROUTE(method, url) }, method === "POST" ? { json: { name: "eat", on: ["hurt"], run: "log('eat')", enabled: true } } : undefined);
    }
  });

  it("answers the routes of the kits like any unknown route, whatever the body offers", async () => {
    for (const [method, url] of [
      ["GET", "/kits"],
      ["POST", "/kits"],
      ["GET", "/kits/docs"],
      ["GET", "/kits/schemas"],
      ["GET", "/kits/source?name=greeter"],
      ["POST", "/kits/save"],
      ["POST", "/kits/remove"],
      ["GET", "/kits/search?q=walk"],
      ["GET", "/kits/versions?name=greeter"],
      ["POST", "/kits/revert"],
      ["POST", "/kits/try"],
    ] as const) {
      await body.call(method, url, { status: 404, body: NO_ROUTE(method, new URL(url, "http://x").pathname) }, method === "POST" ? { json: { use: ["move"] } } : undefined);
    }
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

  it("builtins: list, documentation, search, source, each from the catalog and refusing what is not offered", async () => {
    const reference = new Builtins({ stats: new KitStats(JsonStore.memory()) });
    await body.call("GET", "/builtins", { body: wire({ builtins: reference.list() }) });
    await body.call("GET", "/builtins/docs", { body: { docs: reference.docs([]) } });
    await body.call("GET", "/builtins/docs?names=move", { body: { docs: reference.docs(["move"]) } });
    await body.call("GET", "/builtins/docs?names=move,", { body: { docs: reference.docs(["move"]) } });
    await body.call("GET", "/builtins/docs?names=nope", { status: 400, body: { error: `unknown built-in module "nope"; offered: ${ALL_BUILTINS.join(", ")}` } });
    await body.call("GET", "/builtins/search?q=walk", { body: wire({ hits: reference.search("walk", 5) }) });
    await body.call("GET", "/builtins/search?q=walk&limit=1", { body: wire({ hits: reference.search("walk", 1) }) });
    await body.call("GET", "/builtins/search", { status: 400, body: { error: "✖ Invalid input: expected string, received undefined\n  → at q" } });
    await body.call("GET", "/builtins/source?name=move", { body: { name: "move", source: readFileSync(path.join(import.meta.dirname, "..", "src", "routines", "move.ts"), "utf8") } });
    await body.call("GET", "/builtins/source?name=nope", { status: 404, body: { error: 'no built-in module "nope"' } });
    await body.call("GET", "/builtins/source?name=Bad", { status: 400, body: ROUTINE_NAME_RULE.body });
  });

  it("POST /call of a built-in: the routine's own 503 while disconnected, 404 naming every dotted name that is not an offered routine, 400 for a name of neither form", async () => {
    await body.call("POST", "/call", { status: 503, body: NOT_CONNECTED }, { json: { name: "move.to", args: { position: [1, 2, 3] } } });
    for (const name of ["move.nope", "nope.to", "move.to.again", "move.constructor", "Move.to"]) {
      await body.call("POST", "/call", { status: 404, body: { error: `no built-in routine "${name}"` } }, { json: { name } });
    }
    await body.call("POST", "/call", { status: 404, body: { error: 'no action bound to "act"' } }, { json: { name: "act" } });
    await body.call("POST", "/call", { status: 400, body: { error: CALL_NAME_RULE } }, { json: { name: "Bad name" } });
  });

  it("GET /events and POST /wait: the first connection attempt's events, and refused queries", async () => {
    await body.call("GET", "/events?limit=0", { status: 400, body: { error: "✖ Too small: expected number to be >0\n  → at limit" } });
    await body.call("GET", "/events?since=-1", { status: 400, body: { error: "✖ Too small: expected number to be >=0\n  → at since" } });
    await body.call("POST", "/wait", { status: 400, body: { error: "✖ must be a regular expression\n  → at match" } }, { json: { match: "(" } });
    await body.call("POST", "/wait", { status: 400, body: { error: "✖ Too small: expected array to have >=1 items\n  → at types" } }, { json: { types: [] } });
  });
});

describe("body API on a body with every optional feature off", () => {
  let body: Running;
  const features: Features = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };

  before(async () => {
    body = await startBody({ wikiMode: "off", milestonesEnabled: false, triggers: false, routines: false, builtins: [] });
  });
  after(() => body.close());

  it("answers 404 for the routes of every capability the body lacks, before reading their bodies", async () => {
    const absent = (method: string, url: string, call?: Call) => body.call(method, url, { status: 404, body: NO_ROUTE(method, new URL(url, "http://x").pathname) }, call);
    await absent("GET", "/milestones");
    await absent("PUT", "/milestones", { raw: "{ not json" });
    await absent("GET", "/triggers");
    await absent("POST", "/triggers", { raw: "{ not json" });
    await absent("POST", "/triggers/remove", { json: { name: "eat" } });
    await absent("POST", "/triggers/enabled", { json: { name: "eat", enabled: true } });
    await absent("GET", "/wiki/search?q=drop");
    await absent("GET", "/wiki/page?id=quirks/drops");
    await absent("GET", "/wiki/list");
    await absent("POST", "/wiki/lessons", { raw: "{ not json" });
    await absent("GET", "/routines");
    await absent("GET", "/routines/source?name=act");
    await absent("POST", "/routines/save", { raw: "{ not json" });
    await absent("GET", "/routines/versions?name=act");
    await absent("POST", "/routines/revert", { json: { name: "act", version: 1 } });
    await absent("GET", "/bindings");
    await absent("POST", "/bind", { raw: "{ not json" });
    await absent("POST", "/unbind", { json: { name: "act" } });
    await absent("POST", "/call", { json: { name: "act" } });
    await absent("GET", "/builtins");
    await absent("GET", "/builtins/docs?names=move");
    await absent("GET", "/builtins/search?q=walk");
    await absent("GET", "/builtins/source?name=move");
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

describe("body API on a body without routines and with a read-only wiki that holds a lesson", () => {
  let body: Running;
  const features: Features = { wiki: "read", lessons: true, milestones: true, reflexes: true, routines: false, builtins: ALL_BUILTINS };

  before(async () => {
    body = await startBody({
      wikiMode: "read",
      routines: false,
      lessonFiles: { "dig-down.md": page("title: Dig down carefully\nverified_by: unreviewed lesson from earlier\nauthor: earlier", "Check the block below before digging.") },
    });
  });
  after(() => body.close());

  it("answers the gated routes: the lessons of a read-only wiki and the routine library are 404", async () => {
    const absent = (method: string, url: string, call?: Call) => body.call(method, url, { status: 404, body: NO_ROUTE(method, new URL(url, "http://x").pathname) }, call);
    await body.call("GET", "/features", { body: features });
    await body.call("GET", "/api", { body: { doc: programApiDoc(features) } });
    await absent("POST", "/wiki/lessons", { json: { title: "A lesson", body: "Some text for the lesson." } });
    await absent("GET", "/routines");
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

/** One request to a capability-gated route, and what the route answers on a body that serves it. */
interface GatedProbe {
  capability: Capability;
  method: string;
  url: string;
  call?: Call;
  served: (features: Features) => Expected;
}

const ROUTINE_NAME_RULE = { status: 400, body: { error: "✖ use 1-48 lowercase letters, digits, _ and -; start with a letter\n  → at name" } };
const CALL_NAME_RULE = "✖ use an action's name (1-48 lowercase letters, digits, _ and -; start with a letter) or a built-in routine's <module>.<routine>\n  → at name";

/** Every capability-gated route of the table, once, with a request whose answer does not depend on which other capabilities the body offers. */
const GATED: GatedProbe[] = [
  { capability: "milestones", method: "GET", url: "/milestones", served: () => ({ body: { milestones: null } }) },
  { capability: "milestones", method: "PUT", url: "/milestones", call: { json: { milestones: null } }, served: () => ({ body: { milestones: null } }) },
  { capability: "wiki", method: "GET", url: "/wiki/search?q=zzzz", served: () => ({ body: { hits: [] } }) },
  {
    capability: "wiki",
    method: "GET",
    url: "/wiki/page?id=mechanics/smelting",
    served: () => ({
      body: {
        page: { id: "mechanics/smelting", meta: { title: "Smelting", tags: ["furnace"], verified_by: "body-api test", requires: [] }, status: "unverified", body: "A furnace smelts raw iron into ingots." },
        text: "# Smelting\n[mechanics/smelting | unverified | body-api test]\n\nA furnace smelts raw iron into ingots.",
      },
    }),
  },
  { capability: "wiki", method: "GET", url: "/wiki/list?section=quirks", served: (f) => ({ body: { pages: [{ id: "quirks/drops", title: "Drops fall out of reach", tags: ["items", "drops"], status: "verified" }], mode: f.wiki } }) },
  { capability: "lessons", method: "POST", url: "/wiki/lessons", call: { json: { title: "ab", body: "x" } }, served: () => ({ status: 400, body: { error: "✖ Too small: expected string to have >=3 characters\n  → at title\n✖ Too small: expected string to have >=10 characters\n  → at body" } }) },
  { capability: "routines", method: "GET", url: "/routines", served: () => ({ body: { routines: [] } }) },
  { capability: "routines", method: "GET", url: "/routines/source?name=ghost", served: () => ({ status: 404, body: { error: 'no routine "ghost"' } }) },
  { capability: "routines", method: "POST", url: "/routines/save", call: { json: { name: "Bad", source: "" } }, served: () => ROUTINE_NAME_RULE },
  { capability: "routines", method: "GET", url: "/routines/versions?name=Bad", served: () => ROUTINE_NAME_RULE },
  { capability: "routines", method: "POST", url: "/routines/revert", call: { json: { name: "Bad", version: 1 } }, served: () => ROUTINE_NAME_RULE },
  { capability: "routines", method: "GET", url: "/bindings", served: () => ({ body: { bindings: [] } }) },
  { capability: "routines", method: "POST", url: "/bind", call: { json: { kind: "action", name: "act", routine: "ghost" } }, served: () => ({ status: 404, body: { error: 'no routine named "ghost"' } }) },
  { capability: "routines", method: "POST", url: "/unbind", call: { json: { name: "ghost" } }, served: () => ({ status: 404, body: { error: 'no binding "ghost"' } }) },
  // Served when the body has actions or built-ins; a dot-free name is an action's, which a body without routines does not keep.
  { capability: "call", method: "POST", url: "/call", call: { json: { name: "ghost" } }, served: (f) => ({ status: 404, body: { error: f.routines ? 'no action bound to "ghost"' : 'no action named "ghost": this body has no routine library; built-in routines are called as <module>.<routine>' } }) },
  { capability: "builtins", method: "GET", url: "/builtins", served: () => ({ body: wire({ builtins: new Builtins({ stats: new KitStats(JsonStore.memory()) }).list() }) }) },
  { capability: "builtins", method: "GET", url: "/builtins/docs?names=move", served: () => ({ body: { docs: new Builtins({ stats: new KitStats(JsonStore.memory()) }).docs(["move"]) } }) },
  { capability: "builtins", method: "GET", url: "/builtins/search?q=walk&limit=1", served: () => ({ body: wire({ hits: new Builtins({ stats: new KitStats(JsonStore.memory()) }).search("walk", 1) }) }) },
  { capability: "builtins", method: "GET", url: "/builtins/source?name=nope", served: () => ({ status: 404, body: { error: 'no built-in module "nope"' } }) },
];

/** A body that offers every capability; each profile below turns one off. */
const EVERY_CAPABILITY: Scenario = { wikiMode: "write", milestonesEnabled: true, triggers: true };

interface Profile {
  /** The capabilities the body lacks: the one turned off, and those that cannot be on without it. */
  off: Capability[];
  scenario: Scenario;
  features: Features;
}

// Each capability off on its own, every other one on. A body without a wiki lacks lessons too
// (CAPABILITY_GATES); the profile that turns off lessons alone tells the pair apart.
const PROFILES: Profile[] = [
  { off: ["wiki", "lessons"], scenario: { wikiMode: "off" }, features: { ...FEATURES_ALL, wiki: "off", lessons: false } },
  { off: ["lessons"], scenario: { wikiMode: "read" }, features: { ...FEATURES_ALL, wiki: "read", lessons: false } },
  { off: ["milestones"], scenario: { milestonesEnabled: false }, features: { ...FEATURES_ALL, milestones: false } },
  { off: ["reflexes"], scenario: { triggers: false }, features: { ...FEATURES_ALL, reflexes: false } },
  { off: ["routines"], scenario: { routines: false }, features: { ...FEATURES_ALL, routines: false } },
  { off: ["builtins"], scenario: { builtins: [] }, features: { ...FEATURES_ALL, builtins: [] } },
];

describe("body API: each capability gates exactly its own routes", () => {
  for (const profile of PROFILES) {
    describe(`on a body without ${profile.off.join(", ")}`, () => {
      let body: Running;

      before(async () => {
        body = await startBody({ ...EVERY_CAPABILITY, ...profile.scenario });
      });
      after(() => body.close());

      it("answers 404 on the routes of the capabilities it lacks and serves every other gated route", async () => {
        await body.call("GET", "/features", { body: profile.features });
        for (const probe of GATED) {
          const absent = { status: 404, body: NO_ROUTE(probe.method, new URL(probe.url, "http://x").pathname) };
          await body.call(probe.method, probe.url, profile.off.includes(probe.capability) ? absent : probe.served(profile.features), probe.call);
        }
      });
    });
  }
});

describe("body API: limits", () => {
  let body: Running;

  before(async () => {
    const notes = Object.fromEntries(Array.from({ length: MAX_NOTES }, (_, i) => [`note-${String(i).padStart(3, "0")}`, { text: `text ${i}`, updated: "2020-01-01T00:00:00.000Z" }]));
    body = await startBody({ stateFiles: { "stores/notes.json": notes, "routines/r1.ts": "export default () => 1;\n" } });
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

  it("refuses a new reflex at 50 reflexes with 409", async () => {
    const reflex = (name: string) => ({ kind: "reflex", name, routine: "r1", on: ["hurt"], cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "<timestamp>", fired: 0, failures: 0 });
    for (let i = 0; i < MAX_TRIGGERS; i++) {
      await body.call("POST", "/bind", { body: { binding: reflex(`t${i}`), replaced: false } }, { json: { kind: "reflex", name: `t${i}`, routine: "r1", on: ["hurt"] } });
    }
    await body.call("POST", "/bind", { status: 409, body: { error: `a body keeps at most ${MAX_TRIGGERS} reflexes, and stored entries it skipped at start count with them; unbind some first` } }, { json: { kind: "reflex", name: "one-too-many", routine: "r1", on: ["hurt"] } });
  });
});

describe("body API: reflexes", () => {
  let body: Running;
  const reflex = (name: string, on: string[] = ["hurt"]) => ({ kind: "reflex", name, routine: "r1", on, cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "<timestamp>", fired: 0, failures: 0 });

  before(async () => {
    body = await startBody({ stateFiles: { "routines/r1.ts": "export default () => 1;\n" } });
  });
  after(() => body.close());

  it("binds, lists, and unbinds a reflex among the bindings", async () => {
    await body.call("POST", "/bind", { body: { binding: reflex("rfx"), replaced: false } }, { json: { kind: "reflex", name: "rfx", routine: "r1", on: ["hurt"] } });
    await body.call("POST", "/bind", { body: { binding: reflex("rfx", ["chat"]), replaced: true } }, { json: { kind: "reflex", name: "rfx", routine: "r1", on: ["chat"] } });
    await body.call("GET", "/bindings", { body: { bindings: [reflex("rfx", ["chat"])] } });
    await body.call("POST", "/unbind", { body: { unbound: "rfx" } }, { json: { name: "rfx" } });
    await body.call("GET", "/bindings", { body: { bindings: [] } });
  });

  it("refuses a reflex that does not validate with 400 and an unknown routine with 404", async () => {
    await body.call("POST", "/bind", { status: 400, body: { error: "✖ Invalid input: expected array, received undefined\n  → at on" } }, { json: { kind: "reflex", name: "rfx", routine: "r1" } });
    await body.call("POST", "/bind", { status: 400, body: { error: "✖ a reflex cannot listen to reflex events\n  → at on" } }, { json: { kind: "reflex", name: "rfx", routine: "r1", on: ["reflex_fired"] } });
    // The syntax error's own text is the JavaScript engine's.
    const syntax = await body.send("POST", "/bind", { json: { kind: "reflex", name: "rfx", routine: "r1", on: ["hurt"], when: "event.data <" } });
    assert.equal(syntax.status, 400);
    assert.match(JSON.stringify(syntax.body), /^\{"error":"when does not compile: /);
    await body.call("POST", "/bind", { status: 404, body: { error: 'no routine named "ghost"' } }, { json: { kind: "reflex", name: "rfx", routine: "ghost", on: ["hurt"] } });
    await body.call("GET", "/bindings", { body: { bindings: [] } });
  });

  it("counts reflexes toward a limit of 50, and a reflex bound again is not a new one", async () => {
    for (let i = 0; i < MAX_TRIGGERS; i++) {
      await body.call("POST", "/bind", { body: { binding: reflex(`t${i}`), replaced: false } }, { json: { kind: "reflex", name: `t${i}`, routine: "r1", on: ["hurt"] } });
    }
    const full = { status: 409, body: { error: `a body keeps at most ${MAX_TRIGGERS} reflexes, and stored entries it skipped at start count with them; unbind some first` } };
    await body.call("POST", "/bind", full, { json: { kind: "reflex", name: "one-too-many", routine: "r1", on: ["hurt"] } });
    await body.call("POST", "/bind", { body: { binding: reflex("t1", ["chat"]), replaced: true } }, { json: { kind: "reflex", name: "t1", routine: "r1", on: ["chat"] } });
  });
});

describe("body API: events and waits", () => {
  let body: Running;
  const event = (seq: number, type: string, data: object) => ({ seq, time: "<ms>", type, data });

  before(async () => {
    body = await startBody({ stateFiles: { "triggers.json": { broken: { on: "chat", routine: "r1" } } } });
  });
  after(() => body.close());

  // What the body produced from start to its first failed connection attempt, in order, as the normalizer shows it.
  const events = [
    event(1, "reflex_error", { name: "broken", error: "✖ Invalid input: expected array, received string\n  → at on\n✖ Invalid input: expected string, received undefined\n  → at updated" }),
    event(2, "error", { message: "connect ECONNREFUSED 127.0.0.1:<port>" }),
    event(3, "disconnected", { reason: "socketClosed" }),
    event(4, "reconnect_scheduled", { inMs: 5000, attempt: 1 }),
  ];

  it("lists exactly the startup events, in order, from 0", async () => {
    await body.call("GET", "/events?since=0", { body: { events, next: 4 } });
    await body.call("GET", "/events", { body: { events, next: 4 } });
  });

  it("honors limit and since: the first two events with next at the second, then the rest", async () => {
    await body.call("GET", "/events?since=0&limit=2", { body: { events: events.slice(0, 2), next: 2 } });
    await body.call("GET", "/events?since=2&limit=2", { body: { events: events.slice(2, 4), next: 4 } });
    await body.call("GET", "/events?since=3", { body: { events: events.slice(3), next: 4 } });
    await body.call("GET", "/events?since=4", { body: { events: [], next: 4 } });
  });

  it("restarts from the beginning when the cursor is ahead of the log", async () => {
    await body.call("GET", "/events?since=999", { body: { events, next: 4 } });
    await body.call("GET", "/events?since=999&limit=1", { body: { events: events.slice(0, 1), next: 1 } });
  });

  it("POST /wait returns a buffered matching event with next, and filters by type and message", async () => {
    await body.call("POST", "/wait", { body: { event: events[0], next: 1, timedOut: false } }, { json: { types: ["reflex_error"], since: 0, timeoutMs: 5000 } });
    await body.call("POST", "/wait", { body: { event: events[1], next: 2, timedOut: false } }, { json: { since: 1, match: "econnrefused", types: ["error"], timeoutMs: 5000 } });
    await body.call("POST", "/wait", { body: { event: events[2], next: 3, timedOut: false } }, { json: { types: ["disconnected", "error"], since: 2, timeoutMs: 5000 } });
  });

  it("POST /wait times out with the log's end as next, and a cursor ahead of the log starts over", async () => {
    await body.call("POST", "/wait", { body: { event: null, next: 4, timedOut: true } }, { json: { types: ["chat"], since: 0, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: null, next: 4, timedOut: true } }, { json: { types: ["reflex_error"], since: 1, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: null, next: 4, timedOut: true } }, { json: { from: "someone", since: 0, timeoutMs: 50 } });
    await body.call("POST", "/wait", { body: { event: events[1], next: 2, timedOut: false } }, { json: { types: ["error"], since: 999, timeoutMs: 5000 } });
  });

  it("POST /wait without since waits for new events only: a buffered match is not returned", async () => {
    await body.call("POST", "/wait", { body: { event: null, next: 4, timedOut: true } }, { json: { types: ["error"], timeoutMs: 50 } });
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
    body = await startBody({ history: true, stateFiles: { "bindings.json": { act: { kind: "action", routine: "act" } }, "routines/r1.ts": "export default () => 1;\n" } });
  });
  after(() => body.close());

  it("exists, empty, as soon as the body is up", () => {
    assert.equal(readFileSync(body.dirs.history, "utf8"), "");
  });

  it("writes nothing for an unflagged program that failed to run", async () => {
    assert.deepStrictEqual(findEscapeAttempts("return 1"), []);
    await body.call("POST", "/call", { status: 503, body: NOT_CONNECTED }, { json: { name: "act" } });
    assert.deepStrictEqual(lines(), []);
  });

  it("writes a started line for a flagged program whose run failed, numbered with the seq the run consumed; /stop then answers at once", async () => {
    assert.deepStrictEqual(findEscapeAttempts(flagged), ["process"]);
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: flagged } });
    // A run that threw before producing a result has ended: stopping answers at once that nothing runs.
    const stopped = Date.now();
    await body.call("POST", "/stop", { body: { stopped: false } });
    assert.ok(Date.now() - stopped < 1000, "POST /stop answered within a second");
    assert.deepStrictEqual(lines(), [{ seq: 2, startedAt: "<timestamp>", code: flagged, escapeAttempts: ["process"], status: "started" }]);
  });

  it("records no program_finished event for a run that failed to start", async () => {
    const event = (seq: number, type: string, data: object) => ({ seq, time: "<ms>", type, data });
    await body.call("GET", "/events", {
      body: {
        events: [event(1, "error", { message: "connect ECONNREFUSED 127.0.0.1:<port>" }), event(2, "disconnected", { reason: "socketClosed" }), event(3, "reconnect_scheduled", { inMs: 5000, attempt: 1 })],
        next: 3,
      },
    });
  });

  it("numbers every later program too, flagged or not: an unflagged run leaves no line but takes a seq, and a reflex's `when` is registered with the next one", async () => {
    await body.call("POST", "/call", { status: 503, body: NOT_CONNECTED }, { json: { name: "act" } });
    const reflex = { kind: "reflex", name: "plain", routine: "r1", on: ["chat"], when: "process.pid > 0" };
    await body.call("POST", "/bind", { body: { binding: { ...reflex, cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "<timestamp>", fired: 0, failures: 0 }, replaced: false } }, { json: reflex });
    assert.deepStrictEqual(lines().slice(1), [{ seq: 4, startedAt: "<timestamp>", code: reflex.when, escapeAttempts: ["process"], trigger: "plain", routine: "r1", on: ["chat"], status: "registered" }]);
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
    wikiMode: "off" as const,
    milestonesEnabled: true,
  };
  let sequenceNumber = 0;
  const options = async (extra: Partial<DaemonOptions>): Promise<DaemonOptions> => {
    const dir = mkdtempSync(path.join(ROOT, "start-"));
    return { ...base, name: `charz-start-${++sequenceNumber}`, port: await refusedPort(), stateDir: path.join(dir, "state"), ...extra };
  };

  it("rejects an unknown built-in module with the available ones named, and publishes nothing", async () => {
    const opts = await options({ builtins: ["nope"] });
    await assert.rejects(startDaemon(opts), { message: `unknown built-in module "nope"; available: ${ALL_BUILTINS.join(", ")}` });
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

describe("body API: routine calls on a body that is not connected", () => {
  let body: Running;

  before(async () => {
    body = await startBody({ stateFiles: { "bindings.json": { act: { kind: "action", routine: "act" } } } });
  });
  after(() => body.close());

  it("lists the stored binding, and answers /call with 503 as /run does", async () => {
    await body.call("GET", "/bindings", { body: { bindings: [{ kind: "action", name: "act", routine: "act" }] } });
    await body.call("POST", "/call", { status: 503, body: NOT_CONNECTED }, { json: { name: "act", args: { a: 1 } } });
    await body.call("POST", "/run", { status: 503, body: NOT_CONNECTED }, { json: { code: "return 1" } });
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
