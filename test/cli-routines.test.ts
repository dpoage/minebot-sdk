// The routine commands of the CLI and the routine tools of the MCP server. Two kinds of body stand
// behind them: a stub that records every request and answers from a table, to compare each request
// with the HTTP contract and each output with the shared formatter's; and the real bot host over a
// fake player (see fixtures/host/fake-body.ts) behind an HTTP front, for the whole path of saving a
// routine with imports, binding it, and calling it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatBound, formatBuiltinHits, formatBuiltins, formatLibrary, formatRevertedRoutine, formatRoutineVersions, formatRun, formatSavedRoutine } from "../src/client/render.ts";
import type { BindingInfo, BodyFeatures, BuiltinInfo, BuiltinSearchHit, TypeCheck, RoutineInfo, RoutineVersion, RunResult } from "../src/protocol/index.ts";
import { type FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const SCRATCH = mkdtempSync(path.join(tmpdir(), "minebot-cli-routines-"));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  removeScratch();
});

const FEATURES: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: true, routines: true, builtins: [] };

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
type Answers = Record<string, { status: number; body: unknown }>;

/** A body that answers the probes with `features` and every other request from `answers` (keyed `METHOD /path`), and records those. */
async function stubBody(features: BodyFeatures, answers: Answers): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    const url = new URL(req.url!, "http://stub");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/features" || url.pathname === "/api") return void res.end(JSON.stringify(url.pathname === "/features" ? features : { doc: "the program reference" }));
    // The digest that begins every MCP response polls the event log; an empty log is not a tool's request.
    if (url.pathname === "/events") return void res.end(JSON.stringify({ events: [], next: 0 }));
    seen.push({ method: req.method!, url: req.url!, body: raw === "" ? undefined : JSON.parse(raw) });
    const answer = answers[`${req.method} ${url.pathname}`] ?? { status: 404, body: { error: `the stub has no answer for ${req.method} ${url.pathname}` } };
    res.statusCode = answer.status;
    res.end(JSON.stringify(answer.body));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/** The real bot host's API over HTTP: each request goes to the body as the daemon's transport would hand it over. */
async function front(body: FakeBody): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    const answer = await body.request(req.method!, req.url!, raw === "" ? undefined : JSON.parse(raw));
    res.statusCode = answer.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer.body));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** Runs the CLI as an agent would: pointed at a body by URL. */
async function minebot(url: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [...CLI, ...args], { env: { ...process.env, MINEBOT_URL: url, MINEBOT_TOKEN: "" } });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, out: failed.stdout, err: failed.stderr };
  }
}

type ToolAnswer = { content: { type: string; text: string }[]; isError?: boolean };

