// The refusal of a run that arrives while the run slot is taken (mb-znn.7): it names the holder (a module run, a call, or a
// reflex), how long it has held the slot, and the next step, in one line. The reporter's own refusals are checked over a fake
// supervisor with a clock the test sets; the same text is checked on the shipped surface, POST /run and POST /call on a body.
import assert from "node:assert/strict";
import { afterEach, after, describe, it, mock } from "node:test";
import { setImmediate, setTimeout as sleep } from "node:timers/promises";
import type { FromHost } from "../src/protocol/host.ts";
import { BusyError } from "../src/program/runner.ts";
import { RunReporter } from "../src/host/channel.ts";
import { removeScratch, startFakeBody, type FakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const OUTCOME = { status: "ok" as const, result: 1, logs: "", durationMs: 0 };

/** A reporter whose supervisor acks everything at once; `hold` is a run held in its code until `finish`. */
function reporterWithHolder(run: Parameters<RunReporter["record"]>[0]) {
  const reporter: RunReporter = new RunReporter({
    send: (message: FromHost) => {
      if ("runId" in message && (message.kind === "run_started" || message.kind === "run_finished")) queueMicrotask(() => reporter.acknowledge(message.runId));
    },
    stop: () => true,
    running: () => true,
  });
  const gate = Promise.withResolvers<void>();
  const held = reporter.record(run, async () => {
    await gate.promise;
    return OUTCOME;
  });
  return { reporter, finish: async () => (gate.resolve(), held) };
}

/** The message of the refusal of a run that arrives now. */
async function refusal(reporter: RunReporter): Promise<string> {
  const err = await reporter.record({ code: "second" }, async () => OUTCOME).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof BusyError, "the refusal is not a BusyError: the reflex scheduler requeues on that class");
  return err.message;
}

describe("the refusal names who holds the slot and for how long", () => {
  afterEach(() => mock.timers.reset());

  it("a module run: run_program, the seconds held, and wait_for program_finished or stop_program", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const { reporter, finish } = reporterWithHolder({ code: "export default 1" });
    await setImmediate();
    mock.timers.tick(42_000);
    assert.equal(await refusal(reporter), 'busy: run_program has held the run slot for 42 s; wait_for ["program_finished"] or stop_program, then retry');
    await finish();
  });

  it("a call: call_routine and its name", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const { reporter, finish } = reporterWithHolder({ code: "", extra: { call: { name: "move.to", args: {} } } });
    await setImmediate();
    mock.timers.tick(42_000);
    assert.equal(await refusal(reporter), 'busy: call_routine "move.to" has held the run slot for 42 s; wait_for ["program_finished"] or stop_program, then retry');
    await finish();
  });

  it("a reflex: reflex and its name, and wait_for reflex_finished", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const { reporter, finish } = reporterWithHolder({ code: "", extra: { trigger: "collect-loot" }, trigger: { name: "collect-loot", updated: "2026-10-27" } });
    await setImmediate();
    mock.timers.tick(42_000);
    assert.equal(await refusal(reporter), 'busy: reflex "collect-loot" has held the run slot for 42 s; wait_for ["reflex_finished"] or stop_program, then retry');
    await finish();
  });

  it("counts the seconds from the run's arrival, also while its start is not acked yet", async () => {
    mock.timers.enable({ apis: ["Date"], now: 5_000 });
    const reporter = new RunReporter({ send: () => {}, stop: () => true, running: () => true });
    const held = reporter.record({ code: "x" }, async () => OUTCOME);
    mock.timers.tick(7_000);
    assert.equal(await refusal(reporter), 'busy: run_program has held the run slot for 7 s; wait_for ["program_finished"] or stop_program, then retry');
    reporter.acknowledge(0);
    await setImmediate();
    reporter.acknowledge(0);
    await held;
  });

  it("names the run that holds the slot now, not the one that held it before", async () => {
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const first = reporterWithHolder({ code: "", extra: { call: { name: "a", args: {} } } });
    await setImmediate();
    mock.timers.tick(3_000);
    await first.finish();
    const reporter = first.reporter;
    const gate = Promise.withResolvers<void>();
    const second = reporter.record({ code: "export default 2" }, async () => (await gate.promise, OUTCOME));
    await setImmediate();
    mock.timers.tick(5_000);
    assert.equal(await refusal(reporter), 'busy: run_program has held the run slot for 5 s; wait_for ["program_finished"] or stop_program, then retry');
    gate.resolve();
    await second;
  });
});

describe("on the shipped surface, a body that is busy answers 409 with that text", { timeout: 60_000 }, () => {
  const BUSY = /^busy: (.+) has held the run slot for \d+ s; wait_for \["(\w+)"\] or stop_program, then retry$/;

  async function withBody(test: (body: FakeBody) => Promise<void>): Promise<void> {
    const body = await startFakeBody();
    try {
      await test(body);
    } finally {
      await body.close();
    }
  }

  /** The error text of a refused request. */
  function refused(answer: { status: number; body: unknown }): string {
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.ok(typeof answer.body === "object" && answer.body !== null && "error" in answer.body);
    return String(answer.body.error);
  }

  /** The result of a run that answered 200. */
  function resultOf(answer: { status: number; body: unknown }): unknown {
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.ok(typeof answer.body === "object" && answer.body !== null && "result" in answer.body);
    return answer.body.result;
  }

  async function holding(body: FakeBody): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
    assert.ok(body.host.openRuns > 0, "the first run did not start");
  }

  it("POST /run while a module run holds the slot", async () => {
    await withBody(async (body) => {
      const first = body.request("POST", "/run", { code: "export default async (ctx) => { await ctx.sleep(1500); return 'first'; };" });
      await holding(body);
      const text = refused(await body.request("POST", "/run", { code: "export default 2;" }));
      assert.match(text, BUSY);
      assert.deepEqual(BUSY.exec(text)?.slice(1), ["run_program", "program_finished"]);
      assert.equal(resultOf(await first), "first");
    });
  });

  it("POST /call while a call holds the slot names the routine", async () => {
    await withBody(async (body) => {
      body.writeRoutines({ slow: "export default async (ctx) => { await ctx.sleep(1500); return 1; };\n", quick: "export default () => 2;\n" });
      for (const name of ["slow", "quick"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
      const first = body.request("POST", "/call", { name: "slow" });
      await holding(body);
      const text = refused(await body.request("POST", "/call", { name: "quick" }));
      assert.deepEqual(BUSY.exec(text)?.slice(1), ['call_routine "slow"', "program_finished"]);
      await first;
    });
  });

  it("POST /run while a reflex's firing holds the slot names the reflex, and the reflex is not harmed by the refusal", async () => {
    await withBody(async (body) => {
      body.writeRoutines({ loot: "export default async (ctx) => { await ctx.sleep(1200); return 'looted'; };\n" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "collect-loot", routine: "loot", on: ["chat"], cooldownMs: 0 });
      body.events.push("chat", { from: "ana", message: "go" });
      await body.waitFor("reflex_fired");
      const text = refused(await body.request("POST", "/run", { code: "export default 2;" }));
      assert.deepEqual(BUSY.exec(text)?.slice(1), ['reflex "collect-loot"', "reflex_finished"]);
      const finished = await body.waitFor("reflex_finished");
      assert.deepEqual([finished.data.name, finished.data.status], ["collect-loot", "ok"]);
    });
  });
});
