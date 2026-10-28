// What a run's own listeners on `ctx.bot` do: a throw from one ends that run (naming the throw) instead of taking the
// emitter's dispatch down with it (P3.1), and every one of them is gone at every end of the run (P3.2). The body is the
// real host over the fake player (fixtures/host/fake-body.ts), whose bot is a real EventEmitter: an `emit` on it is the
// dispatch a server packet drives.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { RunResult } from "../src/protocol/index.ts";
import { type FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const ROUTINES: Record<string, string> = {
  // P3.1: a throwing listener, then a listener that hears the same emission. The emission comes from a timer, as a
  // packet does, not from the throwing call itself.
  "throw-in-listener": `export default async (ctx) => {
  const bot = ctx.bot;
  // The connection's own time listener reads the clock the server's time packet fills.
  bot.time = { timeOfDay: 1000 };
  bot.once("time", () => {
    throw new Error("listener boom");
  });
  bot.on("time", () => {
    bot.probeHeard = (bot.probeHeard ?? 0) + 1;
  });
  setTimeout(() => bot.emit("time"), 30);
  await ctx.sleep(30_000);
  return "the timer never fired";
};
`,
  // A listener a later run adds to the same event: the event still dispatches after the contained throw.
  "fresh-listener": `export default (ctx) => {
  const { promise, resolve } = Promise.withResolvers();
  ctx.bot.once("time", () => resolve("heard a later time"));
  setTimeout(() => ctx.bot.emit("time"), 30);
  return promise;
};
`,
  // P3.2: one listener of every kind, then one of the four ends.
  attach: `export default async (ctx, args) => {
  const bot = ctx.bot;
  bot.on("s3-on", () => {});
  bot.once("s3-once", () => {});
  bot.addListener("s3-add", () => {});
  bot.prependListener("s3-prepend", () => {});
  bot.prependOnceListener("s3-prepend-once", () => {});
  if (args?.end === "error") throw new Error("own error");
  if (args?.end === "timeout" || args?.end === "stop") {
    bot.emit("chat", "someone", "attached");
    await ctx.sleep(30_000);
  }
  return "left";
};
`,
  // A built-in routine's own cleanup: `off` after `on`, before the run ends.
  "off-works": `export default (ctx) => {
  const bot = ctx.bot;
  const handler = () => {};
  bot.on("s3-off", handler);
  const during = bot.listenerCount("s3-off");
  bot.off("s3-off", handler);
  bot.removeListener("s3-off", handler);
  return { during, after: bot.listenerCount("s3-off") };
};
`,
  counts: `export default (ctx) => {
  const bot = ctx.bot;
  return {
    "s3-on": bot.listenerCount("s3-on"),
    "s3-once": bot.listenerCount("s3-once"),
    "s3-add": bot.listenerCount("s3-add"),
    "s3-prepend": bot.listenerCount("s3-prepend"),
    "s3-prepend-once": bot.listenerCount("s3-prepend-once"),
    "s3-off": bot.listenerCount("s3-off"),
    // The connection's own listener: a run's listener on the same packet event is gone, this one stays.
    time: bot.listenerCount("time"),
  };
};
`,
  heard: `export default (ctx) => ctx.bot.probeHeard ?? null;
`,
  // P3.2's crash: a listener the run leaves behind throws on a later tick, with no run to contain it.
  "leave-thrower": `export default (ctx) => {
  ctx.bot.on("physicsTick", () => {
    throw new Error("stale listener");
  });
  setTimeout(() => ctx.bot.emit("physicsTick"), 400);
  return "left";
};
`,
  pid: "export default () => process.pid;\n",
};

type Call = (name: string, args?: unknown, timeoutMs?: number) => Promise<RunResult>;

async function using(test: (body: FakeBody, call: Call) => Promise<void>): Promise<void> {
  const body = await startFakeBody({ stateFiles: Object.fromEntries(Object.entries(ROUTINES).map(([name, source]) => [`routines/${name}.ts`, source])) });
  try {
    for (const name of Object.keys(ROUTINES)) await body.ok("POST", "/bind", { kind: "action", name, routine: name });
    const call: Call = async (name, args, timeoutMs) => {
      const answer = await body.request("POST", "/call", { name, args, timeoutMs });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as RunResult;
    };
    await test(body, call);
  } finally {
    await body.close();
  }
}

/** The connection's listener on a packet event is the body's: a run's listeners are what the count must not gain. */
const countsOf = async (call: Call): Promise<Record<string, number>> => (await call("counts")).result as Record<string, number>;

describe("(P3.1) a throw in a listener the run added to ctx.bot ends that run, and the event's dispatch goes on", () => {
  it("ends the run with status error naming the throw, and the listener after it hears the same event", { timeout: 30_000 }, async () => {
    await using(async (body, call) => {
      const pid = (await call("pid")).result;
      const before = await countsOf(call);
      const run = await call("throw-in-listener");
      assert.equal(run.status, "error");
      assert.equal((run.error ?? "").split("\n")[0], "Error: listener boom");
      // The emitter called the next listener of that same dispatch: the throw was the run's, not the packet's.
      assert.equal((await call("heard")).result, 1, "the dispatch stopped at the throwing listener");
      // A later run's listener hears the event too, and the body is still the same host.
      assert.equal((await call("fresh-listener")).result, "heard a later time");
      assert.equal((await call("pid")).result, pid, "the host restarted");
      assert.deepEqual(body.eventsOf("disconnected"), []);
      assert.deepEqual(await countsOf(call), before, "the run's listeners are still on the bot");
    });
  });
});

describe("(P3.2) every listener a run adds to ctx.bot is removed when the run ends", () => {
  it("ok: on, once, addListener, prependListener, and prependOnceListener are all gone", { timeout: 30_000 }, async () => {
    await using(async (_body, call) => {
      const before = await countsOf(call);
      assert.equal((await call("attach")).result, "left");
      assert.deepEqual(await countsOf(call), before);
    });
  });

  it("error: all are gone", { timeout: 30_000 }, async () => {
    await using(async (_body, call) => {
      const before = await countsOf(call);
      assert.equal((await call("attach", { end: "error" })).status, "error");
      assert.deepEqual(await countsOf(call), before);
    });
  });

  it("timeout: all are gone", { timeout: 30_000 }, async () => {
    await using(async (_body, call) => {
      const before = await countsOf(call);
      assert.equal((await call("attach", { end: "timeout" }, 200)).status, "timeout");
      assert.deepEqual(await countsOf(call), before);
    });
  });

  it("stop: all are gone", { timeout: 30_000 }, async () => {
    await using(async (body, call) => {
      const before = await countsOf(call);
      const since = body.events.since(0).next;
      const pending = body.request("POST", "/call", { name: "attach", args: { end: "stop" } });
      // The routine says it has attached its listeners; it then holds the run until the stop.
      await body.waitFor("chat", since);
      assert.deepEqual(await body.host.stop(), { stopped: true });
      assert.equal(((await pending).body as RunResult).status, "stopped");
      assert.deepEqual(await countsOf(call), before);
    });
  });

  it("a built-in routine's own off removes its listener during the run, through ctx.bot", { timeout: 30_000 }, async () => {
    await using(async (_body, call) => {
      assert.deepEqual((await call("off-works")).result, { during: 1, after: 0 });
      assert.equal((await countsOf(call))["s3-off"], 0);
    });
  });

  it("a listener left behind throws on a later tick with no run to contain it: the host stays", { timeout: 30_000 }, async () => {
    await using(async (body, call) => {
      const pid = (await call("pid")).result;
      const since = body.events.since(0).next;
      assert.equal((await call("leave-thrower")).status, "ok");
      // The timer outlives the run; the listener must not. Its throw would reach a process handler with no run to
      // contain it, and the host would exit; its restart is the `disconnected` event this wait gives the time for.
      const { event } = await body.events.wait({ types: ["disconnected"], since, timeoutMs: 1_500 });
      assert.equal(event, null, "a stale listener restarted the host");
      assert.equal((await call("pid")).result, pid, "another host answered");
    });
  });
});
