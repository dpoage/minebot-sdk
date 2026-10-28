// The program history of a body that ran programs (the real bot host and supervisor over a fake player, see
// fixtures/host/fake-body.ts): one line per started run, written when the run ends, and one line per reflex bind.
// A run whose source names `process` and calls `require(` gets a line like any other: the history carries no audit.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunResult } from "../src/protocol/index.ts";
import { removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";
import { withoutCheckSkip } from "./fixtures/without-check-skip.ts";

after(removeScratch);

/** The status a run or call answered; the answer must be a 200. */
const statusOf = (answer: { status: number; body: unknown }): string => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const result = answer.body as RunResult; // the body's answer to a run, a call, or a firing is a RunResult
  return result.status;
};

describe("the program history of a body that ran programs", () => {
  it("has exactly one line per started run and one per reflex bind, none of them an audit flag or a pre-run line", async () => {
    const body = await startFakeBody();
    try {
      const source = 'export default async () => {\n  const os = require("node:os");\n  return [typeof os.platform(), typeof process.pid];\n};\n';
      body.writeRoutines({
        act: "export default () => 'acted';\n",
        say: "export default async (ctx, args) => {\n  ctx.bot.emit('chat', args.from, args.message);\n};\n",
        greet: "export default () => 'greeted';\n",
      });
      await body.ok("POST", "/bind", { kind: "action", name: "act", routine: "act" });
      await body.ok("POST", "/bind", { kind: "action", name: "say", routine: "say" });
      // The bind of a reflex is a line of its own. Its `when` names `process` in a comment.
      await body.ok("POST", "/bind", { kind: "reflex", name: "greet", routine: "greet", on: ["chat"], when: "event.data.from === 'alice' /* process */", cooldownMs: 0 });

      assert.equal(statusOf(await body.request("POST", "/run", { code: source })), "ok");
      assert.equal(statusOf(await body.request("POST", "/call", { name: "act" })), "ok");
      assert.equal(statusOf(await body.request("POST", "/call", { name: "say", args: { from: "alice", message: "hi" } })), "ok");
      const deadline = Date.now() + 10_000;
      while (body.eventsOf("reflex_finished").length < 1 && Date.now() < deadline) await sleep(20);
      assert.equal(body.eventsOf("reflex_finished").length, 1, "the reflex fired once");
      await sleep(100);

      const heard = body.eventsOf("chat").find((event) => event.data.from === "alice")!;
      const normalized = body.history().map((line) => ({ ...line, startedAt: typeof line.startedAt, ...("durationMs" in line && { durationMs: typeof line.durationMs }), ...("logs" in line && { logs: withoutCheckSkip(String(line.logs)) }) }));
      assert.deepStrictEqual(normalized, [
        { seq: 1, startedAt: "string", code: "event.data.from === 'alice' /* process */", trigger: "greet", routine: "greet", on: ["chat"], status: "registered" },
        { seq: 2, startedAt: "string", code: source, status: "ok", result: ["string", "number"], logs: "", durationMs: "number" },
        { seq: 3, startedAt: "string", code: "", call: { name: "act", routine: "act" }, status: "ok", result: "acted", logs: "", durationMs: "number" },
        { seq: 4, startedAt: "string", code: "", call: { name: "say", routine: "say", args: { from: "alice", message: "hi" } }, status: "ok", logs: "", durationMs: "number" },
        { seq: 5, startedAt: "string", code: "", trigger: "greet", routine: "greet", event: { seq: heard.seq, type: "chat" }, status: "ok", result: "greeted", logs: "", durationMs: "number" },
      ]);
    } finally {
      await body.close();
    }
  });
});
