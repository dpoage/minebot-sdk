// A built-in routine called by name, through the real bot host over a fake player (see
// fixtures/host/fake-body.ts) under the real supervisor with a short kill grace: the call is one
// recorded run with a call's lifecycle, every call of an offered built-in is counted into
// kit-stats.json by the host's one stats writer, and the offer reaches the library loader.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";
import { FakeBody, GRACE_MS, removeScratch, startFakeBody, type FakeBodyOptions } from "./fixtures/host/fake-body.ts";

after(removeScratch);

/** A body started with `options`, closed when `test` ends. */
async function using(options: FakeBodyOptions, test: (body: FakeBody) => Promise<void>): Promise<FakeBody> {
  const body = await startFakeBody(options);
  try {
    await test(body);
  } finally {
    await body.close();
  }
  return body;
}

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

/** What kit-stats.json holds. */
const statsOf = (body: FakeBody): { actions: Record<string, Record<string, { ok: number; failed: number; lastError?: string }>> } =>
  JSON.parse(readFileSync(path.join(body.stateDir, "kit-stats.json"), "utf8"));

/** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
async function running(body: FakeBody): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
  assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
  await sleep(150);
}

/** A routine that gives the fake player a pathfinder that arrives at once, so `move.to` can succeed. */
const ARM = "export default (ctx: { bot: { pathfinder: { goto?: unknown } } }) => {\n  ctx.bot.pathfinder.goto = async () => {};\n};\n";
/** A routine that makes the fake player's inventory block the host's thread when the inventory routines read it (the body reads it too, after every run, and must not block there). */
const JAM =
  "export default (ctx: { bot: { inventory: { items?: unknown } } }) => {\n  ctx.bot.inventory.items = () => {\n    if (/routines[\\\\/]inventory\\./.test(new Error().stack ?? '')) for (;;) {}\n    return [];\n  };\n};\n";

