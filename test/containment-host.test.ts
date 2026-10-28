// A run's code that throws where nothing catches it (a timer, a physics-tick listener) or leaves a
// promise nobody awaits does not restart the bot host: the run ends with status error and the
// body goes on, over the real supervisor and the real host over a fake player (fixtures/host/fake-body.ts).
// The fake player's pathfinder, controls and tick are a model of mineflayer-pathfinder's, installed by the
// `arm` routine: goto/setGoal keep the goal, a pending goto rejects when the goal changes, and every tick
// calls `goal.isValid()` as the plugin does (a goal that is not a goal throws "isValid is not a function").
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { NOT_AWAITED } from "../src/program/runner.ts";
import { restartedError } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { type FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const ARM = `export default (ctx) => {
  const bot = ctx.bot;
  const pf = bot.pathfinder;
  if (pf.armed) return "armed";
  pf.armed = true;
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  bot.controlState = controls;
  bot.setControlState = (name, value) => {
    controls[name] = value;
  };
  bot.clearControlStates = () => {
    for (const name of Object.keys(controls)) controls[name] = false;
  };
  let waiting;
  pf.goal = null;
  pf.throws = 0;
  pf.setGoal = (goal) => {
    pf.goal = goal;
    const pending = waiting;
    waiting = undefined;
    pending?.reject(Object.assign(new Error("The goal was changed before it could be completed!"), { name: "GoalChanged" }));
  };
  pf.goto = (goal) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    pf.setGoal(goal);
    waiting = { resolve, reject };
    return promise;
  };
  bot.on("physicsTick", () => {
    if (!pf.goal) return;
    try {
      pf.goal.isValid();
    } catch (err) {
      pf.throws++;
      throw err;
    }
  });
  setInterval(() => bot.emit("physicsTick"), 20).unref();
  return "armed";
};
`;

const GOAL = "{ isValid: () => true, hasChanged: () => false, isEnd: () => false }";

const ROUTINES: Record<string, string> = {
  arm: ARM,
  pid: "export default () => process.pid;\n",
  // What the next run sees of the body.
  state: "export default (ctx) => ({ goal: ctx.bot.pathfinder.goal ?? null, controls: { ...ctx.bot.controlState }, throws: ctx.bot.pathfinder.throws });\n",
  // The agent's `goto({ goal })` mistake: the goal is wrapped in an object, and the plugin throws on every tick.
  "goto-bad": "export default async (ctx) => {\n  await ctx.bot.pathfinder.goto({ goal: { x: 1, y: 64, z: 2 } });\n  return 'arrived';\n};\n",
  "timer-throw": "export default async (ctx) => {\n  setTimeout(() => {\n    throw new Error('thrown by a timer');\n  }, 30);\n  await ctx.sleep(20_000);\n};\n",
  // A goal set and controls held, then the run returns.
  leave: `export default (ctx) => {\n  ctx.bot.pathfinder.setGoal(${GOAL});\n  ctx.bot.setControlState('sneak', true);\n  ctx.bot.setControlState('jump', true);\n  return 'left';\n};\n`,
  "leave-throw": `export default (ctx) => {\n  ctx.bot.pathfinder.setGoal(${GOAL});\n  ctx.bot.setControlState('sneak', true);\n  throw new Error('own error');\n};\n`,
  "leave-timeout": `export default async (ctx) => {\n  ctx.bot.pathfinder.setGoal(${GOAL});\n  ctx.bot.setControlState('sneak', true);\n  await ctx.sleep(20_000);\n};\n`,
  // A goto nobody awaits: the halt at the end of the run cancels it.
  "goto-unawaited": `export default (ctx) => {\n  ctx.bot.pathfinder.goto(${GOAL});\n  return 'returned';\n};\n`,
  // The four shapes of an unawaited built-in routine with bad arguments (the box has no \`to\` and no \`wall\`).
  "box-awaited-inside": `import * as builder from "minebot-sdk/routines/builder";\nexport default async (ctx) => {\n  await builder.build(ctx, builder.box(ctx, { from: [0, 64, 0] }));\n};\n`,
  "box-then-return": `import * as builder from "minebot-sdk/routines/builder";\nexport default async (ctx) => {\n  builder.box(ctx, { from: [0, 64, 0] });\n  return 'returned';\n};\n`,
  "box-then-throw": `import * as builder from "minebot-sdk/routines/builder";\nexport default async (ctx) => {\n  builder.box(ctx, { from: [0, 64, 0] });\n  throw new Error('own error after the box');\n};\n`,
  "box-then-sleep": `import * as builder from "minebot-sdk/routines/builder";\nexport default async (ctx) => {\n  builder.box(ctx, { from: [0, 64, 0] });\n  await ctx.sleep(300);\n  return 'slept';\n};\n`,
  // Makes the second run_ack the host hears from now throw inside the host's own message handling, before that run's code can start.
  "arm-ack": `let acks = 2;\nprocess.on("message", (message) => {\n  if (message?.kind === "run_ack" && acks > 0 && --acks === 0) throw new Error("host code failed before a run's code started");\n});\nexport default () => 'armed';\n`,
};

async function using(test: (body: FakeBody, call: (name: string, args?: unknown, timeoutMs?: number) => Promise<RunResult>) => Promise<void>): Promise<void> {
  const body = await startFakeBody({ stateFiles: Object.fromEntries(Object.entries(ROUTINES).map(([name, source]) => [`routines/${name}.ts`, source])) });
  try {
    for (const name of Object.keys(ROUTINES)) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
    const call = async (name: string, args?: unknown, timeoutMs?: number): Promise<RunResult> => {
      const answer = await body.request("POST", "/call", { name, args, timeoutMs });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as RunResult;
    };
    assert.equal((await call("arm")).status, "ok");
    await test(body, call);
  } finally {
    await body.close();
  }
}

/** That the body never lost its player: no `disconnected`, and the host that answers is the one that did. */
async function stayedUp(body: FakeBody, call: (name: string) => Promise<RunResult>, pid: unknown): Promise<void> {
  assert.deepEqual(body.eventsOf("disconnected"), []);
  assert.equal((await call("pid")).result, pid, "another host answered");
}

describe("(P1.1) an error that reaches the process while a run's code is active ends that run, not the host", () => {
  it("a throw in a timer: the run ends with status error, its message and its frame; the same host answers the next run", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const pid = (await call("pid")).result;
      const run = await call("timer-throw");
      assert.equal(run.status, "error");
      const [first, second] = (run.error ?? "").split("\n");
      assert.equal(first, "Error: thrown by a timer");
      assert.match(second!, /timer-throw\.ts:\d+:\d+/, "the routine's frame");
      await stayedUp(body, call, pid);
      assert.equal((await call("pid")).status, "ok", "the next run is accepted");
    });
  });

  it("goto({ goal }) throws on every physics tick: the first ends the run, and the halt clears the goal before the second", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const pid = (await call("pid")).result;
      const run = await call("goto-bad");
      assert.equal(run.status, "error");
      assert.match(run.error ?? "", /^TypeError: .*isValid is not a function/);
      assert.match(run.error ?? "", /arm\.ts:\d+:\d+/, "the frame the throw came from");
      await sleep(300);
      const after = (await call("state")).result as { goal: unknown; throws: number };
      assert.equal(after.throws, 1, "the goal was cleared before the next tick");
      assert.equal(after.goal, null);
      await stayedUp(body, call, pid);
    });
  });

  it("the host does answer runs after a contained error, and its events say the run's own: program_finished with status error, no host restart", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      await call("goto-bad");
      const [finished] = body.eventsOf("program_finished").filter((event) => event.data.status === "error");
      assert.ok(finished, "the run's end was recorded as an error");
      assert.equal(body.eventsOf("connected").length, 1);
    });
  });
});

