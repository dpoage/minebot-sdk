// Action bindings through the real bot host (see fixtures/host/fake-body.ts): the last-write-wins
// map, its persistence across a host SIGKILL and a body restart, the entries a body skips, the
// names it refuses, and that nothing here ever evaluates a routine's module.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BindingInfo, RunResult } from "../src/protocol/index.ts";
import { BaseStored } from "./fixtures/host/base-trigger-stored.ts";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const PID = "export default () => process.pid;\n";
const ROUTINES = ["r1", "r2", "r3"];
const NAMES = ["a", "b", "c", "d"];

async function using(body: FakeBody, test: () => Promise<void>): Promise<void> {
  try {
    await test();
  } finally {
    await body.close();
  }
}

/** A deterministic pseudo-random sequence (mulberry32), so a failing sequence replays. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const listed = async (body: FakeBody): Promise<BindingInfo[]> => ((await body.ok("GET", "/bindings")) as { bindings: BindingInfo[] }).bindings;
const expected = (model: Map<string, string>): BindingInfo[] =>
  [...model].sort(([a], [b]) => a.localeCompare(b)).map(([name, routine]) => ({ kind: "action" as const, name, routine }));
const hostPid = async (body: FakeBody): Promise<unknown> => ((await body.ok("POST", "/call", { name: "pidr" })) as RunResult).result;

describe("action bindings", () => {
  for (const seed of [1, 2, 3]) {
    it(`list as the last-write-wins map of any bind/unbind sequence (seed ${seed}), and the same after a host SIGKILL and after a body restart`, async () => {
      const next = random(seed);
      const body = await startFakeBody();
      let restarted: FakeBody | undefined;
      try {
        body.writeRoutines({ ...Object.fromEntries(ROUTINES.map((name) => [name, `export default () => "${name}";\n`])), pidr: PID });
        const model = new Map<string, string>();
        await body.ok("POST", "/bind", { kind: "action", name: "pidr", routine: "pidr" });
        model.set("pidr", "pidr");
        for (let step = 0; step < 60; step++) {
          const name = NAMES[Math.floor(next() * NAMES.length)]!;
          if (next() < 0.65) {
            const routine = ROUTINES[Math.floor(next() * ROUTINES.length)]!;
            const answer = await body.request("POST", "/bind", { kind: "action", name, routine });
            assert.equal(answer.status, 200);
            assert.deepEqual(answer.body, { binding: { kind: "action", name, routine }, replaced: model.has(name) });
            model.set(name, routine);
          } else {
            const answer = await body.request("POST", "/unbind", { name });
            assert.equal(answer.status, model.delete(name) ? 200 : 404);
            if (answer.status === 200) assert.deepEqual(answer.body, { unbound: name });
          }
          if (step % 15 === 14) assert.deepEqual(await listed(body), expected(model), `after step ${step}`);
        }
        assert.deepEqual(await listed(body), expected(model));
        assert.deepEqual(JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")), Object.fromEntries([...model].map(([name, routine]) => [name, { kind: "action", routine }])));

        // Every bound name calls its routine.
        for (const [name, routine] of model) {
          if (name !== "pidr") assert.equal(((await body.ok("POST", "/call", { name })) as RunResult).result, routine);
        }

        // A host SIGKILL: the replacement host serves the same bindings.
        const pid = await hostPid(body);
        assert.equal(typeof pid, "number");
        const since = body.events.since(0, 1000).next;
        process.kill(pid as number, "SIGKILL");
        await body.waitFor("connected", since);
        assert.deepEqual(await listed(body), expected(model), "after the host was killed");
        assert.notEqual(await hostPid(body), pid);

        // A body restart on the same state directory.
        await body.close();
        restarted = await startFakeBody({ stateDir: body.stateDir });
        assert.deepEqual(await listed(restarted), expected(model), "after the body restarted");
        for (const [name, routine] of model) {
          if (name !== "pidr") assert.equal(((await restarted.ok("POST", "/call", { name })) as RunResult).result, routine);
        }
      } finally {
        await body.close();
        await restarted?.close();
      }
    });
  }

  it("skips a stored entry that no longer parses, leaves it in the file, and reports it as binding_error", async () => {
    const stored = {
      good: { kind: "action", routine: "r1" },
      "bad-kind": { kind: "reflex", routine: "r1", on: ["chat"] },
      "bad-routine": { kind: "action", routine: "Not A Routine" },
      "not-an-object": 7,
      "Bad Name": { kind: "action", routine: "r1" },
      "move.to": { kind: "action", routine: "r1" },
    };
    const body = await startFakeBody({ stateFiles: { "bindings.json": stored } });
    await using(body, async () => {
      assert.deepEqual(await listed(body), [{ kind: "action", name: "good", routine: "r1" }]);
      const reported = body.eventsOf("binding_error").map((event) => event.data.name);
      assert.deepEqual([...reported].sort(), ["Bad Name", "bad-kind", "bad-routine", "move.to", "not-an-object"]);
      for (const event of body.eventsOf("binding_error")) assert.equal(typeof event.data.error, "string");
      // Binding another name rewrites the file, and the skipped entries are still in it.
      body.writeRoutines({ r1: "export default () => 1;\n" });
      await body.ok("POST", "/bind", { kind: "action", name: "fresh", routine: "r1" });
      const file = JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(file).sort(), ["Bad Name", "bad-kind", "bad-routine", "fresh", "good", "move.to", "not-an-object"]);
      assert.deepEqual(file["bad-kind"], stored["bad-kind"]);
    });
  });

  it("refuses an unknown routine with 404 and a bad request with 400, and each leaves the bindings alone", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      assert.equal((await body.request("POST", "/bind", { kind: "action", name: "act", routine: "ghost" })).status, 404);
      for (const bad of [
        { kind: "action", name: "Bad Name", routine: "r1" },
        { kind: "action", name: "act", routine: "../r1" },
        { kind: "action", name: "act" },
        { kind: "reflex", name: "act", routine: "r1" },
        { name: "act", routine: "r1" },
      ]) {
        assert.equal((await body.request("POST", "/bind", bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await body.request("POST", "/unbind", { name: "act" })).status, 404);
      assert.deepEqual(await listed(body), []);
      assert.equal(existsSync(path.join(body.stateDir, "bindings.json")), false, "a refused bind writes nothing");
    });
  });
});

describe("binding names", () => {
  const RULE = { error: "✖ use 1-48 lowercase letters, digits, _ and -; start with a letter\n  → at name" };
  const CALL_RULE = { error: "✖ use an action's name (1-48 lowercase letters, digits, _ and -; start with a letter) or a built-in routine's <module>.<routine>\n  → at name" };
  const STORED_RULE = { error: "✖ use 1-48 lowercase letters, digits, and . _ -; start with a letter or digit\n  → at name" };

  it("refuse a dotted name on every bind path with 400 and the name rule's message, and none is stored; a call takes a dotted name as a built-in routine's", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      for (const name of ["move.to", "a.b", ".x", "Bad"]) {
        assert.deepEqual(await body.request("POST", "/bind", { kind: "action", name, routine: "r1" }), { status: 400, body: RULE }, `/bind ${name}`);
      }
      // A call never resolves a dotted name to a binding: `move.to` is the built-in routine, which fails on its missing arguments; `a.b` is none.
      const builtin = await body.request("POST", "/call", { name: "move.to" });
      assert.equal(builtin.status, 200);
      assert.match((builtin.body as { error: string }).error, /^Error: routine "move\.to" arguments: /);
      assert.deepEqual(await body.request("POST", "/call", { name: "a.b" }), { status: 404, body: { error: 'no built-in routine "a.b"' } });
      for (const name of [".x", "Bad"]) assert.deepEqual(await body.request("POST", "/call", { name }), { status: 400, body: CALL_RULE }, `/call ${name}`);
      assert.deepEqual(await listed(body), []);
      assert.equal(existsSync(path.join(body.stateDir, "bindings.json")), false);
      assert.equal((await body.request("POST", "/bind", { kind: "action", name: "x1", routine: "r1" })).status, 200);
    });
  });

  it("accept on an unbind every spelling a stored entry may have, dots included, and refuse the rest with the stored name rule's message", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      for (const name of ["move.to", "a.b", "key.login", "0lead", "a_b-c"]) {
        assert.deepEqual(await body.request("POST", "/unbind", { name }), { status: 404, body: { error: `no binding "${name}"` } }, name);
      }
      for (const name of [".x", "Bad", "", "a b", "x".repeat(49)]) {
        assert.equal((await body.request("POST", "/unbind", { name })).status, 400, name);
      }
      assert.deepEqual(await body.request("POST", "/unbind", { name: "Bad" }), { status: 400, body: STORED_RULE });
      assert.equal(existsSync(path.join(body.stateDir, "bindings.json")), false);
    });
  });
});

describe("a body without routines", () => {
  it("never reads or writes bindings.json", async () => {
    const text = '{"act":{"kind":"action","routine":"act"}}\n';
    const body = await startFakeBody({ init: { routines: false }, stateFiles: { "bindings.json": text } });
    await using(body, async () => {
      assert.equal(((await body.ok("GET", "/features")) as { routines: boolean }).routines, false);
      assert.equal(body.eventsOf("binding_error").length, 0);
      assert.equal(existsSync(body.routinesDir), false, "a body without routines creates no library");
      assert.equal(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8"), text);
      // A corrupt file is nothing to a body that does not read it.
      writeFileSync(path.join(body.stateDir, "bindings.json"), "{ not json");
    });
    const again = await startFakeBody({ stateDir: body.stateDir, init: { routines: false } });
    await using(again, async () => assert.equal(readFileSync(path.join(again.stateDir, "bindings.json"), "utf8"), "{ not json"));
  });
});

describe("no module is evaluated outside a call", () => {
  it("leaves no marker from save, list, source, versions, revert, bind, GET /bindings, or unbind", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      const marker = path.join(body.stateDir, "marker");
      const source = (version: number) => `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nexport default () => ${version};\n`;
      await body.ok("POST", "/routines/save", { name: "marked", source: source(1) });
      await body.ok("POST", "/routines/save", { name: "marked", source: source(2) });
      await body.ok("GET", "/routines");
      assert.deepEqual(await body.ok("GET", "/routines/source?name=marked"), { name: "marked", source: source(2) });
      await body.ok("GET", "/routines/versions?name=marked");
      await body.ok("POST", "/routines/revert", { name: "marked", version: 1 });
      await body.ok("POST", "/bind", { kind: "action", name: "marked", routine: "marked" });
      await body.ok("POST", "/bind", { kind: "action", name: "again", routine: "marked" });
      await listed(body);
      await body.ok("POST", "/unbind", { name: "again" });
      assert.equal(existsSync(marker), false, "a module's top level ran");
      await body.ok("POST", "/call", { name: "marked" });
      assert.equal(readFileSync(marker, "utf8"), "x");
    });
  });
});

const reflexEntry = { on: ["chat"], routine: "r1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };
/** What a code trigger of the code before reflexes stores: a `run` program and no routine. */
const codeEntry = { on: ["chat"], run: "return 1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

type Kind = "action" | "reflex";
const KINDS: Kind[] = ["action", "reflex"];

/** One claim of `name` by a binding of `kind`, over HTTP. */
function claim(body: FakeBody, kind: Kind, name: string, extra: Record<string, unknown> = {}) {
  if (kind === "action") return body.request("POST", "/bind", { kind, name, routine: "r1", ...extra });
  return body.request("POST", "/bind", { kind, name, routine: "r1", on: ["chat"], ...extra });
}

/** The kinds that hold `name`, as the agent sees them. */
async function holders(body: FakeBody, name: string): Promise<Kind[]> {
  return (await listed(body)).filter((binding) => binding.name === name).map((binding) => binding.kind).sort();
}

describe("names across kinds", () => {
  it("refuse the second claim of a name with 409, for every pair of kinds in either order, and leave the first claim as it was", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      for (const first of KINDS) {
        for (const second of KINDS) {
          const name = `${first}-then-${second}`;
          assert.equal((await claim(body, first, name)).status, 200, `${first} claims ${name}`);
          if (first === second) {
            // The same kind replaces.
            const again = await claim(body, second, name);
            assert.equal(again.status, 200);
            assert.equal((again.body as { replaced: boolean }).replaced, true, `${second} re-claims ${name}`);
          } else {
            const refused = await claim(body, second, name);
            assert.equal(refused.status, 409, `${second} claims ${name} held by ${first}: ${JSON.stringify(refused.body)}`);
            assert.match((refused.body as { error: string }).error, /share their names/);
          }
          assert.deepEqual(await holders(body, name), [first], `${name}`);
        }
      }
    });
  });
});

