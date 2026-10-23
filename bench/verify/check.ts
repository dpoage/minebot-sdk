// Verifier entrypoint for benchmark tasks: `node /opt/verifier/bench/verify/check.ts /tests/milestones.json`.
// Runs in a container of its own, built from the verifier image plus the task's tests/ directory, apart from the agent's container.
// In a task with several steps, Harbor runs it for every step; for a step that is not the last, the agent's containers can still be up.
// It reads two files that Harbor copies in from the sidecars:
//   /var/log/grading/stats.json   the player's statistics, taken by the grader after an RCON save (bench/verify/snapshot.ts)
//   /var/log/grading/world.json   what the server's files and RCON show of the world: containers, the clock, the player's position
// The reward is a function of the task's spec, the statistics, and the world facts: nothing the agent's body wrote is an input.
// It grades them and writes Harbor's reward files.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PlayerStats } from "../../src/milestones/milestones.ts";
import { gradeTrial, WorldFacts } from "./checks.ts";
import { MilestoneSpec } from "./milestones.ts";

const specFile = process.argv[2];
if (!specFile) throw new Error("usage: check.ts <milestones.json>");
const env = {
  statsFile: process.env.STATS_FILE ?? "/var/log/grading/stats.json",
  worldFile: process.env.WORLD_FILE ?? "/var/log/grading/world.json",
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

const result = gradeTrial(spec, stats, world);
await mkdir(env.rewardDir, { recursive: true });
await writeFile(path.join(env.rewardDir, "reward.json"), `${JSON.stringify({ reward: result.reward, progress: result.progress })}\n`);
await writeFile(path.join(env.rewardDir, "milestones.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const m of result.milestones) {
  console.log(`${m.met ? "PASS" : "FAIL"} ${m.id}: ${m.obtained}/${m.needed} ${JSON.stringify(m.detail)}`);
}
for (const c of result.checks) {
  console.log(`${c.met ? "PASS" : "FAIL"} ${c.id}: ${c.obtained} (needs ${c.requirement}) ${JSON.stringify(c.detail)}`);
}
console.log(`reward=${result.reward} progress=${result.progress.toFixed(2)}`);
