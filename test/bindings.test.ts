// Action bindings through the real bot host (see fixtures/host/fake-body.ts): the last-write-wins
// map, its persistence across a host SIGKILL and a body restart, the entries a body skips, the
// names it refuses, and that nothing here ever evaluates a routine's module.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { BindingInfo, RunResult } from "../src/protocol/index.ts";
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
        { kind: "reflex", name: "act", routine: "r1", on: ["chat"] },
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