describe("reflex bindings persist", () => {
  const FIELDS = [
    { name: "greet", routine: "r1", on: ["chat"], from: "ana", match: "^hi", when: "event.data.message.length < 9", cooldownMs: 250, timeoutMs: 4000, preempt: true, priority: 3 },
    { name: "quiet", routine: "r2", on: ["hurt", "death"], enabled: false },
    { name: "plain", routine: "r3", on: ["chat"] },
  ];

  it("lists the same reflexes, whatever the actions around them, after a host SIGKILL and after a body restart", { timeout: 40_000 }, async () => {
    const body = await startFakeBody();
    let restarted: FakeBody | undefined;
    try {
      body.writeRoutines({ r1: "export default () => 'r1';\n", r2: "export default () => 'r2';\n", r3: "export default () => 'r3';\n", pidr: PID });
      await body.ok("POST", "/bind", { kind: "action", name: "pidr", routine: "pidr" });
      await body.ok("POST", "/bind", { kind: "action", name: "mid", routine: "r1" });
      for (const fields of FIELDS) assert.equal(((await body.ok("POST", "/bind", { kind: "reflex", ...fields })) as { replaced: boolean }).replaced, false);
      // A rebind replaces: the last write wins, and the old definition is gone.
      await body.ok("POST", "/bind", { kind: "reflex", name: "plain", routine: "r2", on: ["death"], priority: -4 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "gone", routine: "r1", on: ["chat"] });
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "gone" }), { unbound: "gone" });
      const before = await listed(body);
      assert.deepEqual(before.map((binding) => [binding.kind, binding.name]), [["reflex", "greet"], ["action", "mid"], ["action", "pidr"], ["reflex", "plain"], ["reflex", "quiet"]]);
      const greet = before.find((binding) => binding.name === "greet");
      assert.deepEqual(greet?.kind === "reflex" && [greet.from, greet.match, greet.when, greet.cooldownMs, greet.timeoutMs, greet.preempt, greet.priority], ["ana", "^hi", "event.data.message.length < 9", 250, 4000, true, 3]);

      // Reflexes live in the triggers' file, with a routine for a program; actions stay in bindings.json.
      const stored = JSON.parse(readFileSync(path.join(body.stateDir, "triggers.json"), "utf8")) as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(stored).sort(), ["greet", "plain", "quiet"]);
      for (const entry of Object.values(stored)) assert.deepEqual([typeof entry.routine, "run" in entry], ["string", false]);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")) as object).sort(), ["mid", "pidr"]);

      const pid = await hostPid(body);
      const since = body.events.since(0, 1000).next;
      process.kill(pid as number, "SIGKILL");
      await body.waitFor("connected", since);
      assert.deepEqual(await listed(body), before, "after the host was killed");

      await body.close();
      restarted = await startFakeBody({ stateDir: body.stateDir });
      assert.deepEqual(await listed(restarted), before, "after the body restarted");
      assert.deepEqual(restarted.eventsOf("binding_error"), []);
      assert.deepEqual(restarted.eventsOf("reflex_error"), []);
    } finally {
      await body.close();
      await restarted?.close();
    }
  });

  it("gives a name held by an action in bindings.json and a reflex in triggers.json to the reflex: the action is skipped, kept in the file, and reported", async () => {
    const reflex = { on: ["chat"], routine: "r1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };
    const body = await startFakeBody({
      stateFiles: {
        "bindings.json": { clash: { kind: "action", routine: "r2" }, mine: { kind: "action", routine: "r2" } },
        "triggers.json": { clash: reflex },
      },
    });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 'r1';\n", r2: "export default () => 'r2';\n" });
      const bindings = await listed(body);
      assert.deepEqual(bindings.map((binding) => [binding.kind, binding.name, binding.routine]), [["reflex", "clash", "r1"], ["action", "mine", "r2"]]);
      const errors = body.eventsOf("binding_error");
      assert.deepEqual(errors.map((event) => event.data.name), ["clash"]);
      assert.match(String(errors[0]!.data.error), /is also a reflex, which takes the name; unbind it, then restart the body to use this action$/);
      assert.equal((await body.request("POST", "/call", { name: "clash" })).status, 404, "the skipped action is not callable");
      // The entry waits in the file: another bind rewrites the file with it still there.
      await body.ok("POST", "/bind", { kind: "action", name: "other", routine: "r1" });
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")) as object).sort(), ["clash", "mine", "other"]);
    });
  });
});

