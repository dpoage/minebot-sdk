// Shows live progress of running Harbor trials: agent turns, programs, errors, the player's state.
//   node bench/watch.ts [job-dir] [--follow]
// Default job: the most recently modified directory under bench/runs/.
// Reads the agent trajectory Harbor writes while the trial runs, and asks the trial's
// containers for the program history and the player's state.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const RUNS = path.join(import.meta.dirname, "runs");
const ENGINE = process.env.CONTAINER_ENGINE ?? "podman";

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const jobArg = args.find((a) => !a.startsWith("--"));

async function latestJob(): Promise<string> {
  const dirs = await Promise.all(
    (await readdir(RUNS, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map(async (e) => ({ dir: path.join(RUNS, e.name), mtime: (await stat(path.join(RUNS, e.name))).mtimeMs })),
  );
  const latest = dirs.sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest) throw new Error(`no jobs in ${RUNS}`);
  return latest.dir;
}

/** Runs a command in a trial container; undefined when the container is gone. */
async function exec(container: string, ...cmd: string[]): Promise<string | undefined> {
  try {
    return (await run(ENGINE, ["exec", container, ...cmd], { timeout: 10_000 })).stdout;
  } catch {
    return undefined;
  }
}

interface Step {
  source?: string;
  message?: string;
}

async function trialLines(dir: string): Promise<string[]> {
  const name = path.basename(dir);
  const lines: string[] = [];
  const reward = path.join(dir, "verifier", "reward.json");
  if (existsSync(reward)) {
    lines.push(`${name}  done  ${(await readFile(reward, "utf8")).trim()}`);
    return lines;
  }
  const started = (await stat(path.join(dir, "config.json")).catch(() => null))?.mtimeMs;
  const minutes = started ? ((Date.now() - started) / 60_000).toFixed(1) : "?";
  let turns = 0;
  let last = "";
  const trajectory = path.join(dir, "agent", "trajectory.json");
  if (existsSync(trajectory)) {
    try {
      const steps = (JSON.parse(await readFile(trajectory, "utf8")) as { steps?: Step[] }).steps ?? [];
      const agent = steps.filter((s) => s.source === "agent");
      turns = agent.length;
      last = (agent.at(-1)?.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    } catch {
      // Harbor is rewriting the file; the next poll reads it.
    }
  }
  lines.push(`${name}  running ${minutes} min  agent turns ${turns}`);

  // Harbor's compose project is the lowercased trial directory name.
  const project = `${name.toLowerCase()}__env`;
  const history = await exec(`${project}_body_1`, "cat", "/var/log/minebot/programs.jsonl");
  if (history !== undefined) {
    // A flagged program is also written before it runs, with status "started"; the line after it is its result.
    const records = history.trim() ? history.trim().split("\n").map((l) => JSON.parse(l) as { seq: number; status: string; error?: string; escapeAttempts?: string[] }) : [];
    const programs = records.filter((p) => p.status !== "started");
    const flagged = new Set(records.filter((p) => (p.escapeAttempts ?? []).length > 0).map((p) => p.seq)).size;
    const failed = programs.filter((p) => p.status !== "ok");
    // Syntax errors start with a source excerpt; show the line that names the error.
    const errorLines = failed.at(-1)?.error?.split("\n") ?? [];
    const lastError = errorLines.find((l) => /\w*Error\b/.test(l)) ?? errorLines[0] ?? "";
    lines.push(`  programs ${programs.length}, not ok ${failed.length}${flagged ? `, FLAGGED ${flagged}` : ""}${lastError ? `; last error: ${lastError.slice(0, 120)}` : ""}`);
  }
  const observe = await exec(`${project}_main_1`, "minebot", "observe");
  if (observe) {
    const o = JSON.parse(observe) as {
      connected: boolean;
      position?: { x: number; y: number; z: number };
      health?: number;
      food?: number;
      inventory?: { name: string; count: number }[];
    };
    if (o.connected && o.position) {
      const inv = (o.inventory ?? []).map((i) => `${i.name} x${i.count}`).join(", ") || "empty";
      lines.push(`  player at ${Math.round(o.position.x)} ${Math.round(o.position.y)} ${Math.round(o.position.z)}, health ${o.health}, food ${o.food}; ${inv}`);
    } else {
      lines.push("  player disconnected");
    }
  }
  if (last) lines.push(`  agent: ${last}`);
  return lines;
}

async function report(job: string): Promise<void> {
  const trials = (await readdir(job, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(job, e.name));
  const sections = await Promise.all(trials.sort().map(trialLines));
  console.log(`${path.relative(process.cwd(), job)}  ${new Date().toLocaleTimeString()}`);
  for (const lines of sections) console.log(lines.join("\n"));
}

const job = jobArg ? path.resolve(jobArg) : await latestJob();
await report(job);
while (follow) {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  console.log();
  await report(job);
}