describe("(P1.2, mb-95b) a promise a run does not await that rejects", () => {
  const SHAPES = [
    ["(i) box() inside build()'s arguments, awaited", "box-awaited-inside"],
    ["(ii) box() not awaited, then the run returns", "box-then-return"],
    ["(iii) box() not awaited, then the run throws", "box-then-throw"],
    ["(iv) box() not awaited, then the run sleeps", "box-then-sleep"],
  ] as const;
  for (const [what, name] of SHAPES) {
    it(`${what}: the run ends with status error naming the routine and the missing await; the host is not restarted`, { timeout: 60_000 }, async () => {
      await using(async (body, call) => {
        const pid = (await call("pid")).result;
        const run = await call(name);
        assert.equal(run.status, "error", String(run.error));
        assert.match(run.error ?? "", /routine "builder\.box" arguments: /);
        assert.ok((run.error ?? "").includes(NOT_AWAITED), String(run.error));
        assert.ok((run.error ?? "").includes(" - this promise was not awaited; add await before the call"), String(run.error));
        if (name === "box-then-throw") assert.equal((run.error ?? "").split("\n")[0], "Error: own error after the box", "the run's own error stays first");
        await sleep(200);
        await stayedUp(body, call, pid);
      });
    });
  }
});

describe("(P1.3) a host that exits with a run in flight puts the crash in the run's error", () => {
  it("an error before the run's code starts is no run's: the run's error is the exit with the message and the frame", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      assert.equal((await call("arm-ack")).status, "ok");
      const since = body.events.since(0).next;
      const waiting = body.events.wait({ types: ["disconnected"], since, timeoutMs: 20_000 });
      // The ack of the arming run's own end is the first the host hears; the ack of this run's start is the second.
      const run = await call("pid");
      const { event } = await waiting;
      assert.ok(event, "the host did not die");
      const reason = String(event.data.reason);
      assert.match(reason, /^bot host restarted: the bot host exited \(code 1\): Error: host code failed before a run's code started \(at .*arm-ack\.ts:\d+:\d+\)$/);
      assert.equal(run.status, "error");
      const crash = reason.slice("bot host restarted: the bot host exited (code 1): ".length);
      assert.equal(run.error, restartedError(`the bot host exited (code 1): ${crash}`));
      // The error carries the message and the frame, as the disconnected reason does.
    });
  });
});