describe("no module is evaluated until a reflex fires", () => {
  it("leaves no marker from binding, listing, rebinding, or unbinding a reflex, and the first firing evaluates the routine's module", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      const marker = path.join(body.stateDir, "marker");
      body.writeRoutines({ marked: `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nexport default () => 1;\n` });
      body.writeRoutines({ chatter: "export default (ctx: { bot: { emit(event: string, ...args: unknown[]): void } }) => {\n  ctx.bot.emit('chat', 'ana', 'go');\n};\n" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "rfx", routine: "marked", on: ["chat"], cooldownMs: 0 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "rfx", routine: "marked", on: ["hurt"], cooldownMs: 0 });
      await listed(body);
      await body.ok("POST", "/bind", { kind: "reflex", name: "again", routine: "marked", on: ["never"] });
      await body.ok("POST", "/unbind", { name: "again" });
      assert.equal(existsSync(marker), false, "a module's top level ran");
      await body.ok("POST", "/bind", { kind: "reflex", name: "rfx", routine: "marked", on: ["chat"], cooldownMs: 0 });
      await body.ok("POST", "/bind", { kind: "action", name: "chatter", routine: "chatter" });
      runOf(await body.request("POST", "/call", { name: "chatter" }));
      await body.waitFor("reflex_finished");
      assert.equal(readFileSync(marker, "utf8"), "x");
    });
  });
});