describe("POST /call of a built-in routine", () => {
  it("is one recorded run for every routine of every offered module: answered, one history line `call: { name, args }`, one program_finished", { timeout: 180_000 }, async () => {
    const calls = BUILTIN_MODULES.flatMap((module) => Object.keys(module.routines).map((routine) => `${module.name}.${routine}`));
    assert.ok(calls.length >= 50);
    const timedOut = new Set<string>();
    const body = await using({}, async (body) => {
      for (const [i, name] of calls.entries()) {
        const run = runOf(await body.request("POST", "/call", { name, args: { probe: i }, timeoutMs: 1500 }));
        assert.ok(["ok", "error", "timeout"].includes(run.status), `${name}: ${run.status} ${run.error}`);
        if (run.status === "timeout") timedOut.add(name);
        const lines = body.history();
        assert.equal(lines.length, i + 1, `${name} is one run`);
        const line = lines.at(-1)!;
        assert.deepEqual([line.code, line.call, line.status], ["", { name, args: { probe: i } }, run.status], name);
        // An error that is not a timeout comes from the routine itself, which names itself.
        if (run.status === "error") assert.match(run.error ?? "", new RegExp(`${RegExp.escape(name)}|^\\w*Error: `), name);
      }
      assert.equal(body.eventsOf("program_finished").length, calls.length);
    });
    // Every call that was not cut short by its run's timeout was counted (whether it returned or failed), once; a routine that other built-ins call is counted for their calls too.
    const counted = new Map<string, number>(Object.entries(statsOf(body).actions).flatMap(([module, routines]) => Object.entries(routines).map(([routine, stats]) => [`${module}.${routine}`, stats.ok + stats.failed] as const)));
    assert.ok(timedOut.size <= 3, `calls that waited for something: ${[...timedOut].join(", ")}`);
    for (const module of BUILTIN_MODULES) {
      const used = BUILTIN_MODULES.some((other) => other.uses.includes(module.name));
      for (const routine of Object.keys(module.routines)) {
        const name = `${module.name}.${routine}`;
        const total = counted.get(name);
        // A call cut short by the abort ends in a failure that is not counted.
        if (timedOut.has(name)) assert.ok(total === undefined || used, `${name} timed out and was counted ${total} times`);
        else assert.ok(total !== undefined && total >= 1 && (used || total === 1), `${name} was counted ${total} times`);
      }
    }
  });

  it("answers the parsed return of the routine, the arguments defaults applied", async () => {
    await using({ stateFiles: { "routines/arm.ts": ARM } }, async (body) => {
      await body.ok("POST", "/bind", { kind: "action", name: "arm", routine: "arm" });
      assert.equal(runOf(await body.request("POST", "/call", { name: "arm" })).status, "ok");
      const run = runOf(await body.request("POST", "/call", { name: "move.to", args: { position: [9, 70, 9] } }));
      assert.deepEqual([run.status, run.result], ["ok", { x: 1, y: 64, z: 2 }]);
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "inventory.list" })).result, {});
      const failed = runOf(await body.request("POST", "/call", { name: "move.to", args: { position: "nowhere" } }));
      assert.equal(failed.status, "error");
      assert.match(failed.error ?? "", /^Error: routine "move\.to" arguments: /);
    });
  });

  it("answers 404 naming every dotted name that is not an offered built-in routine, and no run happens", async () => {
    await using({ init: { builtins: ["gatherer"] } }, async (body) => {
      const withheld = BUILTIN_MODULES.filter((module) => !["move", "sense", "dig", "inventory", "items", "gatherer"].includes(module.name));
      assert.equal(withheld.length, 13);
      for (const name of [...withheld.flatMap((module) => Object.keys(module.routines).map((routine) => `${module.name}.${routine}`)), "move.nope", "nope.to", "move.to.again", "move.constructor", "Move.to"]) {
        const answer = await body.request("POST", "/call", { name });
        assert.deepEqual([answer.status, answer.body], [404, { error: `no built-in routine "${name}"` }], name);
      }
      assert.deepEqual(body.history(), [], "a refused call is not a run");
      // An offered one is still called, and a dot-free name is still an action's.
      assert.equal(runOf(await body.request("POST", "/call", { name: "inventory.list" })).status, "ok");
      assert.equal((await body.request("POST", "/call", { name: "act" })).status, 404);
    });
  });

  it("calls a built-in of a body without built-ins as nothing, and an action as before", async () => {
    await using({ init: { builtins: [] }, stateFiles: { "routines/echo.ts": "export default (_ctx: unknown, args: unknown) => args;\n" } }, async (body) => {
      assert.deepEqual(await body.request("POST", "/call", { name: "move.to", args: { position: [1, 2, 3] } }), { status: 404, body: { error: 'no built-in routine "move.to"' } });
      await body.ok("POST", "/bind", { kind: "action", name: "echo", routine: "echo" });
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "echo", args: { a: 1 } })).result, { a: 1 });
      assert.deepEqual(body.history().map((line) => line.call), [{ name: "echo", routine: "echo", args: { a: 1 } }]);
    });
  });

  it("is refused with 409 while a call or a module run executes, in both directions, and the refusal is not a run", async () => {
    await using({}, async (body) => {
      const first = body.request("POST", "/call", { name: "social.waitForChat", args: { timeoutMs: 30_000 } });
      await running(body);
      for (const refused of [await body.request("POST", "/call", { name: "move.stop" }), await body.request("POST", "/call", { name: "social.waitForChat" }), await body.request("POST", "/run", { code: "export default 1;" })]) {
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
      }
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal(runOf(await first).status, "stopped");
      assert.equal(body.history().length, 1);

      // The other direction: a module run is running.
      const program = body.request("POST", "/run", { code: "export default async (ctx: { sleep(ms: number): Promise<void> }) => { await ctx.sleep(30000); };" });
      await running(body);
      assert.equal((await body.request("POST", "/call", { name: "move.stop" })).status, 409);
      await body.host.stop();
      assert.equal(runOf(await program).status, "stopped");
      assert.equal(runOf(await body.request("POST", "/call", { name: "move.stop" })).status, "ok");
      assert.deepEqual(body.history().map((line) => line.status), ["stopped", "stopped", "ok"]);
    });
  });

  it("is aborted by /stop and by its own timeout, and the aborted routine's failure is not counted", async () => {
    const body = await using({}, async (body) => {
      const stopped = body.request("POST", "/call", { name: "social.waitForChat", args: { timeoutMs: 30_000 } });
      await running(body);
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal(runOf(await stopped).status, "stopped");
      assert.equal(runOf(await body.request("POST", "/call", { name: "social.waitForChat", args: { timeoutMs: 30_000 }, timeoutMs: 300 })).status, "timeout");
      assert.deepEqual(
        body.history().map((line) => [(line.call as { name: string }).name, line.status]),
        [
          ["social.waitForChat", "stopped"],
          ["social.waitForChat", "timeout"],
        ],
      );
    });
    // Both ended by the abort: neither is a failure of the routine.
    assert.equal(statsOf(body).actions.social?.waitForChat?.failed ?? 0, 0);
  });

  it("kills a built-in that blocks the host by the supervisor's deadline, answers with the restarted error, and serves the next call", { timeout: 30_000 }, async () => {
    await using({ stateFiles: { "routines/jam.ts": JAM } }, async (body) => {
      await body.ok("POST", "/bind", { kind: "action", name: "jam", routine: "jam" });
      assert.equal(runOf(await body.request("POST", "/call", { name: "jam" })).status, "ok");
      const started = Date.now();
      const since = body.events.since(0, 1000).next;
      const run = runOf(await body.request("POST", "/call", { name: "inventory.list", timeoutMs: 200 }));
      assert.ok(Date.now() - started < 200 + GRACE_MS + 500 + 4_000, `took ${Date.now() - started} ms`);
      assert.equal(run.error, restartedError(hungCause(GRACE_MS)));
      assert.equal(body.eventsOf("program_finished").filter((event) => event.data.status !== "ok").length, 1, "the supervisor ends the killed call once");
      await body.waitFor("connected", since);
      assert.equal(runOf(await body.request("POST", "/call", { name: "inventory.list" })).status, "ok", "the replacement host's player is not jammed");
      const lines = body.history().filter((line) => (line.call as { name: string }).name === "inventory.list");
      assert.equal(lines.length, 2);
      assert.equal(lines[0]!.status, run.status);
    });
  });
});

