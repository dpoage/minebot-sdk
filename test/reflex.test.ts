// Reflex bindings through the real bot host (real Connection, Body, world, routes, triggers, and
// bindings over a fake player, see fixtures/host/fake-body.ts) under the real supervisor: a reflex
// is a trigger whose body is a routine, so it fires, waits, preempts, times out, fails, and
// survives a host's death as a trigger does, and its routine is called with (ctx, { event }).
// The scheduler rules themselves are checked over both kinds in triggers.test.ts.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { hungCause, restartedError } from "../src/protocol/host.ts";
import type { BindingInfo, ReflexBindingInfo, RunResult } from "../src/protocol/index.ts";
import { FakeBody, GRACE_MS, removeScratch, startFakeBody, type FakeBodyOptions } from "./fixtures/host/fake-body.ts";

after(removeScratch);

// Routines are plain modules written straight into the library: nothing here saves or type-checks them (their parameters are left untyped).
const ECHO = "export default async (ctx, args) => {\n  ctx.notes.set('seen', JSON.stringify(args));\n  return args.event;\n};\n";
const SLEEPER = "export default async (ctx) => {\n  await ctx.sleep(30_000);\n};\n";
const THROWS = "export default (): never => {\n  throw new Error('boom');\n};\n";
const BLOCKER = "export default (): never => {\n  for (;;) {}\n};\n";
const PID = "export default () => process.pid;\n";
const SAY = "export default async (ctx, args) => {\n  ctx.bot.emit('chat', args.from, args.message);\n};\n";
const SEEN = "export default (ctx) => ctx.notes.get('seen');\n";

const chat = (from: string, message: string): string => `bot.emit('chat', ${JSON.stringify(from)}, ${JSON.stringify(message)});`;

/** A routine that makes the body hear a chat message, then runs `rest`. */
const saysThen = (from: string, message: string, rest: string): string =>
  `export default async (ctx) => {\n  ctx.bot.emit('chat', ${JSON.stringify(from)}, ${JSON.stringify(message)});\n${rest}\n};\n`;

async function bodyWith(routines: Record<string, string>, options: FakeBodyOptions = {}): Promise<FakeBody> {
  const body = await startFakeBody(options);
  body.writeRoutines({ ...routines, say: SAY, seen: SEEN });
  for (const name of ["say", "seen"]) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
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

const reflexes = async (body: FakeBody): Promise<ReflexBindingInfo[]> =>
  ((await body.ok("GET", "/bindings")) as { bindings: BindingInfo[] }).bindings.filter((binding): binding is ReflexBindingInfo => binding.kind === "reflex");
const reflexOf = async (body: FakeBody, name: string): Promise<ReflexBindingInfo> => (await reflexes(body)).find((reflex) => reflex.name === name)!;

/** Makes the body hear a chat message through a call of the action `say`. */
const say = async (body: FakeBody, from: string, message: string): Promise<RunResult> => runOf(await body.request("POST", "/call", { name: "say", args: { from, message } }));

/** Resolves once `count` firings have ended. */
async function finished(body: FakeBody, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.eventsOf("trigger_finished").length < count && Date.now() < deadline) await sleep(20);
  assert.ok(body.eventsOf("trigger_finished").length >= count, `${body.eventsOf("trigger_finished").length} of ${count} firings ended`);
}

/** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
async function running(body: FakeBody): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
  assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
  await sleep(150);
}

describe("a reflex's firing", () => {
  it("calls the routine with (ctx, { event }), and records trigger_fired, trigger_finished, and one history line for the binding and one for the firing", async () => {
    const body = await bodyWith({ echo: ECHO });
    await using(body, async () => {
      const bound = (await body.ok("POST", "/bind", { kind: "reflex", name: "greet", routine: "echo", on: ["chat"], when: "event.data.from === 'alice'", cooldownMs: 0 })) as { binding: ReflexBindingInfo; replaced: boolean };
      assert.equal(bound.replaced, false);
      const { updated, ...fields } = bound.binding;
      assert.equal(typeof updated, "string");
      assert.deepEqual(fields, { kind: "reflex", name: "greet", routine: "echo", on: ["chat"], when: "event.data.from === 'alice'", cooldownMs: 0, timeoutMs: 30_000, enabled: true, preempt: false, priority: 0, fired: 0, failures: 0 });

      // The registration is a history line of its own: `when` is its code, and it names the routine.
      const [registered] = body.history();
      assert.deepEqual([registered!.code, registered!.trigger, registered!.routine, registered!.on, registered!.status], ["event.data.from === 'alice'", "greet", "echo", ["chat"], "registered"]);
      await body.ok("POST", "/bind", { kind: "reflex", name: "plain", routine: "echo", on: ["never"] });
      assert.equal(body.history()[1]!.code, "", "a reflex without `when` registers no code");

      await say(body, "bob", "hello");
      await say(body, "alice", "hello");
      await finished(body, 1);
      await sleep(100);
      assert.equal(body.eventsOf("trigger_finished").length, 1, "only the matching event fired it");

      const chats = body.eventsOf("chat");
      const heard = chats.find((event) => event.data.from === "alice")!;
      const [fired] = body.eventsOf("trigger_fired");
      assert.deepEqual(fired!.data, { name: "greet", event: { seq: heard.seq, type: "chat" } });
      const [done] = body.eventsOf("trigger_finished");
      assert.deepEqual([done!.data.name, done!.data.status], ["greet", "ok"]);
      // The routine saw the BodyEvent itself, in the args object.
      const note = runOf(await body.request("POST", "/run", { code: "return notes.get('seen')" })).result as string;
      assert.deepEqual(JSON.parse(note), { event: { seq: heard.seq, type: "chat", time: heard.time, data: { from: "alice", message: "hello" } } });

      // The firing is a history line of its own: no code, the trigger, the routine, and the event.
      const firing = body.history().find((line) => line.status === "ok" && line.trigger === "greet")!;
      assert.deepEqual([firing.code, firing.routine, firing.event], ["", "echo", { seq: heard.seq, type: "chat" }]);
      assert.equal("call" in firing, false);
      // A firing ends in trigger_finished, not program_finished: only the two /run programs did.
      assert.equal(body.eventsOf("program_finished").length, 3);

      const after = await reflexOf(body, "greet");
      assert.deepEqual([after.fired, after.lastStatus, after.failures], [1, "ok", 0]);
    });
  });

  for (const kind of ["code trigger", "reflex"] as const) {
    it(`filters chat by sender and pattern, by a \`when\` over the event, and by cooldown: a ${kind}`, async () => {
      const body = await bodyWith({ echo: ECHO });
      await using(body, async () => {
        const fields = { on: ["chat"], from: "Ana", match: "^come", when: "event.data.message.length < 12", cooldownMs: 60_000 };
        if (kind === "reflex") await body.ok("POST", "/bind", { kind: "reflex", name: "react", routine: "echo", ...fields });
        else await body.ok("POST", "/triggers", { name: "react", run: "return 1", ...fields });
        await say(body, "ben", "come here");
        await say(body, "ana", "go away");
        await say(body, "ana", "come here please now");
        await say(body, "ana", "come now");
        await finished(body, 1);
        await say(body, "ana", "come back");
        await sleep(300);
        // Exactly the one event that passes every filter fired it, and the cooldown kept the next out.
        const wanted = body.eventsOf("chat").find((event) => event.data.message === "come now")!;
        assert.deepEqual(body.eventsOf("trigger_fired").map((event) => event.data.event), [{ seq: wanted.seq, type: "chat" }]);
        assert.equal(body.eventsOf("trigger_finished").length, 1);
      });
    });
  }

  it("is ended by its own timeoutMs as a trigger's program is", async () => {
    const body = await bodyWith({ sleeper: SLEEPER });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "slow", routine: "sleeper", on: ["chat"], timeoutMs: 300, cooldownMs: 0 });
      const started = Date.now();
      await say(body, "ana", "go");
      await finished(body, 1);
      assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
      const [done] = body.eventsOf("trigger_finished");
      assert.deepEqual([done!.data.name, done!.data.status], ["slow", "timeout"]);
      // The reflex's own timeout ended it: without one, the supervisor's deadline (the timeout plus the grace) kills the host and answers for it.
      assert.notEqual(done!.data.error, restartedError(hungCause(GRACE_MS)));
      assert.ok(Number(done!.data.durationMs) < GRACE_MS + 300, `ended after ${done!.data.durationMs} ms`);
      const slow = await reflexOf(body, "slow");
      assert.deepEqual([slow.lastStatus, slow.failures], ["timeout", 1]);
      assert.equal(body.history().find((line) => line.trigger === "slow" && line.status !== "registered")!.status, "timeout");
    });
  });

  it("disables itself after 3 failures in a row with a trigger_disabled, and binding it again enables it with its numbers reset", async () => {
    const body = await bodyWith({ throws: THROWS, echo: ECHO });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "flaky", routine: "throws", on: ["chat"], cooldownMs: 0 });
      for (let i = 1; i <= 4; i++) {
        await say(body, "ana", `go ${i}`);
        await sleep(200);
      }
      await finished(body, 3);
      await sleep(300);
      assert.equal(body.eventsOf("trigger_fired").length, 3, "the fourth event did not fire it");
      const disabled = body.eventsOf("trigger_disabled");
      assert.deepEqual(disabled.map((event) => [event.data.name, event.data.failures]), [["flaky", 3]]);
      const flaky = await reflexOf(body, "flaky");
      assert.deepEqual([flaky.enabled, flaky.failures, flaky.lastStatus], [false, 3, "error"]);
      assert.match(flaky.disabledReason!, /^failed 3 times in a row; last: Error: boom/);
      assert.match(flaky.lastError!, /^Error: boom\n/);

      const again = (await body.ok("POST", "/bind", { kind: "reflex", name: "flaky", routine: "echo", on: ["chat"], cooldownMs: 0 })) as { binding: ReflexBindingInfo; replaced: boolean };
      assert.equal(again.replaced, true);
      assert.deepEqual([again.binding.enabled, again.binding.failures, again.binding.fired, again.binding.disabledReason], [true, 0, 0, undefined]);
    });
  });
});

describe("a reflex that preempts", () => {
  it("stops a program of the agent and runs next, with trigger_fired preempted", { timeout: 30_000 }, async () => {
    const body = await bodyWith({ echo: ECHO });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "urgent", routine: "echo", on: ["chat"], preempt: true, cooldownMs: 0 });
      const program = runOf(await body.request("POST", "/run", { code: `${chat("ana", "now")} await sleep(30000);` }));
      assert.equal(program.status, "stopped");
      await finished(body, 1);
      assert.equal(body.eventsOf("trigger_fired")[0]!.data.preempted, true);
      assert.equal(body.eventsOf("trigger_finished")[0]!.data.status, "ok");
    });
  });

  it("stops a call of an action, and the call answers stopped", { timeout: 30_000 }, async () => {
    const body = await bodyWith({ echo: ECHO, chatty: saysThen("ana", "now", "  await ctx.sleep(30_000);") });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "action", name: "chatty", routine: "chatty" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "urgent", routine: "echo", on: ["chat"], preempt: true, cooldownMs: 0 });
      assert.equal(runOf(await body.request("POST", "/call", { name: "chatty" })).status, "stopped");
      await finished(body, 1);
      assert.equal(body.eventsOf("trigger_fired")[0]!.data.preempted, true);
    });
  });

  it("is ended with its host by the supervisor's deadline when the call it preempted blocks after the abort", { timeout: 30_000 }, async () => {
    const stubborn = saysThen("ana", "now", "  try {\n    await ctx.sleep(60_000);\n  } catch {\n    for (;;) {}\n  }");
    const body = await bodyWith({ echo: ECHO, stubborn, pid: PID });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "action", name: "stubborn", routine: "stubborn" });
      await body.ok("POST", "/bind", { kind: "action", name: "pidr", routine: "pid" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "urgent", routine: "echo", on: ["chat"], preempt: true, cooldownMs: 0 });
      const before = runOf(await body.request("POST", "/call", { name: "pidr" })).result;
      const started = Date.now();
      const since = body.events.since(0, 1000).next;
      const call = runOf(await body.request("POST", "/call", { name: "stubborn" }));
      assert.ok(Date.now() - started < GRACE_MS + 500 + 4_000, `took ${Date.now() - started} ms`);
      assert.equal(call.error, restartedError(hungCause(GRACE_MS)));
      await body.waitFor("connected", since);
      assert.notEqual(runOf(await body.request("POST", "/call", { name: "pidr" })).result, before, "the host was replaced");
      assert.equal((await reflexOf(body, "urgent")).routine, "echo", "the reflex survived the kill");
    });
  });

  it("preempts a running reflex of lower priority, never one of equal priority", { timeout: 30_000 }, async () => {
    const slowFast = saysThen("ana", "fast", "  await ctx.sleep(30_000);");
    const slowSame = saysThen("ana", "same", "  await ctx.sleep(30_000);");
    const body = await bodyWith({ echo: ECHO, "slow-fast": slowFast, "slow-same": slowSame });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "starter", routine: "slow-fast", on: ["chat"], match: "^go", cooldownMs: 0, timeoutMs: 20_000 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "fast", routine: "echo", on: ["chat"], match: "^fast", cooldownMs: 0, preempt: true, priority: 5 });
      await say(body, "ana", "go");
      await finished(body, 2);
      assert.deepEqual(
        body.eventsOf("trigger_finished").map((event) => [event.data.name, event.data.status]),
        [
          ["starter", "stopped"],
          ["fast", "ok"],
        ],
      );
      assert.equal(body.eventsOf("trigger_fired")[1]!.data.preempted, true);

      await body.ok("POST", "/bind", { kind: "reflex", name: "starter2", routine: "slow-same", on: ["chat"], match: "^again", cooldownMs: 0, timeoutMs: 20_000 });
      await body.ok("POST", "/bind", { kind: "reflex", name: "same", routine: "echo", on: ["chat"], match: "^same", cooldownMs: 0, preempt: true });
      await say(body, "ana", "again");
      await sleep(800);
      assert.equal(body.eventsOf("trigger_finished").length, 2, "an equal priority did not preempt the running reflex");
      assert.deepEqual(await body.host.stop(), { stopped: true });
      await finished(body, 4);
      assert.deepEqual(
        body.eventsOf("trigger_finished").slice(2).map((event) => [event.data.name, event.data.status]),
        [
          ["starter2", "stopped"],
          ["same", "ok"],
        ],
      );
    });
  });
});

describe("a reflex and a host's death", () => {
  it("keeps its failure streak across a host SIGKILL, and disables on the firing that completes the streak", { timeout: 40_000 }, async () => {
    const body = await bodyWith({ throws: THROWS, pid: PID });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "action", name: "pidr", routine: "pid" });
      await body.ok("POST", "/bind", { kind: "reflex", name: "flaky", routine: "throws", on: ["chat"], cooldownMs: 0 });
      await say(body, "ana", "one");
      await finished(body, 1);
      await say(body, "ana", "two");
      await finished(body, 2);
      const pid = runOf(await body.request("POST", "/call", { name: "pidr" })).result as number;
      const since = body.events.since(0, 1000).next;
      process.kill(pid, "SIGKILL");
      await body.waitFor("connected", since);
      const flaky = await reflexOf(body, "flaky");
      assert.deepEqual([flaky.failures, flaky.enabled], [2, true], "the replacement host did not carry the streak");
      await say(body, "ana", "three");
      await finished(body, 3);
      await sleep(200);
      assert.deepEqual(body.eventsOf("trigger_disabled").map((event) => [event.data.name, event.data.failures]), [["flaky", 3]]);
      assert.equal((await reflexOf(body, "flaky")).enabled, false);
    });
  });

  it("counts the firing a host's death ended: a routine that blocks the host is killed, and the replacement has the failure", { timeout: 40_000 }, async () => {
    const body = await bodyWith({ blocker: BLOCKER });
    await using(body, async () => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "hang", routine: "blocker", on: ["chat"], cooldownMs: 0, timeoutMs: 200 });
      const since = body.events.since(0, 1000).next;
      await say(body, "ana", "go");
      await finished(body, 1);
      const [done] = body.eventsOf("trigger_finished");
      assert.deepEqual([done!.data.name, done!.data.status, done!.data.error], ["hang", "timeout", restartedError(hungCause(GRACE_MS))]);
      await body.waitFor("connected", since);
      const hang = await reflexOf(body, "hang");
      assert.deepEqual([hang.failures, hang.enabled], [1, true]);
      assert.equal(body.eventsOf("trigger_finished").length, 1, "the death's firing was reported once");
    });
  });
});