describe("reflexes and the body's features", () => {
  it("skips and reports stored entries on a body without routines, and never writes triggers.json for them, whatever fires", { timeout: 20_000 }, async () => {
    const stateFiles = { "triggers.json": { rfx: reflexEntry, tgr: codeEntry } };
    const body = await startFakeBody({ init: { routines: false }, stateFiles });
    await using(body, async () => {
      const file = path.join(body.stateDir, "triggers.json");
      const before = readFileSync(file, "utf8");
      assert.deepEqual(body.eventsOf("reflex_error").map((event) => event.data.name), ["rfx", "tgr"]);
      for (let i = 0; i < 3; i++) runOf(await body.request("POST", "/run", { code: "export default (ctx) => ctx.bot.emit('chat', 'ana', 'go');" }));
      await sleep(200);
      assert.deepEqual(body.eventsOf("reflex_fired"), [], "nothing fires on a body without routines");
      assert.equal(readFileSync(file, "utf8"), before, "triggers.json was written");
      assert.equal((await body.request("GET", "/bindings")).status, 404);
    });
  });

  it("refuses a reflex bind on a body without reflexes with 400 naming reflexes, still binds actions, and leaves triggers.json alone", async () => {
    const body = await startFakeBody({ init: { triggers: false }, stateFiles: { "triggers.json": { rfx: reflexEntry } } });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      const refused = await claim(body, "reflex", "fresh");
      assert.equal(refused.status, 400);
      assert.match((refused.body as { error: string }).error, /does not offer reflexes/);
      assert.equal((await claim(body, "action", "act")).status, 200);
      assert.deepEqual((await listed(body)).map((binding) => [binding.kind, binding.name]), [["action", "act"]]);
      assert.equal(JSON.parse(readFileSync(path.join(body.stateDir, "triggers.json"), "utf8")).fresh, undefined);
      assert.equal((await body.request("GET", "/triggers")).status, 404);
    });
  });
});

