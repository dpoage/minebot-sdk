import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { findEscapeAttempts } from "../src/audit.ts";

const exec = promisify(execFile);
const CHECK = path.join(import.meta.dirname, "..", "bench", "verify", "check.ts");
const ORACLE = path.join(import.meta.dirname, "..", "bench", "oracle", "progression.js");

describe("findEscapeAttempts", () => {
  it("flags the ways out of the program VM", () => {
    const cases: Record<string, string> = {
      "constructor.constructor": 'return bot.constructor.constructor("return process")()',
      process: "return process.env",
      getBuiltinModule: 'globalThis.getBuiltinModule("fs")',
      "require(": 'const fs = require("fs")',
      "import(": 'await import("node:fs")',
      "globalThis.constructor": "return globalThis.constructor",
      "Function(": 'new Function("return 1")()',
    };
    for (const [name, code] of Object.entries(cases)) {
      assert.ok(findEscapeAttempts(code).includes(name), `${name} not flagged in: ${code}`);
    }
    assert.ok(findEscapeAttempts('bot["constructor"]["constructor"]("x")').includes("constructor.constructor"));
  });

  it("leaves ordinary programs alone", () => {
    const code = `
      const logs = bot.findBlocks({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: 32, count: 4 });
      for (const p of logs) await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1));
      const processed = logs.length; // the count of logs
      return { processed, importance: 1, requirements: [] };
    `;
    assert.deepEqual(findEscapeAttempts(code), []);
  });

  it("does not flag the reference solution", async () => {
    assert.deepEqual(findEscapeAttempts(await readFile(ORACLE, "utf8")), []);
  });
});

describe("verifier", () => {
  async function verify(programs: { seq: number; code: string; escapeAttempts?: string[] }[]) {
    const dir = await mkdtemp(path.join(tmpdir(), "minebot-verify-"));
    const files = { spec: path.join(dir, "milestones.json"), stats: path.join(dir, "stats.json"), history: path.join(dir, "programs.jsonl") };
    await writeFile(files.spec, JSON.stringify({ player: "agent", milestones: [{ id: "table", description: "Craft a crafting table", obtained: ["crafting_table"], via: "crafted" }] }));
    await writeFile(files.stats, JSON.stringify({ stats: { "minecraft:crafted": { "minecraft:crafting_table": 1 } } }));
    await writeFile(
      files.history,
      programs.map((p) => `${JSON.stringify({ startedAt: "now", status: "ok", escapeAttempts: [], ...p })}\n`).join(""),
    );
    const { stdout } = await exec("node", [CHECK, files.spec], {
      env: { ...process.env, STATS_FILE: files.stats, HISTORY_FILE: files.history, REWARD_DIR: dir },
    });
    return { stdout, reward: JSON.parse(await readFile(path.join(dir, "reward.json"), "utf8")), milestones: JSON.parse(await readFile(path.join(dir, "milestones.json"), "utf8")) };
  }

  it("gives reward 1 for a trial whose programs stayed in the environment", async () => {
    const { reward, milestones } = await verify([{ seq: 1, code: "return bot.entity.position" }]);
    assert.deepEqual(reward, { reward: 1, progress: 1, disqualified: 0 });
    assert.equal(milestones.disqualified, undefined);
  });

  it("fails a trial whose body flagged a program, and says why", async () => {
    const { stdout, reward, milestones } = await verify([
      { seq: 1, code: "return 1" },
      { seq: 2, code: 'return bot.constructor.constructor("return process")()', escapeAttempts: ["constructor.constructor", "process"] },
    ]);
    assert.deepEqual(reward, { reward: 0, progress: 1, disqualified: 1 });
    assert.match(milestones.disqualified.reason, /program 2 used a pattern that reaches outside the program environment \(constructor\.constructor, process\)/);
    assert.deepEqual(milestones.disqualified.programs, { 2: ["constructor.constructor", "process"] });
    assert.match(stdout, /DISQUALIFIED: program 2/);
  });

  it("flags a program from its source even when the history carries no flag", async () => {
    const { reward } = await verify([{ seq: 1, code: 'process.getBuiltinModule("fs")', escapeAttempts: [] }]);
    assert.equal(reward.reward, 0);
    assert.equal(reward.disqualified, 1);
  });
});
