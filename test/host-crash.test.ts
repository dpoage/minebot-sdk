// A bot host that dies of an uncaught exception or an unhandled rejection reports the error to its
// supervisor before it exits, and the `disconnected` event of the restart names the error's message
// and its top stack frame. The host is the real one (src/host/main.ts) with a fake player; routines
// are saved in a temporary library, bound, and called over the supervisor, as an agent does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostInit } from "../src/protocol/host.ts";
import type { RunResult } from "../src/protocol/index.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-host-crash-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "host");

// MINEBOT_RUNTIME_DIR is read when the discovery module loads.
const { EventLog } = await import("../src/body/events.ts");
const { HostProcess } = await import("../src/body/host-process.ts");
const { ProgramHistory } = await import("../src/body/history.ts");
const { restartedError } = await import("../src/protocol/host.ts");

after(() => rmSync(ROOT, { recursive: true, force: true }));

interface Answer {
  status: number;
  body: unknown;
}

interface Scene {
  /** Forwards one API request to the host. */
  api(method: string, url: string, content?: unknown): Promise<Answer>;
  /** Calls the routine bound under `name`. */
  call(name: string): Promise<Answer>;
  /** The pid a routine called now reports: the host that answers. */
  pid(): Promise<number>;
  /** The library directory's real path: what a routine's frames name. */
  library: string;
  events: InstanceType<typeof EventLog>;
}

let scenes = 0;

/** Runs `body` against a supervisor with a real host whose library holds `routines`, each bound under its own name. */
async function withHost(routines: Record<string, string>, body: (scene: Scene) => Promise<void>): Promise<void> {
  const dir = path.join(ROOT, `scene-${scenes++}`);
  const library = path.join(dir, "routines");
  mkdirSync(library, { recursive: true });
  const events = new EventLog();
  const init = {
    name: "crash",
    username: "crash",
    auth: "offline",
    host: "127.0.0.1",
    port: 25565,
    lockKits: false,
    wikiMode: "off",
    stateDir: path.join(dir, "state"),
    routinesDir: library,
    milestonesEnabled: false,
    agentKits: false,
    startedAt: "t0",
    deaths: 0,
    reconnects: 0,
    applyMilestones: true,
  };
  const host = new HostProcess({ init: init as HostInit, events, history: new ProgramHistory({}), entry: path.join(FIXTURES, "crash-host.ts") });
  const api = (method: string, url: string, content?: unknown): Promise<Answer> =>
    host.forward({ method, url, body: content === undefined ? null : Buffer.from(JSON.stringify(content)), tooLarge: false });
  const call = (name: string) => api("POST", "/call", { name });
  try {
    await host.start();
    host.join();
    await events.wait({ types: ["connected"], timeoutMs: 20_000 });
    for (const [name, source] of Object.entries({ pid: "export default () => process.pid;\n", ...routines })) {
      assert.equal((await api("POST", "/routines/save", { name, source })).status, 200, name);
      assert.equal((await api("POST", "/bind", { kind: "action", name, routine: name })).status, 200, name);
    }
    const pid = async (): Promise<number> => {
      // The replacement host answers once it is up and its player has joined; until then the answer is that the body is not connected.
      for (let i = 0; i < 200; i++) {
        const answer = await call("pid");
        const result = answer.body as RunResult;
        if (answer.status === 200 && result.status === "ok") return result.result as number;
        await sleep(100);
      }
      throw new Error("no host answered");
    };
    await body({ api, call, pid, library: realpathSync(library), events });
  } finally {
    await host.close();
  }
}

/** The 1-based line of the first line of `source` that holds `needle`. */
function lineOf(source: string, needle: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, needle);
  return index + 1;
}

/** The next `disconnected` event's reason once `trigger` has run, and the pid of the host before and after it. */
async function death(scene: Scene, trigger: () => Promise<unknown>): Promise<{ reason: string; before: number; after: number; triggered: unknown }> {
  const before = await scene.pid();
  const since = scene.events.since(0).next;
  const waiting = scene.events.wait({ types: ["disconnected"], since, timeoutMs: 20_000 });
  const triggered = await trigger();
  const { event } = await waiting;
  assert.ok(event, "the host's death was not reported");
  return { reason: String(event.data.reason), before, after: await scene.pid(), triggered };
}