describe("a reflex's invalid match, on every bind path", () => {
  const BAD = ["a(", "[", "(?<x", "*"];
  const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
  let body: FakeBody;
  let server: Server;
  let env: Record<string, string>;
  const mcp = new Client({ name: "test", version: "0" });

  before(async () => {
    body = await startFakeBody();
    body.writeRoutines({ r1: "export default () => 1;\n" });
    // The body's API over HTTP, as the daemon's transport hands each request to the host.
    server = createServer(async (req, res) => {
      const raw = await text(req);
      const answer = await body.request(req.method!, req.url!, raw === "" ? undefined : JSON.parse(raw));
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    env = { ...process.env, MINEBOT_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, MINEBOT_TOKEN: "" } as Record<string, string>;
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env, stderr: "ignore" }));
  });
  after(async () => {
    await mcp.close();
    server.close();
    await body.close();
  });

  /** Asserts that no reflex `name` was bound or stored. */
  async function nothingStored(name: string): Promise<void> {
    assert.equal((await listed(body)).some((binding) => binding.name === name), false, `${name} was bound`);
    const file = path.join(body.stateDir, "triggers.json");
    assert.equal(existsSync(file) && name in (JSON.parse(readFileSync(file, "utf8")) as object), false, `${name} was stored`);
  }

  it("is refused over HTTP POST /bind with 400 naming match, and nothing is stored", async () => {
    for (const match of BAD) {
      const answer = await body.request("POST", "/bind", { kind: "reflex", name: "bad-http", routine: "r1", on: ["chat"], match });
      assert.deepEqual(answer, { status: 400, body: { error: "✖ must be a regular expression\n  → at match" } }, match);
    }
    await nothingStored("bad-http");
  });

  it("is refused by `minebot bind reflex --match` with the 400's error naming match, and nothing is stored", { timeout: 60_000 }, async () => {
    for (const match of BAD) {
      const cli = await promisify(execFile)(process.execPath, [...CLI, "bind", "reflex", "bad-cli", "r1", "--on", "chat", "--match", match], { env }).then(
        () => ({ code: 0, err: "" }),
        (error: { code: number; stderr: string }) => ({ code: error.code, err: error.stderr }),
      );
      assert.deepEqual(cli, { code: 1, err: "[minebot] ✖ must be a regular expression\n  → at match\n" }, match);
    }
    await nothingStored("bad-cli");
  });

  it("is refused by the MCP bind_routine tool naming match, and nothing is stored", async () => {
    for (const match of BAD) {
      const tool = (await mcp.callTool({ name: "bind_routine", arguments: { kind: "reflex", name: "bad-mcp", routine: "r1", on: ["chat"], match } })) as { content: { text: string }[]; isError?: boolean };
      assert.deepEqual([tool.isError, tool.content[0]!.text], [true, "MCP error -32602: Input validation error: Invalid arguments for tool bind_routine: must be a regular expression at match"], match);
    }
    await nothingStored("bad-mcp");
  });
});

