// Action bindings through the real bot host (see fixtures/host/fake-body.ts): the last-write-wins
// map, its persistence across a host SIGKILL and a body restart, the entries a body skips, the
// names it refuses, and that nothing here ever evaluates a routine's module.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
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

  it("refuses a name that is a code trigger with 409, an unknown routine with 404, and a bad request with 400, and each leaves the bindings alone", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      await body.ok("POST", "/triggers", { name: "eat", on: ["hurt"], run: "return 1" });
      assert.equal((await body.request("POST", "/bind", { kind: "action", name: "eat", routine: "r1" })).status, 409);
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

  it("refuse a dotted name on every bind, unbind, and call path with 400 and the name rule's message, and none is stored", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      for (const name of ["move.to", "a.b", ".x", "Bad"]) {
        for (const [url, request] of [
          ["/bind", { kind: "action", name, routine: "r1" }],
          ["/unbind", { name }],
          ["/call", { name }],
        ] as const) {
          assert.deepEqual(await body.request("POST", url, request), { status: 400, body: RULE }, `${url} ${name}`);
        }
      }
      assert.deepEqual(await listed(body), []);
      assert.equal(existsSync(path.join(body.stateDir, "bindings.json")), false);
      assert.equal((await body.request("POST", "/bind", { kind: "action", name: "x1", routine: "r1" })).status, 200);
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

const reflexEnabled = async (body: FakeBody, name: string): Promise<boolean | undefined> => {
  const found = (await listed(body)).find((binding) => binding.name === name);
  return found?.kind === "reflex" ? found.enabled : undefined;
};

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

type Kind = "action" | "reflex" | "code";
const KINDS: Kind[] = ["action", "reflex", "code"];

/** One claim of `name` by a binding or trigger of `kind`, over HTTP. */
function claim(body: FakeBody, kind: Kind, name: string, extra: Record<string, unknown> = {}) {
  if (kind === "action") return body.request("POST", "/bind", { kind, name, routine: "r1", ...extra });
  if (kind === "reflex") return body.request("POST", "/bind", { kind, name, routine: "r1", on: ["chat"], ...extra });
  return body.request("POST", "/triggers", { name, on: ["hurt"], run: "return 1", ...extra });
}

const triggersOf = async (body: FakeBody) => ((await body.ok("GET", "/triggers")) as { triggers: { name: string }[] }).triggers;

/** The kinds that hold `name`, as the agent sees them. */
async function holders(body: FakeBody, name: string): Promise<Kind[]> {
  const kinds: Kind[] = (await listed(body)).filter((binding) => binding.name === name).map((binding) => binding.kind);
  if ((await triggersOf(body)).some((trigger) => trigger.name === name)) kinds.push("code");
  return kinds.sort();
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

  it("refuse the code trigger a bound action's name, through POST /triggers and the program's triggers.add", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ pid: PID });
      await body.ok("POST", "/bind", { kind: "action", name: "pid", routine: "pid" });
      assert.equal((await claim(body, "code", "pid")).status, 409);
      const program = runOf(await body.request("POST", "/run", { code: `try { await triggers.add({ name: "pid", on: ["hurt"], run: "1" }); return "added"; } catch (err) { return String(err.message); }` }));
      assert.match(String(program.result), /^"pid" is an action binding; /);
      assert.deepEqual(await triggersOf(body), []);
      assert.deepEqual(((await body.ok("POST", "/call", { name: "pid" })) as RunResult).status, "ok", "the action is still bound");
    });
  });

  it("keep a reflex out of the program's triggers.* and out of /triggers*: it is unknown there", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      await claim(body, "reflex", "rfx");
      await claim(body, "code", "tgr");
      const program = runOf(
        await body.request("POST", "/run", {
          code: `
            const attempt = async (f) => { try { return { ok: await f() }; } catch (err) { return { error: String(err.message) }; } };
            return {
              list: (await triggers.list()).map((t) => t.name),
              remove: await triggers.remove("rfx"),
              enable: await attempt(() => triggers.enable("rfx")),
              disable: await attempt(() => triggers.disable("rfx")),
              add: await attempt(() => triggers.add({ name: "rfx", on: ["hurt"], run: "1" })),
            };`,
        }),
      );
      const seen = program.result as { list: string[]; remove: boolean; enable: unknown; disable: unknown; add: { error: string } };
      assert.deepEqual(seen.list, ["tgr"]);
      assert.equal(seen.remove, false);
      assert.deepEqual(seen.enable, { error: 'no trigger "rfx"' });
      assert.deepEqual(seen.disable, { error: 'no trigger "rfx"' });
      assert.match(seen.add.error, /^"rfx" is a reflex; /);

      assert.deepEqual((await triggersOf(body)).map((trigger) => trigger.name), ["tgr"]);
      assert.equal((await body.request("POST", "/triggers/remove", { name: "rfx" })).status, 404);
      assert.equal((await body.request("POST", "/triggers/enabled", { name: "rfx", enabled: false })).status, 404);
      assert.equal((await claim(body, "code", "rfx")).status, 409);
      // The reflex is untouched by all of it, and unbinding removes it.
      assert.deepEqual(await holders(body, "rfx"), ["reflex"]);
      assert.equal(await reflexEnabled(body, "rfx"), true);
      assert.deepEqual(await body.ok("POST", "/unbind", { name: "rfx" }), { unbound: "rfx" });
      assert.deepEqual(await holders(body, "rfx"), []);
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
      assert.deepEqual(restarted.eventsOf("trigger_error"), []);
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
      assert.match(String(errors[0]!.data.error), /is also a reflex/);
      assert.equal((await body.request("POST", "/call", { name: "clash" })).status, 404, "the skipped action is not callable");
      // The entry waits in the file: another bind rewrites the file with it still there.
      await body.ok("POST", "/bind", { kind: "action", name: "other", routine: "r1" });
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(body.stateDir, "bindings.json"), "utf8")) as object).sort(), ["clash", "mine", "other"]);
    });
  });

  it("applies the same rule to a code trigger holding the name of a stored action", async () => {
    const trigger = { on: ["hurt"], run: "return 1", cooldownMs: 1000, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };
    const body = await startFakeBody({ stateFiles: { "bindings.json": { clash: { kind: "action", routine: "r1" } }, "triggers.json": { clash: trigger } } });
    await using(body, async () => {
      assert.deepEqual(await listed(body), []);
      assert.deepEqual(body.eventsOf("binding_error").map((event) => event.data.name), ["clash"]);
      assert.deepEqual((await triggersOf(body)).map((t) => t.name), ["clash"]);
    });
  });

  it("writes a code trigger the way the code before Round B reads it, and a reflex which that code reports and skips", async () => {
    const body = await startFakeBody();
    await using(body, async () => {
      body.writeRoutines({ r1: "export default () => 1;\n" });
      await claim(body, "code", "tgr", { when: "event.data.health < 5", from: undefined, cooldownMs: 10, priority: 2 });
      await claim(body, "reflex", "rfx");
      const stored = JSON.parse(readFileSync(path.join(body.stateDir, "triggers.json"), "utf8")) as Record<string, Record<string, unknown>>;
      const parsed = BaseStored.safeParse({ ...stored.tgr, name: "tgr" });
      assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
      assert.deepEqual(parsed.data, { ...stored.tgr, name: "tgr" }, "the base schema reads every field as it was written");
      assert.equal(BaseStored.safeParse({ ...stored.rfx, name: "rfx" }).success, false, "a reflex entry is not a trigger to the code before");
    });
  });
});