/** Connects an MCP client to `minebot mcp` against the body at `url`. */
async function withMcp<T>(url: string, args: string[], use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp", ...args], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

const tool = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> => (await client.callTool({ name, arguments: args })) as ToolAnswer;

function file(name: string, content: string): string {
  const target = path.join(SCRATCH, name);
  writeFileSync(target, content);
  return target;
}

const T = "2026-10-21T10:00:00.000Z";
const ACT: RoutineInfo = { name: "act", version: 2, savedAt: T };
const HELPER: RoutineInfo = { name: "helper", version: 1, savedAt: T };
const ACTION: BindingInfo = { kind: "action", name: "act", routine: "act" };
const REFLEX: BindingInfo = { kind: "reflex", name: "echo", routine: "echo", on: ["chat", "whisper"], from: "bob", match: "hi", when: "event.data.n > 1", cooldownMs: 5, timeoutMs: 100, enabled: true, preempt: true, priority: 3, updated: T, fired: 4, lastStatus: "error", lastError: "boom\nat x", failures: 1 };
const VERSIONS: RoutineVersion[] = [
  { version: 1, savedAt: T, savedBy: "bot", current: false },
  { version: 2, savedAt: T, savedBy: "bot", current: true },
  { version: 3, savedAt: T, savedBy: "bot", current: false, revertedFrom: 1 },
];
const FAILED: TypeCheck = { status: "failed", errors: ["act.ts(2,24): error TS2307: Cannot find module './helper.ts'."] };
const OK_RUN: RunResult = { status: "ok", durationMs: 12, logs: "hello", result: { sum: 3 } };

describe("the routine commands of the CLI, against the HTTP contract", () => {
  const sourceOf = file("act.ts", "export default () => 1;\n");
  const helperJs = file("helper.js", "export const two = 2;\n");

  interface Case {
    args: string[];
    /** The requests the command sends, in order, and what the body answers to them. */
    requests: { method: string; url: string; body?: unknown }[];
    answers: Answers;
    /** What the command prints: what the shared formatter makes of the answers. */
    stdout: string;
  }
  const cases: Record<string, Case> = {
    "routines": {
      args: ["routines"],
      requests: [{ method: "GET", url: "/routines" }, { method: "GET", url: "/bindings" }],
      answers: { "GET /routines": { status: 200, body: { routines: [ACT, HELPER] } }, "GET /bindings": { status: 200, body: { bindings: [ACTION, REFLEX] } } },
      stdout: formatLibrary([ACT, HELPER], [ACTION, REFLEX]),
    },
    "routines save, each file under its stem name, in the order given": {
      args: ["routines", "save", sourceOf, helperJs],
      requests: [
        { method: "POST", url: "/routines/save", body: { name: "act", source: "export default () => 1;\n" } },
        { method: "POST", url: "/routines/save", body: { name: "helper", source: "export const two = 2;\n" } },
      ],
      answers: { "POST /routines/save": { status: 200, body: { routine: ACT, typeCheck: FAILED } } },
      stdout: `${formatSavedRoutine({ routine: ACT, typeCheck: FAILED })}\n${formatSavedRoutine({ routine: ACT, typeCheck: FAILED })}`,
    },
    "routines source": {
      args: ["routines", "source", "act"],
      requests: [{ method: "GET", url: "/routines/source?name=act" }],
      answers: { "GET /routines/source": { status: 200, body: { name: "act", source: "export default () => 1;\n" } } },
      stdout: "export default () => 1;\n",
    },
    "routines versions": {
      args: ["routines", "versions", "act"],
      requests: [{ method: "GET", url: "/routines/versions?name=act" }],
      answers: { "GET /routines/versions": { status: 200, body: { name: "act", versions: VERSIONS } } },
      stdout: formatRoutineVersions("act", VERSIONS),
    },
    "routines revert": {
      args: ["routines", "revert", "act", "1"],
      requests: [{ method: "POST", url: "/routines/revert", body: { name: "act", version: 1 } }],
      answers: { "POST /routines/revert": { status: 200, body: { routine: ACT } } },
      stdout: formatRevertedRoutine(ACT),
    },
    "bind action": {
      args: ["bind", "action", "act", "other"],
      requests: [{ method: "POST", url: "/bind", body: { kind: "action", name: "act", routine: "other" } }],
      answers: { "POST /bind": { status: 200, body: { binding: ACTION, replaced: true } } },
      stdout: formatBound({ binding: ACTION, replaced: true }),
    },
    "bind reflex, with every option": {
      args: ["bind", "reflex", "echo", "echo", "--on", "chat, whisper", "--when", "event.data.n > 1", "--from", "bob", "--match", "hi", "--cooldown", "5", "--timeout", "100", "--priority", "3", "--preempt"],
      requests: [{ method: "POST", url: "/bind", body: { kind: "reflex", name: "echo", routine: "echo", on: ["chat", "whisper"], from: "bob", match: "hi", when: "event.data.n > 1", cooldownMs: 5, timeoutMs: 100, priority: 3, preempt: true } }],
      answers: { "POST /bind": { status: 200, body: { binding: REFLEX, replaced: false } } },
      stdout: formatBound({ binding: REFLEX, replaced: false }),
    },
    "bind reflex, with only --on": {
      args: ["bind", "reflex", "echo", "echo", "--on", "chat"],
      requests: [{ method: "POST", url: "/bind", body: { kind: "reflex", name: "echo", routine: "echo", on: ["chat"] } }],
      answers: { "POST /bind": { status: 200, body: { binding: REFLEX, replaced: false } } },
      stdout: formatBound({ binding: REFLEX, replaced: false }),
    },
    "unbind": {
      args: ["unbind", "act"],
      requests: [{ method: "POST", url: "/unbind", body: { name: "act" } }],
      answers: { "POST /unbind": { status: 200, body: { unbound: "act" } } },
      stdout: JSON.stringify({ unbound: "act" }, null, 2),
    },
    "call, with args and a timeout": {
      args: ["call", "act", "--args", '{"a":1,"b":[2]}', "--timeout", "500"],
      requests: [{ method: "POST", url: "/call", body: { name: "act", args: { a: 1, b: [2] }, timeoutMs: 500 } }],
      answers: { "POST /call": { status: 200, body: OK_RUN } },
      stdout: formatRun(OK_RUN),
    },
    "call, with neither": {
      args: ["call", "act"],
      requests: [{ method: "POST", url: "/call", body: { name: "act" } }],
      answers: { "POST /call": { status: 200, body: OK_RUN } },
      stdout: formatRun(OK_RUN),
    },
  };

  for (const [name, c] of Object.entries(cases)) {
    it(`sends the contract's request and prints the formatter's text: ${name}`, async () => {
      const stub = await stubBody(FEATURES, c.answers);
      try {
        const result = await minebot(stub.url, ...c.args);
        assert.equal(result.code, 0, result.err);
        assert.deepEqual(stub.seen, c.requests.map((request) => ({ body: undefined, ...request })));
        assert.equal(result.out, `${c.stdout}\n`);
      } finally {
        stub.server.close();
      }
    });
  }

  it("exits for a call exactly as `minebot run` exits for the same result: 0 for ok, 2 for any other status", async () => {
    const program = file("program.js", "export default 1;");
    const exits: Record<string, [number, number]> = {};
    for (const status of ["ok", "error", "timeout", "stopped"] as const) {
      const run: RunResult = status === "ok" ? OK_RUN : { status, durationMs: 3, logs: "", error: `it ${status}` };
      const stub = await stubBody(FEATURES, { "POST /call": { status: 200, body: run }, "POST /run": { status: 200, body: run } });
      try {
        const called = await minebot(stub.url, "call", "act");
        const ran = await minebot(stub.url, "run", program);
        assert.equal(called.out, ran.out, `${status}: the same text`);
        assert.equal(called.out, `${formatRun(run)}\n`);
        exits[status] = [called.code, ran.code];
      } finally {
        stub.server.close();
      }
    }
    assert.deepEqual(exits, { ok: [0, 0], error: [2, 2], timeout: [2, 2], stopped: [2, 2] });
  });

  it("prints the body's error and exits 1 when the body refuses a request, as every command does", async () => {
    const stub = await stubBody(FEATURES, { "POST /bind": { status: 409, body: { error: 'the name "act" is a reflex' } }, "POST /call": { status: 404, body: { error: 'no action bound to "act"' } } });
    try {
      const bind = await minebot(stub.url, "bind", "action", "act", "act");
      assert.equal(bind.code, 1);
      assert.equal(bind.out, "");
      assert.equal(bind.err, '[minebot] the name "act" is a reflex\n');
      const call = await minebot(stub.url, "call", "act");
      assert.equal(call.code, 1);
      assert.equal(call.err, '[minebot] no action bound to "act"\n');
    } finally {
      stub.server.close();
    }
  });

  it("sends nothing for a command line it can tell is wrong", async () => {
    const stub = await stubBody(FEATURES, {});
    try {
      const notes = file("notes.md", "# not a routine");
      const wrong: [string[], RegExp][] = [
        [["routines", "save"], /needs at least one/],
        // The last file is the wrong one: the first is not saved either.
        [["routines", "save", sourceOf, notes], /takes \.ts or \.js files, not .*notes\.md/],
        [["routines", "source"], /needs a routine name/],
        [["routines", "versions"], /needs a routine name/],
        [["routines", "revert", "act"], /needs a routine name and a version number/],
        [["routines", "revert", "act", "first"], /needs a routine name and a version number/],
        [["routines", "frobnicate"], /unknown routines action "frobnicate"; use save, source, versions, or revert/],
        [["bind"], /bind needs a kind: action or reflex/],
        [["bind", "frobnicate", "a", "b"], /bind needs a kind: action or reflex/],
        [["bind", "action", "act"], /bind action needs a name and a routine/],
        [["bind", "reflex", "echo", "echo"], /bind reflex needs --on <event types>/],
        [["unbind"], /unbind needs a binding name/],
        [["call"], /call needs the name of an action/],
        [["call", "act", "--args", "{nope"], /--args is not JSON/],
      ];
      for (const [args, message] of wrong) {
        const result = await minebot(stub.url, ...args);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.err, message, args.join(" "));
      }
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("answers the routine commands of a body without routines as unknown commands, without a request to it", async () => {
    const stub = await stubBody({ ...FEATURES, routines: false }, {});
    try {
      for (const args of [["routines"], ["routines", "save", sourceOf], ["bind", "action", "a", "b"], ["unbind", "a"], ["call", "a"]]) {
        const result = await minebot(stub.url, ...args);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.err, new RegExp(`^unknown command: ${args[0]}\\n`), args.join(" "));
        // The usage under the first line is the one `--help` prints: it says nothing of routines.
        assert.doesNotMatch(result.err.slice(result.err.indexOf("\n")), /routine|\bbind\b|unbind/i, args.join(" "));
      }
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("offers `bind reflex` only to a body that offers reflexes, and still binds actions there", async () => {
    const stub = await stubBody({ ...FEATURES, reflexes: false }, { "POST /bind": { status: 200, body: { binding: ACTION, replaced: false } } });
    try {
      const reflex = await minebot(stub.url, "bind", "reflex", "echo", "echo", "--on", "chat");
      assert.equal(reflex.code, 1);
      assert.match(reflex.err, /bind needs a kind: action$/m);
      assert.equal(stub.seen.length, 0);
      const action = await minebot(stub.url, "bind", "action", "act", "act");
      assert.equal(action.code, 0, action.err);
      assert.deepEqual(stub.seen.map((request) => request.url), ["/bind"]);
    } finally {
      stub.server.close();
    }
  });
});

describe("the built-in commands of the CLI and tools of the MCP server, against a recording body", () => {
  const WITH = { ...FEATURES, builtins: ["move", "gatherer"] };
  const INFOS: BuiltinInfo[] = [
    { name: "move", description: "Walk.", uses: [], routines: ["to", "stop"], stats: { to: { ok: 3, failed: 1, lastError: "no path\nat x" } } },
    { name: "gatherer", description: "Gather.", uses: ["move"], routines: ["gather"], stats: {} },
  ];
  const HITS: BuiltinSearchHit[] = [{ module: "move", score: 4.2, text: "Walk." }, { module: "move", routine: "to", score: 3.1, text: "Walk within range.", stats: { ok: 3, failed: 1 } }];
  const DOCS = "## move\nWalk.\nUses no other built-in modules.\n### await move.to(ctx, { position })";
  const SOURCE = "export const description = 'Walk.';\n";
  const requests = (stub: { seen: Seen[] }) => stub.seen.map((request) => `${request.method} ${request.url}`);
  const answers: Answers = {
    "GET /builtins": { status: 200, body: { builtins: INFOS } },
    "GET /builtins/docs": { status: 200, body: { docs: DOCS } },
    "GET /builtins/search": { status: 200, body: { hits: HITS } },
    "GET /builtins/source": { status: 200, body: { name: "move", source: SOURCE } },
    "POST /call": { status: 200, body: OK_RUN },
  };

  it("sends the contract's request and prints the formatter's text for each command", async () => {
    const stub = await stubBody(WITH, answers);
    try {
      const cases: [string[], string][] = [
        [["builtins"], formatBuiltins(INFOS)],
        [["builtins", "docs", "move", "gatherer"], DOCS],
        [["builtins", "docs"], DOCS],
        [["builtins", "search", "walk", "to", "--limit", "3"], formatBuiltinHits(HITS)],
        [["builtins", "source", "move"], SOURCE],
        [["call", "move.to", "--args", '{"position":[1,2,3]}', "--timeout", "500"], formatRun(OK_RUN)],
      ];
      for (const [args, stdout] of cases) {
        const result = await minebot(stub.url, ...args);
        assert.equal(result.code, 0, `${args.join(" ")}: ${result.err}`);
        assert.equal(result.out, `${stdout}\n`, args.join(" "));
      }
      assert.deepEqual(stub.seen, [
        { method: "GET", url: "/builtins" },
        { method: "GET", url: "/builtins/docs?names=move%2Cgatherer" },
        { method: "GET", url: "/builtins/docs?names=" },
        { method: "GET", url: "/builtins/search?q=walk%20to&limit=3" },
        { method: "GET", url: "/builtins/source?name=move" },
        { method: "POST", url: "/call", body: { name: "move.to", args: { position: [1, 2, 3] }, timeoutMs: 500 } },
      ].map((request) => ({ body: undefined, ...request })));
      // A search that finds nothing says so.
      const none = await stubBody(WITH, { "GET /builtins/search": { status: 200, body: { hits: [] } } });
      try {
        assert.equal((await minebot(none.url, "builtins", "search", "xyzzy")).out, "no matching built-ins\n");
      } finally {
        none.server.close();
      }
    } finally {
      stub.server.close();
    }
  });

  it("sends nothing for a command line it can tell is wrong", async () => {
    const stub = await stubBody(WITH, answers);
    try {
      for (const [args, message] of [
        [["builtins", "search"], /needs a query/],
        [["builtins", "source"], /needs a module name/],
        [["builtins", "frobnicate"], /unknown builtins action "frobnicate"; use docs, search, or source/],
      ] as const) {
        const result = await minebot(stub.url, ...args);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.err, message, args.join(" "));
      }
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("answers the built-in command of a body without built-ins as an unknown command, whose usage names none", async () => {
    const stub = await stubBody(FEATURES, {});
    try {
      const result = await minebot(stub.url, "builtins");
      assert.equal(result.code, 1);
      assert.match(result.err, /^unknown command: builtins\n/);
      assert.doesNotMatch(result.err.slice(result.err.indexOf("\n")), /builtin|built-in/i);
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("serves builtin_docs in the core set and the other built-in tools in the full set, over the contract's requests", async () => {
    const stub = await stubBody(WITH, answers);
    try {
      const core = await withMcp(stub.url, [], async (client) => ({
        docs: await tool(client, "builtin_docs", { modules: ["move", "gatherer"] }),
        all: await tool(client, "builtin_docs", {}),
        call: await tool(client, "call_routine", { name: "move.to", args: { position: [1, 2, 3] }, timeout_ms: 500 }),
      }));
      assert.deepEqual([core.docs.content[0]!.text, core.all.content[0]!.text, core.call.content[0]!.text], [DOCS, DOCS, formatRun(OK_RUN)]);
      assert.deepEqual(requests(stub), ["GET /builtins/docs?names=move%2Cgatherer", "GET /builtins/docs?names=", "POST /call"]);
      assert.deepEqual(stub.seen[2]!.body, { name: "move.to", args: { position: [1, 2, 3] }, timeoutMs: 500 });
      stub.seen.length = 0;
      const full = await withMcp(stub.url, ["--tools", "full"], async (client) => ({
        list: await tool(client, "list_builtins", {}),
        search: await tool(client, "builtin_search", { query: "walk", limit: 2 }),
        source: await tool(client, "builtin_source", { name: "move" }),
      }));
      assert.deepEqual([full.list.content[0]!.text, full.search.content[0]!.text, full.source.content[0]!.text], [formatBuiltins(INFOS), formatBuiltinHits(HITS), SOURCE]);
      assert.deepEqual(requests(stub), ["GET /builtins", "GET /builtins/search?q=walk&limit=2", "GET /builtins/source?name=move"]);
    } finally {
      stub.server.close();
    }
  });

  it("takes a built-in's call name in call_routine only from a body that offers built-ins", async () => {
    const stub = await stubBody(FEATURES, answers);
    try {
      const answer = await withMcp(stub.url, [], (client) => tool(client, "call_routine", { name: "move.to" }));
      assert.equal(answer.isError, true, "the tool's own schema refuses a dotted name");
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });
});

describe("the routine tools of the MCP server, against a recording body", () => {
  const SAVED = { routine: ACT, typeCheck: { status: "passed" } as TypeCheck };
  const BOUND = { binding: ACTION, replaced: false };
  const requests = (stub: { seen: Seen[] }) => stub.seen.map((request) => `${request.method} ${request.url}`);

  it("saves the module as <routine>.ts first and binds it second, and answers with both", async () => {
    const stub = await stubBody(FEATURES, { "POST /routines/save": { status: 200, body: SAVED }, "POST /bind": { status: 200, body: BOUND } });
    try {
      const answer = await withMcp(stub.url, [], (client) => tool(client, "bind_routine", { kind: "action", name: "act", routine: "act2", source: "export default () => 1;\n" }));
      assert.equal(answer.isError, undefined);
      assert.deepEqual(stub.seen, [
        { method: "POST", url: "/routines/save", body: { name: "act2", source: "export default () => 1;\n" } },
        { method: "POST", url: "/bind", body: { kind: "action", name: "act", routine: "act2" } },
      ]);
      assert.equal(answer.content[0]!.text, `${formatSavedRoutine(SAVED)}\n${formatBound(BOUND)}`);
    } finally {
      stub.server.close();
    }
  });

  it("returns a refused bind's error and leaves the saved module: nothing is undone", async () => {
    const stub = await stubBody(FEATURES, {
      "POST /routines/save": { status: 200, body: SAVED },
      "POST /bind": { status: 409, body: { error: 'the name "act" is already a reflex; unbind it first' } },
    });
    try {
      const answer = await withMcp(stub.url, [], (client) => tool(client, "bind_routine", { kind: "action", name: "act", routine: "act", source: "export default () => 1;\n" }));
      assert.equal(answer.isError, true);
      assert.match(answer.content[0]!.text, /^the name "act" is already a reflex; unbind it first\n/);
      assert.match(answer.content[0]!.text, /The module "act" was saved; the binding was not made\./);
      assert.deepEqual(requests(stub), ["POST /routines/save", "POST /bind"], "no request after the refusal: the save is not undone");
    } finally {
      stub.server.close();
    }
  });

  it("only binds without a source, and returns the bind error as it is", async () => {
    const stub = await stubBody(FEATURES, { "POST /bind": { status: 404, body: { error: 'no routine named "act"' } } });
    try {
      const answer = await withMcp(stub.url, [], (client) => tool(client, "bind_routine", { kind: "action", name: "act", routine: "act" }));
      assert.deepEqual(requests(stub), ["POST /bind"]);
      assert.equal(answer.isError, true);
      assert.equal(answer.content[0]!.text, 'no routine named "act"');
    } finally {
      stub.server.close();
    }
  });

  it("refuses a malformed bind before it saves anything", async () => {
    const stub = await stubBody(FEATURES, { "POST /routines/save": { status: 200, body: SAVED }, "POST /bind": { status: 200, body: BOUND } });
    try {
      await withMcp(stub.url, [], async (client) => {
        const stray = await tool(client, "bind_routine", { kind: "action", name: "act", routine: "act", source: "export default () => 1;\n", on: ["chat"], priority: 1 });
        assert.equal(stray.isError, true);
        assert.match(stray.content[0]!.text, /only apply to kind "reflex"/);
        const bare = await tool(client, "bind_routine", { kind: "reflex", name: "act", routine: "act", source: "export default () => 1;\n" });
        assert.equal(bare.isError, true);
        assert.match(bare.content[0]!.text, /needs on/);
      });
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("binds a reflex with the fields the agent gave and none it did not", async () => {
    const stub = await stubBody(FEATURES, { "POST /bind": { status: 200, body: { binding: REFLEX, replaced: false } } });
    try {
      const answer = await withMcp(stub.url, [], (client) =>
        tool(client, "bind_routine", { kind: "reflex", name: "echo", routine: "echo", on: ["chat"], match: "hi", cooldown_ms: 0, timeout_ms: 100, preempt: true }),
      );
      assert.equal(answer.isError, undefined);
      assert.deepEqual(stub.seen, [{ method: "POST", url: "/bind", body: { kind: "reflex", name: "echo", routine: "echo", on: ["chat"], match: "hi", cooldownMs: 0, timeoutMs: 100, preempt: true } }]);
      assert.equal(answer.content[0]!.text, formatBound({ binding: REFLEX, replaced: false }));
    } finally {
      stub.server.close();
    }
  });

  it("calls an action with its args and timeout, and answers with the run", async () => {
    const stub = await stubBody(FEATURES, { "POST /call": { status: 200, body: OK_RUN } });
    try {
      const answer = await withMcp(stub.url, [], (client) => tool(client, "call_routine", { name: "act", args: { a: 1 }, timeout_ms: 500 }));
      assert.deepEqual(stub.seen, [{ method: "POST", url: "/call", body: { name: "act", args: { a: 1 }, timeoutMs: 500 } }]);
      assert.equal(answer.content[0]!.text, formatRun(OK_RUN));
    } finally {
      stub.server.close();
    }
  });

  it("serves the library tools of the full set over the contract's requests", async () => {
    const stub = await stubBody(FEATURES, {
      "GET /routines": { status: 200, body: { routines: [ACT] } },
      "GET /bindings": { status: 200, body: { bindings: [ACTION, REFLEX] } },
      "POST /routines/save": { status: 200, body: SAVED },
      "GET /routines/source": { status: 200, body: { name: "act", source: "export default () => 1;\n" } },
      "GET /routines/versions": { status: 200, body: { name: "act", versions: VERSIONS } },
      "POST /routines/revert": { status: 200, body: { routine: ACT } },
      "POST /unbind": { status: 200, body: { unbound: "act" } },
    });
    try {
      const out = await withMcp(stub.url, ["--tools", "full"], async (client) => ({
        list: await tool(client, "list_routines", {}),
        save: await tool(client, "routine_save", { name: "act", source: "export default () => 1;\n" }),
        source: await tool(client, "routine_source", { name: "act" }),
        versions: await tool(client, "routine_versions", { name: "act" }),
        revert: await tool(client, "routine_revert", { name: "act", version: 1 }),
        unbind: await tool(client, "unbind_routine", { name: "act" }),
      }));
      assert.deepEqual(requests(stub).sort(), [
        "GET /bindings",
        "GET /routines",
        "GET /routines/source?name=act",
        "GET /routines/versions?name=act",
        "POST /routines/revert",
        "POST /routines/save",
        "POST /unbind",
      ]);
      assert.equal(out.list.content[0]!.text, formatLibrary([ACT], [ACTION, REFLEX]));
      assert.equal(out.save.content[0]!.text, formatSavedRoutine(SAVED));
      assert.equal(out.source.content[0]!.text, "export default () => 1;\n");
      assert.equal(out.versions.content[0]!.text, formatRoutineVersions("act", VERSIONS));
      assert.equal(out.revert.content[0]!.text, formatRevertedRoutine(ACT));
      assert.equal(out.unbind.content[0]!.text, JSON.stringify({ unbound: "act" }, null, 2));
    } finally {
      stub.server.close();
    }
  });

  it("describes reflexes in bind_routine's input only for a body that offers reflexes", async () => {
    for (const reflexes of [true, false]) {
      const stub = await stubBody({ ...FEATURES, reflexes }, {});
      try {
        const bind = await withMcp(stub.url, [], async (client) => (await client.listTools()).tools.find((candidate) => candidate.name === "bind_routine")!);
        const fields = Object.keys(bind.inputSchema.properties ?? {}).sort();
        assert.deepEqual(
          fields,
          reflexes
            ? ["cooldown_ms", "enabled", "from", "kind", "match", "name", "on", "preempt", "priority", "routine", "source", "timeout_ms", "when"]
            : ["kind", "name", "routine", "source"],
          `reflexes ${reflexes}`,
        );
        assert.equal(/reflex/i.test(bind.description ?? ""), reflexes, `reflexes ${reflexes}`);
        assert.equal(/reflex/.test(JSON.stringify(bind.inputSchema)), reflexes, `reflexes ${reflexes}`);
      } finally {
        stub.server.close();
      }
    }
  });
});

describe("saving, binding, and calling a routine, on the real bot host over HTTP", () => {
  let body: FakeBody;
  let api: { url: string; server: Server };
  const dir = path.join(SCRATCH, "w3");
  const files = {
    act: path.join(dir, "act.ts"),
    helper: path.join(dir, "helper.ts"),
    boom: path.join(dir, "boom.ts"),
    echo: path.join(dir, "echo.ts"),
  };
  before(async () => {
    body = await startFakeBody();
    api = await front(body);
    mkdirSync(dir, { recursive: true });
    writeFileSync(files.helper, "export const double = (n: number): number => n * 2;\n");
    writeFileSync(
      files.act,
      'import { Vec3 } from "vec3";\nimport { double } from "./helper.ts";\nexport default (_ctx: unknown, args: { x: number; y: number; z: number }) => ({ length: new Vec3(args.x, args.y, args.z).norm(), doubled: double(args.x) });\n',
    );
    writeFileSync(files.boom, 'export default (): never => {\n  throw new Error("boom");\n};\n');
    writeFileSync(files.echo, "export default (_ctx: unknown, args: unknown) => args;\n");
  });
  after(async () => {
    api.server.close();
    await body.close();
  });

  it("saves a routine with its imports, binds it, calls it with args, and lists, versions, and reverts it", async () => {
    const saved = await minebot(api.url, "routines", "save", files.act, files.helper);
    assert.equal(saved.code, 0, saved.err);
    assert.match(saved.out, /^saved act {2}v1 {2}\S+\ntype check: (passed|failed|skipped)[^]*\nsaved helper {2}v1 {2}\S+\ntype check: /);
    assert.equal(readFileSync(path.join(body.routinesDir, "act.ts"), "utf8"), readFileSync(files.act, "utf8"));

    const bound = await minebot(api.url, "bind", "action", "act", "act");
    assert.equal(bound.out, "bound act  action of act\n");

    const called = await minebot(api.url, "call", "act", "--args", '{"x":3,"y":4,"z":0}');
    assert.equal(called.code, 0, called.out + called.err);
    assert.match(called.out, /^status: ok \(\d+ ms\)\n\nresult:\n\{\n {2}"length": 5,\n {2}"doubled": 6\n\}\n$/);
    assert.equal(body.history().at(-1)!.status, "ok");

    const listed = await minebot(api.url, "routines");
    assert.match(listed.out, /^routines:\nact {2}v1 {2}\S+\nhelper {2}v1 {2}\S+\n\nbindings:\nact {2}action of act\n$/);

    writeFileSync(files.act, "export default () => 'second';\n");
    assert.equal((await minebot(api.url, "routines", "save", files.act)).code, 0);
    const versions = await minebot(api.url, "routines", "versions", "act");
    assert.match(versions.out, /^act v1 {2}\S+ {2}by \S+\nact v2 \(current\) {2}\S+ {2}by \S+\n$/);
    assert.match((await minebot(api.url, "routines", "revert", "act", "1")).out, /^reverted act {2}v3 {2}\S+\n$/);
    assert.match((await minebot(api.url, "routines", "source", "act")).out, /^import \{ Vec3 \} from "vec3";/);
    assert.deepEqual(JSON.parse((await minebot(api.url, "unbind", "act")).out), { unbound: "act" });
    const gone = await minebot(api.url, "call", "act");
    assert.equal(gone.code, 1);
    assert.equal(gone.err, '[minebot] no action bound to "act"\n');
  });

  it("exits a failing call with the code a failing `minebot run` exits with", async () => {
    assert.equal((await minebot(api.url, "routines", "save", files.boom)).code, 0);
    assert.equal((await minebot(api.url, "bind", "action", "boom", "boom")).code, 0);
    const called = await minebot(api.url, "call", "boom");
    const ran = await minebot(api.url, "run", file("throws.js", "throw new Error('boom');"));
    assert.match(called.out, /^status: error \(\d+ ms\)\n\nerror:\n[^]*boom/);
    assert.equal(called.code, 2);
    assert.equal(ran.code, called.code);
  });

  it("binds a reflex and lists it with its filters and counts", async () => {
    assert.equal((await minebot(api.url, "routines", "save", files.echo)).code, 0);
    const reflex = await minebot(api.url, "bind", "reflex", "echo", "echo", "--on", "chat", "--match", "^say", "--cooldown", "0");
    assert.equal(reflex.code, 0, reflex.err);
    assert.equal(reflex.out, "bound echo  reflex of echo  [on]  on chat; match /^say/\n  cooldown 0 ms, timeout 30000 ms; fired 0 times\n");
    const listed = await minebot(api.url, "routines");
    assert.match(listed.out, /bindings:\n[^]*echo {2}reflex of echo {2}\[on\] {2}on chat; match \/\^say\/\n {2}cooldown 0 ms, timeout 30000 ms; fired 0 times/);
  });

  it("through MCP, saves and binds in one call, and a refused bind leaves the saved module", async () => {
    await withMcp(api.url, [], async (client) => {
      const made = await tool(client, "bind_routine", { kind: "action", name: "greet", routine: "greeter", source: "export default (_ctx: unknown, args: { who: string }) => `hello ${args.who}`;\n" });
      assert.equal(made.isError, undefined, made.content[0]!.text);
      assert.match(made.content[0]!.text, /^saved greeter {2}v1 [^]*\nbound greet {2}action of greeter$/);
      const called = await tool(client, "call_routine", { name: "greet", args: { who: "world" } });
      assert.match(called.content[0]!.text, /^status: ok \(\d+ ms\)\n\nresult:\nhello world$/);

      // `echo` is a reflex: an action of that name is refused, after the module was saved.
      const refused = await tool(client, "bind_routine", { kind: "action", name: "echo", routine: "kept", source: "export default () => 'kept';\n" });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0]!.text, /The module "kept" was saved; the binding was not made\./);
    });
    assert.equal(readFileSync(path.join(body.routinesDir, "kept.ts"), "utf8"), "export default () => 'kept';\n");
    assert.match((await minebot(api.url, "routines", "source", "kept")).out, /'kept'/);
    assert.match((await minebot(api.url, "routines")).out, /^routines:\n[^]*kept {2}v1/);
  });
});

describe("module runs through the CLI and the MCP server, against a recording body", () => {
  const RUNNER = "interface Args { n: number }\nexport default async (ctx: { log(...a: unknown[]): void }, args: Args): Promise<number> => {\n  ctx.log('n', args.n);\n  return args.n * 2;\n};\n";

  it("sends the file's text as it is, with --args and --timeout, whatever the file's extension", async () => {
    for (const name of ["runs/x.ts", "runs/x.js", "runs/x.mts"]) {
      mkdirSync(path.join(SCRATCH, "runs"), { recursive: true });
      const source = file(name, RUNNER);
      const stub = await stubBody(FEATURES, { "POST /run": { status: 200, body: OK_RUN } });
      try {
        const ran = await minebot(stub.url, "run", source, "--args", '{"n":2,"deep":{"x":[1,null]}}', "--timeout", "5000");
        assert.equal(ran.code, 0, ran.err);
        assert.equal(ran.out, `${formatRun(OK_RUN)}\n`);
        assert.deepEqual(stub.seen, [{ method: "POST", url: "/run", body: { code: RUNNER, args: { n: 2, deep: { x: [1, null] } }, timeoutMs: 5000 } }], name);
      } finally {
        stub.server.close();
      }
    }
  });

  it("sends the text of stdin as it is when the file is omitted or `-`, and no args when none are given", async () => {
    for (const argv of [["run"], ["run", "-"]]) {
      const stub = await stubBody(FEATURES, { "POST /run": { status: 200, body: OK_RUN } });
      try {
        const child = exec(process.execPath, [...CLI, ...argv], { env: { ...process.env, MINEBOT_URL: stub.url, MINEBOT_TOKEN: "" } });
        child.child.stdin!.end(RUNNER);
        const { stdout } = await child;
        assert.equal(stdout, `${formatRun(OK_RUN)}\n`);
        assert.deepEqual(stub.seen, [{ method: "POST", url: "/run", body: { code: RUNNER } }], argv.join(" "));
      } finally {
        stub.server.close();
      }
    }
  });

  it("exits 2 for any run that did not end ok, and 0 for one that did", async () => {
    const source = file("runs/exits.ts", "export default 1;\n");
    const exits: Record<string, number> = {};
    for (const status of ["ok", "error", "timeout", "stopped"] as const) {
      const run: RunResult = status === "ok" ? OK_RUN : { status, durationMs: 3, logs: "", error: `it ${status}` };
      const stub = await stubBody(FEATURES, { "POST /run": { status: 200, body: run } });
      try {
        exits[status] = (await minebot(stub.url, "run", source, "--args", "{}")).code;
      } finally {
        stub.server.close();
      }
    }
    assert.deepEqual(exits, { ok: 0, error: 2, timeout: 2, stopped: 2 });
  });

  it("refuses --args that is not JSON before any request to the body", async () => {
    const stub = await stubBody(FEATURES, { "POST /run": { status: 200, body: OK_RUN } });
    try {
      const ran = await minebot(stub.url, "run", file("runs/bad.ts", "export default 1;\n"), "--args", "{n:");
      assert.equal(ran.code, 1);
      assert.match(ran.err, /^\[minebot\] --args is not JSON: /);
      assert.deepEqual(stub.seen, []);
    } finally {
      stub.server.close();
    }
  });

  it("passes the code, args and timeout_ms of run_program on as a run, and answers as `minebot run` prints", async () => {
    for (const toolSet of ["core", "full"]) {
      const stub = await stubBody(FEATURES, { "POST /run": { status: 200, body: OK_RUN } });
      try {
        const answer = await withMcp(stub.url, ["--tools", toolSet], (client) => tool(client, "run_program", { code: RUNNER, args: { n: 4 }, timeout_ms: 7000 }));
        assert.equal(answer.isError, undefined);
        assert.equal(answer.content[0]!.text, formatRun(OK_RUN));
        assert.deepEqual(stub.seen, [{ method: "POST", url: "/run", body: { code: RUNNER, args: { n: 4 }, timeoutMs: 7000 } }], toolSet);
      } finally {
        stub.server.close();
      }
    }
  });

  it("describes run_program as a module run, and its code as a module", async () => {
    const stub = await stubBody(FEATURES, {});
    try {
      const listed = await withMcp(stub.url, [], async (client) => (await client.listTools()).tools.find((t) => t.name === "run_program")!);
      assert.match(listed.description ?? "", /module/);
      const properties = (listed.inputSchema as { properties: Record<string, { description?: string }> }).properties;
      assert.deepEqual(Object.keys(properties).sort(), ["args", "code", "timeout_ms"]);
      assert.match(properties.code!.description ?? "", /export default/);
    } finally {
      stub.server.close();
    }
  });
});