/** B1: what a bind of a routine the library lacks answers, in full, whichever way it comes in. */
const NO_ROUTINE = (name: string): string =>
  `no routine named "${name}" in this body's routine library; save it first: pass its TypeScript as \`source\` to bind_routine (or routine_save), or run \`npx minebot routines save <file>.ts\`, then bind again`;

describe("a bind of a routine the library lacks (B1)", () => {
  let body: FakeBody;
  let server: Server;
  const mcp = new Client({ name: "test", version: "0" });

  before(async () => {
    body = await startFakeBody();
    body.writeRoutines({ r1: "export default () => 1;\n" });
    server = createServer(async (req, res) => {
      const raw = await text(req);
      const answer = await body.request(req.method!, req.url!, raw === "" ? undefined : JSON.parse(raw));
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = { ...process.env, MINEBOT_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, MINEBOT_TOKEN: "" } as Record<string, string>;
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts"), "mcp"], env, stderr: "ignore" }));
  });
  after(async () => {
    await mcp.close();
    server.close();
    await body.close();
  });

  const asked = { action: { kind: "action", name: "act", routine: "ghost" }, reflex: { kind: "reflex", name: "rfx", routine: "ghost", on: ["hurt"] } } as const;

  for (const kind of KINDS) {
    it(`answers a ${kind} bind over HTTP with 404 naming the routine, the library, and both ways to save it, and binds nothing`, async () => {
      assert.deepEqual(await body.request("POST", "/bind", asked[kind]), { status: 404, body: { error: NO_ROUTINE("ghost") } });
      assert.deepEqual(await listed(body), []);
    });

    it(`gives a ${kind} bind_routine call without source that same message as the tool's answer`, async () => {
      const answer = (await mcp.callTool({ name: "bind_routine", arguments: asked[kind] })) as { content: { text: string }[]; isError?: boolean };
      assert.deepEqual([answer.isError, answer.content[0]!.text], [true, NO_ROUTINE("ghost")]);
      assert.deepEqual(await listed(body), []);
    });
  }
});

describe("stored entries the reflexes skip", () => {
  const stored = { code: codeEntry, "key.login": { ...codeEntry, run: "bot.chat('/key x')" }, junk: { on: "hurt", routine: 5 }, good: reflexEntry };
  const triggersFile = (body: FakeBody) => JSON.parse(readFileSync(path.join(body.stateDir, "triggers.json"), "utf8")) as Record<string, unknown>;
  /** The JSON text of the skipped entries, as the file holds them. */
  const skippedText = (body: FakeBody, names: string[]) => Object.fromEntries(names.map((name) => [name, JSON.stringify(triggersFile(body)[name])]));

  it("report each once, hold their names against actions and reflexes with 409 naming them, and are deleted by an unbind of their name", { timeout: 30_000 }, async () => {
    const body = await startFakeBody({ stateFiles: { "triggers.json": stored } });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      const errors = body.eventsOf("reflex_error");
      assert.deepEqual(errors.map((event) => event.data.name), ["code", "key.login", "junk"]);
      assert.match(String(errors[0]!.data.error), /code trigger.*bind a routine as a reflex after `unbind code`/);
      assert.deepEqual((await listed(body)).map((binding) => [binding.kind, binding.name]), [["reflex", "good"]]);
      const before = skippedText(body, ["code", "key.login", "junk"]);

      for (const name of ["code", "junk"]) {
        for (const kind of ["action", "reflex"] as const) {
          const refused = await claim(body, kind, name);
          assert.equal(refused.status, 409, `${kind} ${name}`);
          assert.match((refused.body as { error: string }).error, new RegExp(`^"${name}" is a stored entry this body did not load`));
        }
      }
      // Any other sequence of binds, unbinds, rebinds, and the firings they cause leaves the entries as they were.
      for (const name of ["fresh", "other"]) assert.equal((await claim(body, "reflex", name)).status, 200);
      assert.equal((await claim(body, "action", "act")).status, 200);
      assert.equal((await claim(body, "reflex", "good")).status, 200);
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "other" }), { unbound: "other" });
      assert.equal((await body.request("POST", "/unbind", { name: "missing" })).status, 404);
      assert.deepEqual(skippedText(body, ["code", "key.login", "junk"]), before);

      // An unbind of a dotted stored name deletes exactly that entry; the name is free for a bind that spells it, where it can.
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "key.login" }), { unbound: "key.login" });
      assert.deepEqual(Object.keys(triggersFile(body)).sort(), ["code", "fresh", "good", "junk"]);
      assert.deepEqual(skippedText(body, ["code", "junk"]), { code: before.code, junk: before.junk });
      assert.equal((await body.request("POST", "/unbind", { name: "key.login" })).status, 404, "the entry is gone");
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "code" }), { unbound: "code" });
      assert.equal((await claim(body, "action", "code")).status, 200, "a deleted entry frees its name");
      assert.equal((await body.request("POST", "/bind", { kind: "action", name: "key.login", routine: "r1" })).status, 400, "a dotted name is never a binding");
    });
  });

  it("count toward the limit of 50: with 49 of them and a reflex, a new reflex is refused with the limit error, and an unbind frees a slot", { timeout: 30_000 }, async () => {
    const entries: Record<string, unknown> = { r: reflexEntry };
    for (let i = 0; i < 49; i++) entries[`c${i}`] = { ...codeEntry, run: `return ${i}` };
    const body = await startFakeBody({ stateFiles: { "triggers.json": entries } });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      assert.equal(body.eventsOf("reflex_error").length, 49);
      const refused = await claim(body, "reflex", "one-more");
      assert.equal(refused.status, 409);
      assert.match((refused.body as { error: string }).error, /at most 50 reflexes/);
      assert.equal((await claim(body, "reflex", "r")).status, 200, "a rebind of the reflex is not a new name");
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "c0" }), { unbound: "c0" });
      assert.equal((await claim(body, "reflex", "one-more")).status, 200);
      assert.equal((await claim(body, "reflex", "and-another")).status, 409);
    });
  });

  it("hold a name against an action stored in bindings.json too: the action is skipped, kept in the file, and reported", async () => {
    const body = await startFakeBody({
      stateFiles: {
        "bindings.json": { code: { kind: "action", routine: "r1" }, junk: { kind: "action", routine: "r1" }, mine: { kind: "action", routine: "r1" } },
        "triggers.json": stored,
      },
    });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      assert.deepEqual((await listed(body)).map((binding) => [binding.kind, binding.name]), [["reflex", "good"], ["action", "mine"]]);
      const errors = body.eventsOf("binding_error");
      assert.deepEqual(errors.map((event) => event.data.name), ["code", "junk"]);
      assert.match(String(errors[0]!.data.error), /^"code" is also a stored entry the reflexes skipped, which takes the name; unbind it, then restart the body to use this action$/);
      assert.equal((await body.request("POST", "/call", { name: "code" })).status, 404, "the skipped action is not callable");
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")) as object), ["code", "junk", "mine"]);
    });
  });

  it("stay in the file for a body at the Round B tip, which reads every code trigger as it did", async () => {
    const body = await startFakeBody({ stateFiles: { "triggers.json": stored } });
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      await claim(body, "reflex", "rfx");
      assert.equal((await body.request("POST", "/unbind", { name: "rfx" })).status, 200);
      await claim(body, "reflex", "rfx2");
      const file = triggersFile(body) as Record<string, Record<string, unknown>>;
      for (const name of ["code", "key.login"] as const) {
        const parsed = BaseStored.safeParse({ ...file[name], name });
        assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
        assert.deepEqual(parsed.data, { ...stored[name], name }, "the code before reflexes reads every field as it was written");
      }
      assert.equal(BaseStored.safeParse({ ...file.rfx2, name: "rfx2" }).success, false, "a reflex entry is not a code trigger to the code before");
    });
  });
});