describe("the count of built-in calls in kit-stats.json", () => {
  const NESTED = 'import * as inventory from "minebot-sdk/routines/inventory";\nimport * as move from "minebot-sdk/routines/move";\nexport default async (ctx: never) => {\n  await move.stop(ctx);\n  return inventory.list(ctx);\n};\n';
  const IMPOSTOR = 'import { defineRoutine, z } from "minebot-sdk/routine";\nexport default defineRoutine({ name: "move.to", args: z.object({}) }, () => "impostor");\n';
  // Waits for its abort, then makes a call that fails: a failure after the abort is not the routine's.
  const AFTER_ABORT =
    'import * as inventory from "minebot-sdk/routines/inventory";\nexport default async (ctx: { signal: AbortSignal }) => {\n  await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));\n  await inventory.count(ctx as never, {} as never).catch(() => {});\n};\n';
  /** What a body of an earlier version wrote: built-in entries, and an entry of an agent kit. */
  const BASE = { actions: { move: { to: { ok: 3, failed: 1, lastError: "no path" } }, inventory: { list: { ok: 5, failed: 0 } }, counter: { later: { ok: 2, failed: 0 } } } };

  it("holds one count per call of an offered built-in: top level, nested in a built-in, nested in an agent routine, an earlier file's counts kept", { timeout: 60_000 }, async () => {
    let make: RunResult | undefined;
    const body = await using({ stateFiles: { "kit-stats.json": BASE, "routines/nested.ts": NESTED, "routines/impostor.ts": IMPOSTOR, "routines/afterabort.ts": AFTER_ABORT } }, async (body) => {
      for (const name of ["nested", "impostor", "afterabort"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
      // Top level, twice ok; one failing on its arguments.
      for (let i = 0; i < 2; i++) assert.equal(runOf(await body.request("POST", "/call", { name: "inventory.list" })).status, "ok");
      const invalid = runOf(await body.request("POST", "/call", { name: "inventory.count", args: {} }));
      assert.equal(invalid.status, "error");
      // Nested in a built-in: crafter.make counts the inventory first, then fails on the fake player.
      make = runOf(await body.request("POST", "/call", { name: "crafter.make", args: { item: "oak_planks" } }));
      assert.equal(make.status, "error");
      // Nested in an agent routine.
      assert.equal(runOf(await body.request("POST", "/call", { name: "nested" })).status, "ok");
      // An agent routine that names itself like a built-in is not one.
      assert.equal(runOf(await body.request("POST", "/call", { name: "impostor" })).result, "impostor");
      // A built-in call that fails after the run's abort.
      assert.equal(runOf(await body.request("POST", "/call", { name: "afterabort", timeoutMs: 300 })).status, "timeout");
      await sleep(200);
      assert.equal(runOf(await body.request("POST", "/call", { name: "move.stop" })).status, "ok");
      assert.match(make.error ?? "", /itemsByName/);
    });
    const { actions } = statsOf(body);
    // The earlier file's entries are all there; the ones calls did not touch are as they were.
    assert.deepEqual(actions.counter, BASE.actions.counter);
    assert.deepEqual(actions.move!.to, BASE.actions.move.to, "the impostor is not move.to");
    // inventory.list: 5 before, 2 top level, 1 nested in the agent routine.
    assert.deepEqual(actions.inventory!.list, { ok: 8, failed: 0 });
    assert.equal(actions.inventory!.count!.ok, 1, "the call crafter.make made");
    assert.equal(actions.inventory!.count!.failed, 1, "the call with invalid arguments, and not the one after the abort");
    assert.match(actions.inventory!.count!.lastError!, /^routine "inventory\.count" arguments: /);
    assert.deepEqual([actions.crafter!.make!.ok, actions.crafter!.make!.failed], [0, 1]);
    assert.ok(make?.error?.includes(actions.crafter!.make!.lastError!));
    assert.deepEqual(actions.move!.stop, { ok: 2, failed: 0 }, "once nested in the agent routine, once at top level");
    assert.deepEqual(Object.keys(actions).sort(), ["counter", "crafter", "inventory", "move"]);
  });

  it("holds the calls of several runs interleaved on a body with no earlier file: every count lands, from the one writer", async () => {
    const body = await using({}, async (body) => {
      assert.equal(runOf(await body.request("POST", "/call", { name: "inventory.list" })).status, "ok");
      assert.equal(runOf(await body.request("POST", "/call", { name: "move.stop" })).status, "ok");
      assert.equal(runOf(await body.request("POST", "/call", { name: "inventory.list" })).status, "ok");
    });
    assert.deepEqual(statsOf(body), { actions: { inventory: { list: { ok: 2, failed: 0 } }, move: { stop: { ok: 1, failed: 0 } } } });
  });

  it("writes the file when the host closes, also when nothing was counted", async () => {
    const body = await startFakeBody();
    const file = path.join(body.stateDir, "kit-stats.json");
    assert.equal(existsSync(file), false);
    await body.close();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { actions: {} });
  });

  it("keeps counting across a host restart, from what the file holds", { timeout: 30_000 }, async () => {
    const first = await startFakeBody();
    assert.equal(runOf(await first.request("POST", "/call", { name: "inventory.list" })).status, "ok");
    await first.close();
    const second = await startFakeBody({ stateDir: first.stateDir });
    assert.equal(runOf(await second.request("POST", "/call", { name: "inventory.list" })).status, "ok");
    await second.close();
    assert.deepEqual(statsOf(second).actions.inventory!.list, { ok: 2, failed: 0 });
  });

  it("shows the counts in the module listing and the search", async () => {
    await using({}, async (body) => {
      runOf(await body.request("POST", "/call", { name: "inventory.list" }));
      runOf(await body.request("POST", "/call", { name: "inventory.count", args: {} }));
      const { builtins } = (await body.ok("GET", "/builtins")) as { builtins: { name: string; stats: Record<string, unknown> }[] };
      assert.deepEqual(builtins.find((info) => info.name === "inventory")!.stats, { list: { ok: 1, failed: 0 }, count: { ok: 0, failed: 1, lastError: (builtins.find((info) => info.name === "inventory")!.stats.count as { lastError: string }).lastError } });
      const { hits } = (await body.ok("GET", "/builtins/search?q=inventory%20totals")) as { hits: { module: string; routine?: string; stats?: unknown }[] };
      assert.deepEqual(hits.find((hit) => hit.module === "inventory" && hit.routine === "list")!.stats, { ok: 1, failed: 0 });
    });
  });
});

describe("a body's offer reaches the library loader", () => {
  const PLACE = 'import * as place from "minebot-sdk/routines/place";\nexport default () => typeof place.place;\n';
  const INVENTORY = 'import * as inventory from "minebot-sdk/routines/inventory";\nexport default () => typeof inventory.list;\n';

  it("refuses a library routine that imports a module the body withholds, naming the specifier, and loads one that imports an offered module", async () => {
    await using({ init: { builtins: ["gatherer"] }, stateFiles: { "routines/useplace.ts": PLACE, "routines/useinventory.ts": INVENTORY } }, async (body) => {
      for (const name of ["useplace", "useinventory"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
      const refused = runOf(await body.request("POST", "/call", { name: "useplace" }));
      assert.equal(refused.status, "error");
      assert.match(refused.error ?? "", /"minebot-sdk\/routines\/place"/);
      assert.deepEqual(runOf(await body.request("POST", "/call", { name: "useinventory" })).result, "function");
    });
    // The same library on a body that offers everything loads both.
    await using({ stateFiles: { "routines/useplace.ts": PLACE } }, async (body) => {
      await body.ok("POST", "/bind", { kind: "action", name: "useplace", routine: "useplace" });
      assert.equal(runOf(await body.request("POST", "/call", { name: "useplace" })).result, "function");
    });
  });
});

describe("discovery evaluates no library module", () => {
  it("answers the listing, the reference, the search, the source, and a built-in call without loading a routine of the library", async () => {
    await using({}, async (body) => {
      const marker = path.join(body.stateDir, "evaluated");
      body.writeRoutines({ marked: `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nexport default () => "ran";\n` });
      await body.ok("POST", "/bind", { kind: "action", name: "marked", routine: "marked" });
      for (const url of ["/builtins", "/builtins/docs", "/builtins/docs?names=move,gatherer", "/builtins/search?q=walk", "/builtins/source?name=move", "/api", "/bindings", "/routines"]) await body.ok("GET", url);
      assert.equal(runOf(await body.request("POST", "/call", { name: "move.stop" })).status, "ok");
      assert.equal(existsSync(marker), false, "a discovery route or a built-in call evaluated the library");
      assert.equal(runOf(await body.request("POST", "/call", { name: "marked" })).result, "ran");
      assert.equal(existsSync(marker), true);
    });
  });
});

describe("what a withheld module is absent from", () => {
  const OFFERED = ["move", "sense", "dig", "inventory", "items", "gatherer"];

  it("is every discovery route, /call, and the program reference, for every withheld module", async () => {
    await using({ init: { builtins: ["gatherer"] } }, async (body) => {
      const listed = ((await body.ok("GET", "/builtins")) as { builtins: { name: string }[] }).builtins.map((info) => info.name);
      assert.deepEqual(listed, OFFERED);
      const { doc } = (await body.ok("GET", "/api")) as { doc: string };
      assert.match(doc, new RegExp(`^Built-in routines: ${OFFERED.join(", ")}\\.`, "m"));
      assert.deepEqual(((await body.ok("GET", "/features")) as { builtins: string[] }).builtins, OFFERED);
      const everything = (await body.ok("GET", "/builtins/docs")) as { docs: string };
      for (const module of BUILTIN_MODULES.filter((candidate) => !OFFERED.includes(candidate.name))) {
        const withheld = module.name;
        assert.doesNotMatch(everything.docs, new RegExp(`^## ${withheld}$`, "m"), withheld);
        assert.equal((await body.request("GET", `/builtins/docs?names=${withheld}`)).status, 400, withheld);
        assert.equal((await body.request("GET", `/builtins/source?name=${withheld}`)).status, 404, withheld);
        for (const routine of Object.keys(module.routines)) assert.equal((await body.request("POST", "/call", { name: `${withheld}.${routine}` })).status, 404, `${withheld}.${routine}`);
        const search = (await body.ok("GET", `/builtins/search?q=${withheld}%20${Object.keys(module.routines).join("%20")}&limit=20`)) as { hits: { module: string }[] };
        assert.ok(search.hits.every((hit) => OFFERED.includes(hit.module)), `${withheld}: ${JSON.stringify(search.hits)}`);
      }
    });
  });
});

describe("a built-in call through the whole path", () => {
  it("calls move.to, documents it, and leaves its count in kit-stats.json after close", { timeout: 60_000 }, async () => {
    const body = await using({ stateFiles: { "routines/arm.ts": ARM } }, async (body) => {
      await body.ok("POST", "/bind", { kind: "action", name: "arm", routine: "arm" });
      runOf(await body.request("POST", "/call", { name: "arm" }));
      const run = runOf(await body.request("POST", "/call", { name: "move.to", args: { position: [3, 64, 2], range: 2 } }));
      assert.deepEqual([run.status, run.result], ["ok", { x: 1, y: 64, z: 2 }]);
      const line = body.history().at(-1)!;
      assert.deepEqual([line.code, line.call, line.status], ["", { name: "move.to", args: { position: [3, 64, 2], range: 2 } }, "ok"]);
      const docs = ((await body.ok("GET", "/builtins/docs?names=move")) as { docs: string }).docs;
      assert.match(docs, /### move\.to\(ctx, \{ position, range\?, timeoutMs\? \}\)\n.*\n- position: /);
      assert.match(docs, /- range\?: number \(default 1\)/);
      assert.match(docs, /Returns: /);
    });
    assert.deepEqual(statsOf(body).actions.move, { to: { ok: 1, failed: 0 } });
  });
});