describe("a host that dies of an uncaught error names it in the restart's disconnected event", () => {
  const FIRST = "bot host restarted: the bot host exited (code 1): ";

  it("(a) thrown by a routine's timer during a call: the message and the routine's line, a new host, and the run's own error unchanged", { timeout: 60_000 }, async () => {
    const source = "export default async (ctx: { sleep(ms: number): Promise<void> }) => {\n  setTimeout(() => {\n    throw new Error('thrown during a call');\n  }, 50);\n  await ctx.sleep(20_000);\n};\n";
    await withHost({ during: source }, async (scene) => {
      const { reason, before, after, triggered } = await death(scene, () => scene.call("during"));
      const file = path.join(scene.library, "during.ts");
      assert.match(reason, new RegExp(`^${RegExp.escape(FIRST)}Error: thrown during a call \\(at ${RegExp.escape(file)}:${lineOf(source, "throw new Error")}:\\d+\\)$`));
      assert.notEqual(after, before, "the same host answered");
      const run = (triggered as Answer).body as RunResult;
      assert.equal(run.status, "error");
      assert.equal(run.error, restartedError("the bot host exited (code 1)"), "the run's error does not carry the crash");
    });
  });

  it("(b) thrown by a routine's leftover timer after its call ended: the library file and line of the throw, not the native frame above it", { timeout: 60_000 }, async () => {
    const source = "export default () => {\n  setTimeout(() => {\n    JSON.parse('{');\n  }, 200);\n  return 'left a timer';\n};\n";
    let message = "";
    try {
      JSON.parse("{");
    } catch (err) {
      message = (err as Error).message;
    }
    await withHost({ leftover: source }, async (scene) => {
      const { reason, before, after, triggered } = await death(scene, () => scene.call("leftover"));
      assert.equal(((triggered as Answer).body as RunResult).result, "left a timer", "the call ended before the host died");
      const file = path.join(scene.library, "leftover.ts");
      assert.match(reason, new RegExp(`^${RegExp.escape(FIRST)}SyntaxError: ${RegExp.escape(message)} \\(at ${RegExp.escape(file)}:${lineOf(source, "JSON.parse")}:\\d+\\)$`));
      assert.doesNotMatch(reason, /<anonymous>/);
      assert.notEqual(after, before);
    });
  });

  it("(b) the same for a promise a routine's leftover timer rejects: the library line of the error's construction", { timeout: 60_000 }, async () => {
    const source = "export default () => {\n  setTimeout(() => {\n    void Promise.reject(new Error('rejected after the call'));\n  }, 200);\n  return 'left a timer';\n};\n";
    await withHost({ later: source }, async (scene) => {
      const { reason, before, after } = await death(scene, () => scene.call("later"));
      const file = path.join(scene.library, "later.ts");
      assert.match(reason, new RegExp(`^${RegExp.escape(FIRST)}Error: rejected after the call \\(at ${RegExp.escape(file)}:${lineOf(source, "Promise.reject")}:\\d+\\)$`));
      assert.notEqual(after, before);
    });
  });

  it("(b) names a rejection that is not an error by its text alone", { timeout: 60_000 }, async () => {
    const source = "export default () => {\n  setTimeout(() => {\n    void Promise.reject('plain text');\n  }, 200);\n  return 'left a timer';\n};\n";
    await withHost({ plain: source }, async (scene) => {
      const { reason, before, after } = await death(scene, () => scene.call("plain"));
      assert.equal(reason, `${FIRST}plain text`);
      assert.notEqual(after, before);
    });
  });

  for (const [mode, message] of [["throw", "host code failed outside any run"], ["reject", "host promise rejected outside any run"]] as const) {
    it(`(c) ${mode === "throw" ? "thrown" : "rejected"} by host code outside any run: the message and the first frame, which no routine file holds`, { timeout: 60_000 }, async () => {
      await withHost({}, async (scene) => {
        const { reason, before, after } = await death(scene, () => scene.api("GET", `/crash?mode=${mode}`));
        const fixture = path.join(FIXTURES, "crash-host.ts");
        assert.match(reason, new RegExp(`^${RegExp.escape(FIRST)}Error: ${RegExp.escape(message)} \\(at ${RegExp.escape(fixture)}:\\d+:\\d+\\)$`));
        assert.notEqual(after, before, "the same host answered");
      });
    });
  }

  // A function with no name has no parentheses around its frame's location: the location is all that follows `at ` (or `at async `), whatever the path holds.
  const unnamed = [
    {
      what: "thrown by a function with no name",
      file: "throws.cjs",
      message: "thrown by a function with no name",
      source: "[1].forEach(() => {\n  throw new Error('thrown by a function with no name');\n});\n",
      line: "throw new Error",
    },
    {
      what: "rejected with an async frame of a function with no name on top",
      file: "rejects.cjs",
      message: "rejected under an async frame",
      source:
        "async function inner() {\n  await null;\n  const error = new Error('rejected under an async frame');\n  Error.captureStackTrace(error, inner);\n  throw error;\n}\nsetTimeout(() => {\n  void (async () => {\n    await inner();\n  })();\n}, 0);\n",
      line: "await inner()",
    },
  ];
  for (const { what, file, message, source, line } of unnamed) {
    it(`(c) ${what}, in a file whose path holds spaces, parentheses and non-ASCII letters: the whole path, line and column`, { timeout: 60_000 }, async () => {
      const dir = path.join(ROOT, "sp ace ünï (cødé)");
      mkdirSync(dir, { recursive: true });
      const thrower = path.join(realpathSync(dir), file);
      writeFileSync(thrower, source);
      await withHost({}, async (scene) => {
        const { reason, before, after } = await death(scene, () => scene.api("GET", `/crash?mode=require&file=${encodeURIComponent(thrower)}`));
        assert.match(reason, new RegExp(`^${RegExp.escape(FIRST)}Error: ${RegExp.escape(message)} \\(at ${RegExp.escape(thrower)}:${lineOf(source, line)}:\\d+\\)$`));
        assert.notEqual(after, before, "the same host answered");
      });
    });
  }
});
