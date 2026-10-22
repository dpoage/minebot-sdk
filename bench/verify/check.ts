// Verifier entrypoint for benchmark tasks: `node /opt/verifier/bench/verify/check.ts /tests/milestones.json`.
// Runs in a container of its own, built from the verifier image plus the task's tests/ directory, apart from the agent's container.
// It reads three files that Harbor copies in from the sidecars:
//   /var/log/grading/stats.json       the player's statistics, taken by the grader after an RCON save (bench/verify/snapshot.ts)
//   /var/log/grading/world.json       what the server's files and RCON show of the world: containers, the clock, the player's position
//   /var/log/minebot/programs.jsonl   every program the agent ran
// It grades the statistics and the world facts, fails the trial when a program tried to escape the program VM, and writes Harbor's reward files.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findEscapeAttempts } from "../../src/audit.ts";
import { PlayerStats } from "../../src/milestones/milestones.ts";
import { gradeTrial, WorldFacts } from "./checks.ts";
import { HistoryRecord } from "./history.ts";
import { MilestoneSpec } from "./milestones.ts";

const specFile = process.argv[2];
if (!specFile) throw new Error("usage: check.ts <milestones.json>");
const env = {
  statsFile: process.env.STATS_FILE ?? "/var/log/grading/stats.json",
  worldFile: process.env.WORLD_FILE ?? "/var/log/grading/world.json",
  historyFile: process.env.HISTORY_FILE ?? "/var/log/minebot/programs.jsonl",
  rewardDir: process.env.REWARD_DIR ?? "/logs/verifier",
};

const spec = MilestoneSpec.parse(JSON.parse(await readFile(specFile, "utf8")));
const stats = PlayerStats.parse(JSON.parse(await readFile(env.statsFile, "utf8")));
// Only a task with checks needs the world facts. Without them (the snapshot failed), the checks that need them fail.
const world =
  spec.checks.length === 0
    ? null
    : await readFile(env.worldFile, "utf8").then(
        (text) => WorldFacts.parse(JSON.parse(text)),
        (err: unknown) => {
          console.log(`no world facts: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      );

// A program that tried to escape is flagged twice: by the body when it ran the program, and here, from its source.
const history = (await readFile(env.historyFile, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => HistoryRecord.parse(JSON.parse(line)));
const flagged = new Map<number, string[]>();
for (const record of history) {
  const attempts = [...new Set([...record.escapeAttempts, ...findEscapeAttempts(record.code)])];
  if (attempts.length > 0) flagged.set(record.seq, attempts);
}
const disqualified =
  flagged.size === 0
    ? undefined
    : {
        reason: `program ${[...flagged.keys()].join(", ")} used a pattern that reaches outside the program environment (${[...new Set([...flagged.values()].flat())].join(", ")}); a trial that ran such a program gets reward 0`,
        programs: Object.fromEntries(flagged),
      };

const result = gradeTrial(spec, stats, world);
const reward = disqualified ? 0 : result.reward;
await mkdir(env.rewardDir, { recursive: true });
await writeFile(
  path.join(env.rewardDir, "reward.json"),
  `${JSON.stringify({ reward, progress: result.progress, disqualified: disqualified ? 1 : 0 })}\n`,
);
await writeFile(path.join(env.rewardDir, "milestones.json"), `${JSON.stringify({ ...result, reward, ...(disqualified && { disqualified }) }, null, 2)}\n`);
for (const m of result.milestones) {
  console.log(`${m.met ? "PASS" : "FAIL"} ${m.id}: ${m.obtained}/${m.needed} ${JSON.stringify(m.detail)}`);
}
for (const c of result.checks) {
  console.log(`${c.met ? "PASS" : "FAIL"} ${c.id}: ${c.obtained} (needs ${c.requirement}) ${JSON.stringify(c.detail)}`);
}
if (disqualified) console.log(`DISQUALIFIED: ${disqualified.reason}`);
console.log(`reward=${reward} progress=${result.progress.toFixed(2)}`);