describe("(P1.5, mb-mf5) after a run ends, the pathfinder has no goal and no control is held before the next run's code", () => {
  const free = { goal: null, controls: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false } };
  const stateOf = async (call: (name: string) => Promise<RunResult>) => {
    const { goal, controls } = (await call("state")).result as { goal: unknown; controls: unknown };
    return { goal, controls };
  };

  it("after an ok call", { timeout: 60_000 }, async () => {
    await using(async (_, call) => {
      assert.equal((await call("leave")).result, "left");
      assert.deepEqual(await stateOf(call), free);
    });
  });

  it("after an error", { timeout: 60_000 }, async () => {
    await using(async (_, call) => {
      assert.equal((await call("leave-throw")).status, "error");
      assert.deepEqual(await stateOf(call), free);
    });
  });

  it("after a timeout", { timeout: 60_000 }, async () => {
    await using(async (_, call) => {
      assert.equal((await call("leave-timeout", undefined, 200)).status, "timeout");
      assert.deepEqual(await stateOf(call), free);
    });
  });

  it("after a module run", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const answer = await body.request("POST", "/run", { code: `export default (ctx) => {\n  ctx.bot.pathfinder.setGoal(${GOAL});\n  ctx.bot.setControlState('sneak', true);\n  return 'left';\n};\n` });
      assert.equal((answer.body as RunResult).result, "left");
      assert.deepEqual(await stateOf(call), free);
    });
  });

  it("after a reflex's run", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      await body.ok("POST", "/bind", { kind: "reflex", name: "leaver", routine: "leave", on: ["chat"], cooldownMs: 0 });
      body.events.push("chat", { from: "ana", message: "go" });
      await body.waitFor("reflex_finished");
      assert.deepEqual(await stateOf(call), free);
    });
  });

  it("an unawaited goto that the end-of-run halt cancels ends its run with status error naming the missing await, and the host stays", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const pid = (await call("pid")).result;
      const run = await call("goto-unawaited");
      assert.equal(run.status, "error");
      assert.ok((run.error ?? "").startsWith(`GoalChanged: The goal was changed before it could be completed!${NOT_AWAITED}`), String(run.error));
      assert.ok((run.error ?? "").startsWith("GoalChanged: The goal was changed before it could be completed! - this promise was not awaited; add await before the call"), String(run.error));
      await sleep(200);
      await stayedUp(body, call, pid);
      assert.deepEqual(await stateOf(call), free);
    });
  });
});

describe("a contained run's program_finished event carries the run's own error", () => {
  /** The last `program_finished` event of a run that ended with an error; its `error` is the same text the run answered with. */
  const errorFinish = (body: FakeBody): Record<string, unknown> => {
    const [finished] = body.eventsOf("program_finished").filter((event) => event.data.status === "error").slice(-1);
    assert.ok(finished, "no program_finished event with status error");
    return finished.data;
  };

  it("(P1.1) a throw in a timer while the run awaits: the event names the run's error, not the abort the program's own rejection reported", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const run = await call("timer-throw");
      assert.equal(run.status, "error");
      await sleep(200);
      const { error } = errorFinish(body);
      assert.notEqual(error, "finished", "the host's preview of the run's own abort is not the event's error");
      assert.equal(error, run.error);
    });
  });

  it("(P1.2) a rejection nothing awaited after the program returned: likewise", { timeout: 60_000 }, async () => {
    await using(async (body, call) => {
      const run = await call("box-then-return");
      assert.equal(run.status, "error");
      await sleep(200);
      assert.equal(errorFinish(body).error, run.error);
    });
  });
});