describe("reflexes and the body's features", () => {
  const reflexEntry = { on: ["chat"], routine: "r1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };
  const codeEntry = { on: ["chat"], run: "return 1", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, updated: "2026-01-01T00:00:00.000Z" };

  it("skips and reports stored reflexes on a body without routines, and never writes triggers.json for them, whatever fires", { timeout: 20_000 }, async () => {
    const stateFiles = { "triggers.json": { rfx: reflexEntry, tgr: codeEntry } };
    const body = await startFakeBody({ init: { routines: false }, stateFiles });
    await using(body, async () => {
      const file = path.join(body.stateDir, "triggers.json");
      const before = readFileSync(file, "utf8");
      assert.deepEqual(body.eventsOf("trigger_error").map((event) => event.data.name), ["rfx"]);
      assert.deepEqual((await triggersOf(body)).map((trigger) => trigger.name), ["tgr"]);
      for (let i = 0; i < 3; i++) {
        runOf(await body.request("POST", "/run", { code: "bot.emit('chat', 'ana', 'go')" }));
        for (const deadline = Date.now() + 5_000; body.eventsOf("trigger_finished").length <= i && Date.now() < deadline; ) await sleep(20);
      }
      assert.equal(body.eventsOf("trigger_finished").length, 3, "the code trigger fired on each event");
      assert.deepEqual([...new Set(body.eventsOf("trigger_fired").map((event) => event.data.name))], ["tgr"]);
      assert.equal(readFileSync(file, "utf8"), before, "triggers.json was written");
      assert.equal((await body.request("GET", "/bindings")).status, 404);
    });
  });

  it("refuses a reflex bind on a body without triggers with 400 naming reflexes, still binds actions, and leaves triggers.json alone", async () => {
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
