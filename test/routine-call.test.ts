// A call of an action binding is one recorded run: through the real bot host (real Connection,
// Body, world, routes, triggers, and bindings over a fake player, see fixtures/host/fake-body.ts)
// under the real supervisor, with a short kill grace.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, GRACE_MS, removeScratch, startFakeBody, type FakeBodyOptions } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const SLEEPER = "export default async (ctx: { sleep(ms: number): Promise<void> }) => {\n  await ctx.sleep(30_000);\n};\n";
const BLOCKER = "export default (): never => {\n  for (;;) {}\n};\n";
const PID = "export default () => process.pid;\n";
const ADDER = "export default async (_ctx: unknown, args: { a: number; b: number }) => ({ sum: args.a + args.b });\n";
const ECHO = "export default (_ctx: unknown, args: unknown) => args;\n";

/** A body with the routines written, each bound to the action of its own name. */
async function bodyWith(routines: Record<string, string>, options: FakeBodyOptions = {}): Promise<FakeBody> {
  const body = await startFakeBody(options);
  body.writeRoutines(routines);
  for (const name of Object.keys(routines)) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
  return body;
}

async function using(body: FakeBody, test: () => Promise<void>): Promise<void> {
  try {
    await test();
  } finally {
    await body.close();
  }
}

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

/** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
async function running(body: FakeBody): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
  assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
  await sleep(150);
}

describe("POST /call", () => {
  it("runs the bound routine once, as one recorded run: the history line, the result, and one program_finished", async () => {
    const body = await bodyWith({ adder: ADDER, echo: ECHO });
    await using(body, async () => {
      const run = runOf(await body.request("POST", "/call", { name: "adder", args: { a: 2, b: 40 } }));
      assert.equal(run.status, "ok");
      assert.deepEqual(run.result, { sum: 42 });
      const lines = body.history();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.code, "");
      assert.deepEqual(lines[0]!.call, { name: "adder", routine: "adder", args: { a: 2, b: 40 } });
      assert.equal(lines[0]!.status, "ok");
      assert.equal(body.eventsOf("program_finished").length, 1);

      // The args are the request's, as given.
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "echo", args: { deep: [1, { x: null }] } })).result, { deep: [1, { x: null }] });
      assert.deepEqual(body.history()[1]!.call, { name: "echo", routine: "echo", args: { deep: [1, { x: null }] } });
      assert.equal(body.eventsOf("program_finished").length, 2);
    });
  });

  it("answers a name bound to a routine under another name by the routine's own module, and a name nothing is bound to with 404", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ adder: ADDER });
      await body.ok("POST", "/bind", { kind: "action", name: "plus", routine: "adder" });
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "plus", args: { a: 1, b: 1 } })).result, { sum: 2 });
      assert.deepEqual(body.history()[0]!.call, { name: "plus", routine: "adder", args: { a: 1, b: 1 } });
      const unknown = await body.request("POST", "/call", { name: "adder" });
      assert.equal(unknown.status, 404);
      assert.equal(body.history().length, 1, "a refused call is not a run");
    });
  });

  it("is refused with 409 while a call, a program, or its own twin runs, and the refusal is not a run", async () => {
    const body = await bodyWith({ sleeper: SLEEPER, echo: ECHO });
    await using(body, async () => {
      const first = body.request("POST", "/call", { name: "sleeper" });
      await running(body);
      for (const refused of [await body.request("POST", "/call", { name: "echo" }), await body.request("POST", "/call", { name: "sleeper" }), await body.request("POST", "/run", { code: "return 1" })]) {
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
      }
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal(runOf(await first).status, "stopped");
      assert.equal(body.history().length, 1);

      // The other direction: a program is running.
      const program = body.request("POST", "/run", { code: "await sleep(30000)" });
      await running(body);
      assert.equal((await body.request("POST", "/call", { name: "echo" })).status, 409);
      await body.host.stop();
      assert.equal(runOf(await program).status, "stopped");
      assert.equal(runOf(await body.request("POST", "/call", { name: "echo" })).status, "ok");
    });
  });

  it("is aborted by /stop and by its own timeout", async () => {
    const body = await bodyWith({ sleeper: SLEEPER });
    await using(body, async () => {
      const stopped = body.request("POST", "/call", { name: "sleeper" });
      await running(body);
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal(runOf(await stopped).status, "stopped");

      const timeout = runOf(await body.request("POST", "/call", { name: "sleeper", timeoutMs: 300 }));
      assert.equal(timeout.status, "timeout");
      assert.deepEqual(
        body.history().map((line) => [(line.call as { name: string }).name, line.status]),
        [
          ["sleeper", "stopped"],
          ["sleeper", "timeout"],
        ],
      );
    });
  });

  it("kills a routine that blocks the host by the supervisor's deadline, answers with the restarted error, and keeps the bindings", { timeout: 30_000 }, async () => {
    const body = await bodyWith({ blocker: BLOCKER, pid: PID });
    await using(body, async () => {
      const before = runOf(await body.request("POST", "/call", { name: "pid" })).result;
      const started = Date.now();
      const since = body.events.since(0, 1000).next;
      const run = runOf(await body.request("POST", "/call", { name: "blocker", timeoutMs: 200 }));
      assert.ok(Date.now() - started < 200 + GRACE_MS + 500 + 4_000, `took ${Date.now() - started} ms`);
      assert.equal(run.error, restartedError(hungCause(GRACE_MS)));
      assert.equal(body.eventsOf("program_finished").filter((event) => event.data.status !== "ok").length, 1, "the supervisor ends the killed call once");
      // The replacement host announces itself; a request sent before that may meet the dying one.
      await body.waitFor("connected", since);
      const after = runOf(await body.request("POST", "/call", { name: "pid" })).result;
      assert.notEqual(after, before, "the host was replaced");
      const blocked = body.history().filter((line) => (line.call as { name: string }).name === "blocker");
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.status, run.status);
    });
  });

  it("starts a firing queued during the call when the call ends, though no event echo tells the triggers", { timeout: 30_000 }, async () => {
    const chatter = "export default async (ctx: { bot: { emit(event: string, ...args: unknown[]): void }; sleep(ms: number): Promise<void> }) => {\n  ctx.bot.emit('chat', 'alice', 'go');\n  await ctx.sleep(400);\n  return 'done';\n};\n";
    // The echo of program_finished would also wake the triggers; here only the call's own end can.
    const body = await bodyWith({ chatter }, { dropEchoes: ["program_finished"] });
    await using(body, async () => {
      await body.ok("POST", "/triggers", { name: "reflex", on: ["chat"], run: "return 1", cooldownMs: 0 });
      const run = runOf(await body.request("POST", "/call", { name: "chatter" }));
      assert.equal(run.result, "done");
      const finished = await body.waitFor("trigger_finished");
      assert.equal(finished.data.name, "reflex");
      assert.equal(finished.data.status, "ok");
      const [fired] = body.eventsOf("trigger_fired");
      assert.equal(body.eventsOf("trigger_fired").length, 1);
      const [ended] = body.eventsOf("program_finished");
      assert.ok(fired!.seq > ended!.seq, "the firing started after the call ended");
    });
  });

  it("ends in status error with the routine's frames when it throws, and loads imports: vec3, a saved helper", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      const helper = "export function explode(): never {\n  throw new Error('boom');\n}\n";
      const act = "import { Vec3 } from 'vec3';\nimport { explode } from './helper.ts';\nexport default async (_ctx: unknown, args: { fail?: boolean }) => {\n  if (args.fail) explode();\n  return new Vec3(1, 2, 3).offset(1, 1, 1).toArray();\n};\n";
      for (const [name, source] of [["helper", helper], ["act", act]] as const) {
        const saved = (await body.ok("POST", "/routines/save", { name, source })) as { routine: { name: string }; typeCheck: { status: string } };
        assert.equal(saved.routine.name, name);
        assert.equal(saved.typeCheck.status, "passed", JSON.stringify(saved));
      }
      await body.ok("POST", "/bind", { kind: "action", name: "act", routine: "act" });
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "act", args: {} })).result, [2, 3, 4]);
      const failed = runOf(await body.request("POST", "/call", { name: "act", args: { fail: true } }));
      assert.equal(failed.status, "error");
      assert.match(failed.error ?? "", /^Error: boom\n/);
      assert.match(failed.error ?? "", new RegExp(`${RegExp.escape(path.join(body.routinesDir, "helper.ts"))}:2:`));
      assert.match(failed.error ?? "", new RegExp(`${RegExp.escape(path.join(body.routinesDir, "act.ts"))}:4:`));
    });
  });
});

describe("a routine's ctx", () => {
  const KEYS = "export default (ctx: object) => Object.keys(ctx).sort();\n";
  const BASE = ["bot", "log", "notes", "on", "signal", "sleep", "status", "store"];
  const kitsOptions: [string, FakeBodyOptions["init"], string[]][] = [
    ["with kits", {}, ["kit"]],
    ["without kits", { kits: [], lockKits: true }, []],
  ];
  const wikiOptions: [string, FakeBodyOptions["init"], string[]][] = [
    ["wiki off", { wikiMode: "off" }, []],
    ["wiki read", { wikiMode: "read" }, ["wiki"]],
    ["wiki write", { wikiMode: "write" }, ["wiki"]],
  ];
  for (const [kitsName, kits, kitKeys] of kitsOptions) {
    for (const [wikiName, wiki, wikiKeys] of wikiOptions) {
      it(`has exactly bot, log, sleep, signal, on, notes, status${kitKeys.length ? ", kit" : ""}${wikiKeys.length ? ", wiki" : ""} on a body ${kitsName}, ${wikiName}`, async () => {
        const body = await bodyWith({ keys: KEYS }, { init: { ...kits, ...wiki } });
        await using(body, async () => {
          const keys = runOf(await body.request("POST", "/call", { name: "keys" })).result;
          assert.deepEqual(keys, [...BASE, ...kitKeys, ...wikiKeys].sort());
        });
      });
    }
  }

  it("shares the body's notes and status with programs, and offers the kits' actions as ctx.kit", async () => {
    const probe = "export default async (ctx: { notes: { get(key: string): string | undefined }; status(): Promise<{ connected: boolean }>; kit?: Record<string, unknown> }) => ({ note: ctx.notes.get('shared'), connected: (await ctx.status()).connected, kits: Object.keys(ctx.kit ?? {}).includes('move') });\n";
    const setter = "export default (ctx: { notes: { set(key: string, text: string): void } }) => {\n  ctx.notes.set('shared', 'from a program');\n};\n";
    const body = await bodyWith({ probe, setter });
    await using(body, async () => {
      assert.equal(runOf(await body.request("POST", "/call", { name: "setter" })).status, "ok");
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "probe" })).result, { note: "from a program", connected: true, kits: true });
    });
  });
});

describe("a call evaluates a module only inside its run", () => {
  it("evaluates the top level of a routine at /call, with the routine's own module, and not before", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      const marker = path.join(body.stateDir, "evaluated");
      const source = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nexport default () => "ran";\n`;
      await body.ok("POST", "/routines/save", { name: "marked", source });
      await body.ok("POST", "/bind", { kind: "action", name: "marked", routine: "marked" });
      assert.equal(existsSync(marker), false, "saving and binding evaluated the module");
      assert.equal(runOf(await body.request("POST", "/call", { name: "marked" })).result, "ran");
      assert.equal(existsSync(marker), true);
    });
  });
});

describe("a reflex's run is a call's, fired by an event", () => {
  const chatter = "export default async (ctx: { bot: { emit(event: string, ...args: unknown[]): void }; sleep(ms: number): Promise<void> }) => {\n  ctx.bot.emit('chat', 'alice', 'go');\n  await ctx.sleep(400);\n  return 'done';\n};\n";
  const KEYS = "export default (ctx: object) => Object.keys(ctx).sort();\n";
  // Notes what the reflex was given, so the firing's own arguments can be read back.
  const NOTES = "export default (ctx: { notes: { set(key: string, text: string): void } }, args: { event: { type: string } }) => {\n  ctx.notes.set('given', JSON.stringify({ keys: Object.keys(ctx).sort(), args: Object.keys(args), type: args.event.type }));\n};\n";
  const READER = "export default (ctx: { notes: { get(key: string): string | undefined } }) => ctx.notes.get('given');\n";

  it("starts a reflex's firing queued during a call when the call ends, though no event echo tells the triggers", { timeout: 30_000 }, async () => {
    const body = await bodyWith({ chatter, keys: KEYS }, { dropEchoes: ["program_finished"] });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "reflex", routine: "keys", on: ["chat"], cooldownMs: 0 });
      const run = runOf(await body.request("POST", "/call", { name: "chatter" }));
      assert.equal(run.result, "done");
      const finished = await body.waitFor("trigger_finished");
      assert.deepEqual([finished.data.name, finished.data.status], ["reflex", "ok"]);
      const [fired] = body.eventsOf("trigger_fired");
      assert.equal(body.eventsOf("trigger_fired").length, 1);
      const [ended] = body.eventsOf("program_finished");
      assert.ok(fired!.seq > ended!.seq, "the firing started after the call ended");
    });
  });

  it("gets exactly the ctx a call gets, and one argument: { event }", async () => {
    const body = await bodyWith({ keys: KEYS, notes: NOTES, chatter, reader: READER });
    await using(body, async () => {
      const called = runOf(await body.request("POST", "/call", { name: "keys" })).result;
      assert.deepEqual(called, ["bot", "kit", "log", "notes", "on", "signal", "sleep", "status", "store", "wiki"]);
      await body.ok("POST", "/bind", { kind: "reflex", name: "reflex", routine: "notes", on: ["chat"], cooldownMs: 0 });
      runOf(await body.request("POST", "/call", { name: "chatter" }));
      assert.equal((await body.waitFor("trigger_finished")).data.status, "ok");
      const given = runOf(await body.request("POST", "/call", { name: "reader" })).result;
      assert.deepEqual(JSON.parse(String(given)), { keys: called, args: ["event"], type: "chat" });
    });
  });
});
