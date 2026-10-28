// G1: a run that dies calling a bot member that is not a function ends with one instruction line naming the
// real member to use instead — the runner's `explain` hook, wired to explainError over the live bot. The line
// is the LAST line of the error, after the message and the run's frames. A run with no such member gets none.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeRunCheck } from "../src/host/typecheck.ts";
import type { RunResult } from "../src/protocol/index.ts";
import { removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(async () => {
  // The warm checker's compiler child would otherwise keep this process alive.
  await closeRunCheck();
  removeScratch();
});

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

/** A run source whose first line is the bypass, so the type check lets a call the typings refuse through. */
const unchecked = (body: string): string => `// @ts-nocheck\nexport default async (ctx) => {\n${body}\n};\n`;

describe("a run that dies calling a bot member that is not a function", () => {
  it("ends status error, and its last line names the member to use instead", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      const run = runOf(await body.request("POST", "/run", { code: unchecked('  const { bot } = ctx;\n  bot.selectItem("dirt");') }));
      assert.equal(run.status, "error", run.error ?? "");
      const lines = (run.error ?? "").split("\n");
      assert.match(lines[0]!, /^TypeError: bot\.selectItem is not a function/, run.error ?? "");
      assert.equal(lines.at(-1), 'bot.selectItem does not exist: use bot.equip(item, "hand")', run.error ?? "");
    } finally {
      await body.close();
    }
  });

  it("says a member that is a value is read, not called", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      // The bypass runs it unchecked, so the typings need no cast to let the call through.
      const run = runOf(await body.request("POST", "/run", { code: unchecked("  const { bot } = ctx;\n  bot.isRaining?.();") }));
      assert.equal(run.status, "error", run.error ?? "");
      const lines = (run.error ?? "").split("\n");
      assert.match(lines[0]!, /^TypeError: .*isRaining is not a function/, run.error ?? "");
      assert.equal(lines.at(-1), "bot.isRaining is a boolean, not a function: read bot.isRaining", run.error ?? "");
    } finally {
      await body.close();
    }
  });

  it("adds no line for an error that is not about a bot member", { timeout: 120_000 }, async () => {
    const body = await startFakeBody({});
    try {
      const run = runOf(await body.request("POST", "/run", { code: unchecked('  throw new Error("plain");') }));
      assert.equal(run.status, "error", run.error ?? "");
      // The message and its frame, and no instruction line.
      assert.match((run.error ?? "").split("\n")[0]!, /^Error: plain$/, run.error ?? "");
      assert.doesNotMatch(run.error ?? "", /does not exist|is a boolean/, run.error ?? "");
    } finally {
      await body.close();
    }
  });
});
