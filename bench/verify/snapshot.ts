// Takes the grading snapshot of a trial: `node /opt/minebot/bench/verify/snapshot.ts <player>`.
// Harbor runs it in the grader sidecar's container (bench/gen-tasks.ts) after each agent session ends (a task with several steps
// has one session per step). It makes the server save its world over RCON, then writes two files to /var/log/grading, where
// Harbor collects them for the verifier:
//   stats.json  the player's statistics file
//   world.json  the overworld clock, the player's position, and the containers in the saved chunks (see checks.ts),
//               with the world.json of the step before as `previous` when the grader kept it
// Only the grader holds RCON and the world volume: the agent's container, and the body, never see them.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorldFacts } from "./checks.ts";
import { offlineUuid } from "./milestones.ts";
import { Rcon } from "./rcon.ts";
import { readContainers } from "./world.ts";

const player = process.argv[2];
if (!player) throw new Error("usage: snapshot.ts <player>");
const env = {
  rconHost: process.env.RCON_HOST ?? "minecraft",
  rconPort: Number(process.env.RCON_PORT ?? 25575),
  rconPassword: process.env.RCON_PASSWORD ?? "",
  worldDir: process.env.WORLD_DIR ?? "/srv/minecraft-world",
  // `minX,minZ,maxX,maxZ`: keep only the containers inside this box. A benchmark world is fresh, so it needs none; a development world
  // that other players have used holds containers of its own, and a box around the oracle's area keeps them out of the grade.
  area: process.env.CONTAINER_AREA,
  outDir: process.env.GRADING_DIR ?? "/var/log/grading",
};

/** Ticks of the overworld clock, from `Clock minecraft:overworld is at 25465 tick(s)`. */
function parseClock(reply: string): number {
  const match = /is at (\d+) tick/.exec(reply);
  if (!match) throw new Error(`cannot read the clock from "${reply}"`);
  return Number(match[1]);
}

/** The position in `<player> has the following entity data: [12028.05d, 100.0d, -7.03d]`, or null when the player is not online. */
function parsePosition(reply: string): WorldFacts["player"] {
  const match = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(reply);
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
}

// Statistics and chunks reach disk on save or logout; flush them so the files reflect the end of the run.
const rcon = await Rcon.connect(env.rconHost, env.rconPort, env.rconPassword);
let clock: number;
let position: WorldFacts["player"];
try {
  await rcon.command("save-all flush");
  clock = parseClock(await rcon.command("time query time"));
  position = parsePosition(await rcon.command(`data get entity ${player} Pos`));
} finally {
  rcon.close();
}

await mkdir(env.outDir, { recursive: true });
const stats = path.join(env.outDir, "stats.json");
try {
  await copyFile(path.join(env.worldDir, "players", "stats", `${offlineUuid(player)}.json`), stats);
} catch (err) {
  // No stats file means the player never joined.
  if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  await writeFile(stats, `${JSON.stringify({ stats: {} })}\n`);
}
console.log(`wrote ${stats}`);

const [minX = -Infinity, minZ = -Infinity, maxX = Infinity, maxZ = Infinity] = env.area?.split(",").map(Number) ?? [];
const containers = (await readContainers(env.worldDir)).filter(({ position: [x, , z] }) => x >= minX && x <= maxX && z >= minZ && z <= maxZ);
// The grader keeps /var/log/grading between the steps of a task, so the file of the step before is still there; the agent cannot reach it.
const worldFile = path.join(env.outDir, "world.json");
const before = await readFile(worldFile, "utf8").then(
  (text) => WorldFacts.parse(JSON.parse(text)),
  (err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  },
);
const previous = before && { clock: before.clock, player: before.player, containers: before.containers };
const world: WorldFacts = { clock, player: position, containers, previous };
await writeFile(worldFile, `${JSON.stringify(world)}\n`);
console.log(`wrote ${worldFile}: clock ${clock}, ${world.containers.length} containers${before ? ", with the snapshot before it" : ""}`);
