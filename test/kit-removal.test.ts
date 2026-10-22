// What the body no longer has once the kits are gone, checked on the surfaces that stay: the context
// of a run loses `kit` and `kits` and nothing else, and the lines of the program history carry no kit field and still parse as the benchmark's verifier reads them.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { HistoryRecord } from "../bench/verify/history.ts";
import { routineContext, type GlobalsDeps } from "../src/host/globals.ts";
import { Notes } from "../src/notes.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";
import { JsonStore } from "../src/store.ts";
import type { WikiAccess } from "../src/wiki/access.ts";
import type { Connection } from "../src/host/connection.ts";
import { removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const FEATURES: BodyFeatures = { wiki: "read", lessons: false, milestones: false, reflexes: true, routines: true, builtins: ["move"] };

function depsFor(features: BodyFeatures): GlobalsDeps {
  return {
    connection: { requireBot: () => ({}) as Bot } as unknown as Connection,
    wiki: {} as WikiAccess,
    notes: new Notes(JsonStore.memory()),
    store: () => JsonStore.memory(),
    observe: () => () => {},
    features: () => features,
    status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
  };
}

const SCOPE = { log: () => {}, sleep: async () => {}, signal: new AbortController().signal, on: () => {} };

describe("the context of a routine", () => {
  it("has exactly bot, log, sleep, signal, on, notes, status, and store, with wiki where the wiki is on", () => {
    for (const wiki of ["off", "read", "write"] as const) {
      const features = { ...FEATURES, wiki, lessons: wiki === "write" };
      const names = Object.keys(routineContext(SCOPE, depsFor(features))).sort();
      assert.deepEqual(names, ["bot", "log", "notes", "on", "signal", "sleep", "status", "store", ...(wiki === "off" ? [] : ["wiki"])].sort(), `wiki ${wiki}`);
    }
  });
});

describe("the program history of a body", () => {
  it("has lines the benchmark's verifier parses, which carry no kits and no active set", async () => {
    const body = await startFakeBody();
    try {
      body.writeRoutines({ act: "export default () => 1;\n" });
      await body.ok("POST", "/bind", { kind: "action", name: "act", routine: "act" });
      const reflex = { kind: "reflex", name: "r", routine: "act", on: ["chat"], when: "event.data.message.length > 0" };
      await body.ok("POST", "/bind", reflex);
      const answer = await body.request("POST", "/call", { name: "act" });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const source = "export default (_ctx: unknown, args: { n: number }) => args.n;\n";
      const ran = await body.request("POST", "/run", { code: source, args: { n: 2 } });
      assert.equal(ran.status, 200, JSON.stringify(ran.body));

      const lines = body.history();
      // The registration of the reflex's `when`, the call's start, and its end; then the run's.
      assert.deepEqual(lines.map((line) => line.status), ["registered", "ok", "ok"]);
      for (const line of lines) {
        const record = HistoryRecord.parse(line);
        assert.equal(typeof record.code, "string");
        assert.deepEqual(Object.keys(line).filter((key) => /kit|active/i.test(key)), [], JSON.stringify(line));
      }
      assert.equal(HistoryRecord.parse(lines[0]).code, "event.data.message.length > 0");
      assert.equal(HistoryRecord.parse(lines[2]).code, source);
    } finally {
      await body.close();
    }
  });
});
