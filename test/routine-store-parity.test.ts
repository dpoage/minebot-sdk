// `ctx.store(namespace)`: a value set in one call is read in the next, by the body (through the bot host, over the state
// directory) and by the harness (h.run twice on one harness), with the same get/set/delete/keys answers. And a routine run under
// the harness that calls a built-in routine by plain import has that call recorded in `h.calls`.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as inventory from "minebot-sdk/routines/inventory";
import { createHarness } from "minebot-sdk/testing";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

interface Store {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  keys(): string[];
}

/** One call of the probe: the step says what it does to the namespace's store, and it answers what it saw. Written once and used as the body's module and as the harness's routine. */
const probe = (ctx: { store(namespace: string): Store }, args: { ns: string; step: number }): unknown => {
  const store = ctx.store(args.ns);
  switch (args.step) {
    case 1:
      store.set("a", 1);
      store.set("b", { x: [1, 2] });
      return { keys: store.keys(), a: store.get("a") };
    case 2:
      return { a: store.get("a"), b: store.get("b"), keys: store.keys(), deleted: store.delete("a"), deletedAgain: store.delete("a"), after: store.keys() };
    case 3:
      store.set("b", undefined);
      store.set("n", null);
      store.set("zero", 0);
      store.set("empty", "");
      return { keys: store.keys(), b: store.get("b"), n: store.get("n"), zero: store.get("zero"), empty: store.get("empty"), missing: store.get("zzz") };
    default:
      return { keys: store.keys() };
  }
};

const STEPS = [1, 2, 3, 4];
const NAMESPACES = ["scratch", "a-b_c", "explorer", "x"];

/** What the four steps answer, in this order, in any namespace nothing else wrote to. */
const EXPECTED = [
  { keys: ["a", "b"], a: 1 },
  { a: 1, b: { x: [1, 2] }, keys: ["a", "b"], deleted: true, deletedAgain: false, after: ["b"] },
  { keys: ["n", "zero", "empty"], b: undefined, n: null, zero: 0, empty: "", missing: undefined },
  { keys: ["n", "zero", "empty"] },
];

/** As a client of the body sees them: JSON, which drops `undefined` members. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("ctx.store across calls", () => {
  let body: FakeBody;
  const bodyResults = new Map<string, unknown[]>();

  it("answers in the next call what the last one stored, in the body", async () => {
    body = await startFakeBody();
    try {
      body.writeRoutines({ probe: `export default ${probe.toString()};\n` });
      await body.ok("POST", "/bind", { kind: "action", name: "probe", routine: "probe" });
      for (const ns of NAMESPACES) {
        const results: unknown[] = [];
        for (const step of STEPS) {
          const answer = await body.request("POST", "/call", { name: "probe", args: { ns, step } });
          assert.equal(answer.status, 200, JSON.stringify(answer.body));
          const run = answer.body as RunResult;
          assert.equal(run.status, "ok", `${ns} step ${step}: ${run.error}`);
          results.push(run.result);
        }
        bodyResults.set(ns, results);
        assert.deepEqual(results, wire(EXPECTED), ns);
      }
    } finally {
      await body.close();
    }
  });

  it("answers in the next run what the last one stored, in the harness, with the same answers as the body", async () => {
    const h = createHarness();
    for (const ns of NAMESPACES) {
      const results: unknown[] = [];
      for (const step of STEPS) results.push(await h.run(probe, { ns, step }));
      assert.deepEqual(results, EXPECTED, ns);
      assert.deepEqual(wire(results), bodyResults.get(ns), `${ns}: the harness and the body answer alike`);
    }
    // A harness of its own starts empty: the store belongs to the harness, not to the module.
    assert.deepEqual(await createHarness().run(probe, { ns: "scratch", step: 4 }), { keys: [] });
  });

  it("refuses the same namespaces in the body and in the harness: another routine's, the body's own, and a name that is not one", async () => {
    const rules = [/ctx\.store namespace "notes" is reserved/, /ctx\.store namespace "body" is reserved/, /ctx\.store namespace "Bad Name" is not allowed/, /ctx\.store namespace "" is not allowed/];
    const h = createHarness();
    const bodyOfRefusals = await startFakeBody();
    try {
      bodyOfRefusals.writeRoutines({ probe: `export default ${probe.toString()};\n` });
      await bodyOfRefusals.ok("POST", "/bind", { kind: "action", name: "probe", routine: "probe" });
      for (const [i, ns] of ["notes", "body", "Bad Name", ""].entries()) {
        await assert.rejects(h.run(probe, { ns, step: 4 }), rules[i]!, ns);
        const answer = await bodyOfRefusals.request("POST", "/call", { name: "probe", args: { ns, step: 4 } });
        assert.match((answer.body as RunResult).error ?? "", rules[i]!, ns);
      }
    } finally {
      await bodyOfRefusals.close();
    }
  });
});

describe("a routine under h.run that calls a built-in", () => {
  it("has the call recorded in h.calls, with the arguments as the routine passed them", async () => {
    const h = createHarness({ inventory: { stick: 3 } });
    const counted = await h.run(async (ctx) => inventory.count(ctx, { items: "stick" }));
    assert.equal(counted, 3);
    assert.deepEqual(h.calls, [{ kit: "inventory", action: "count", args: { items: "stick" } }]);
    // The next run adds to the harness's record; a failed call is recorded too.
    await assert.rejects(h.run(async (ctx) => inventory.equip(ctx, { item: "diamond" })), /no diamond in inventory/);
    assert.deepEqual(h.calls.map((call) => `${call.kit}.${call.action}`), ["inventory.count", "inventory.equip"]);
  });
});
