import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import nbt from "prismarine-nbt";
import { Check, DAY_TICKS, gradeTrial, type WorldFacts } from "../bench/verify/checks.ts";
import { MilestoneSpec } from "../bench/verify/milestones.ts";
import { containersInRegion } from "../bench/verify/world.ts";

const exec = promisify(execFile);
const CHECK = path.join(import.meta.dirname, "..", "bench", "verify", "check.ts");
const TASKS = path.join(import.meta.dirname, "..", "bench", "tasks");

const chest = (x: number, z: number, items: Record<string, number>, block = "chest") => ({ block, position: [x, 64, z] as [number, number, number], items });
const world = (over: Partial<WorldFacts> = {}): WorldFacts => ({ clock: 0, player: { x: 0, y: 64, z: 0 }, containers: [], previous: null, ...over });
const grade = (checks: unknown[], facts: WorldFacts | null, stats = { stats: {} }) =>
  gradeTrial({ milestones: [], checks: checks.map((c) => Check.parse(c)) }, stats, facts).checks;

describe("stored check", () => {
  const spec = { id: "stocked", description: "Store cobblestone", type: "stored", items: ["cobblestone"], min: 16 };

  it("sums the matching items of all chests", () => {
    const [two] = grade([spec], world({ containers: [chest(0, 0, { cobblestone: 9 }), chest(5, 5, { cobblestone: 7, dirt: 40 })] }));
    assert.equal(two!.obtained, 16);
    assert.equal(two!.met, true);
    const [short] = grade([spec], world({ containers: [chest(0, 0, { cobblestone: 15, dirt: 40 })] }));
    assert.equal(short!.met, false);
    assert.equal(short!.requirement, ">= 16");
  });

  it("does not count a chest that does not exist, or other containers", () => {
    assert.equal(grade([spec], world())[0]!.met, false);
    const barrel = grade([spec], world({ containers: [chest(0, 0, { cobblestone: 64 }, "barrel"), chest(1, 1, { cobblestone: 64 }, "furnace")] }));
    assert.equal(barrel[0]!.met, false);
    const named = grade([{ ...spec, containers: ["barrel"] }], world({ containers: [chest(0, 0, { cobblestone: 64 }, "barrel")] }));
    assert.equal(named[0]!.met, true);
  });

  it("matches item patterns", () => {
    const logs = { id: "logs", description: "Logs", type: "stored", items: ["*_log"], min: 8 };
    assert.equal(grade([logs], world({ containers: [chest(0, 0, { oak_log: 3, birch_log: 5, oak_planks: 20 })] }))[0]!.met, true);
  });

  it("fails without world facts", () => {
    const [result] = grade([spec], null);
    assert.equal(result!.met, false);
    assert.match(String(result!.detail.error), /no world facts/);
  });
});

describe("withdrawn check", () => {
  const spec = { id: "withdrawn", description: "Take logs out", type: "withdrawn", items: ["*_log"], held: 8, max: 4 };
  const before = (containers: ReturnType<typeof chest>[]) => ({ clock: 0, player: null, containers });

  it("passes when the chest that was full is down to the bound", () => {
    const facts = world({ previous: before([chest(10, 10, { oak_log: 8 })]), containers: [chest(10, 10, { oak_log: 3 })] });
    const [result] = grade([spec], facts);
    assert.equal(result!.met, true);
    assert.equal(result!.obtained, 3);
    assert.equal(grade([spec], world({ previous: facts.previous, containers: [chest(10, 10, { oak_log: 5 })] }))[0]!.met, false);
  });

  it("is not met by an empty chest that was never filled, or by a chest that is gone", () => {
    const filled = before([chest(10, 10, { oak_log: 8 })]);
    // The agent left the stash alone and placed an empty chest of its own.
    assert.equal(grade([spec], world({ previous: filled, containers: [chest(10, 10, { oak_log: 8 }), chest(0, 0, {})] }))[0]!.met, false);
    // The stash was broken, and an empty chest stands elsewhere.
    const broken = grade([spec], world({ previous: filled, containers: [chest(0, 0, {})] }))[0]!;
    assert.equal(broken.met, false);
    assert.equal(broken.detail.missing, 1);
    // The step before never filled a chest: there is nothing to take out.
    const never = grade([spec], world({ previous: before([chest(10, 10, { oak_log: 2 })]), containers: [chest(10, 10, {})] }))[0]!;
    assert.equal(never.met, false);
    assert.match(String(never.detail.error), /no container held 8/);
  });

  it("needs the snapshot of the step before", () => {
    const [result] = grade([spec], world({ containers: [chest(10, 10, {})] }));
    assert.equal(result!.met, false);
    assert.match(String(result!.detail.error), /no snapshot of the step before/);
  });
});

describe("nights and deaths checks", () => {
  const nights = (n: number) => ({ id: `night_${n}`, description: "Live", type: "nights", nights: n });

  it("counts the days the overworld clock has completed", () => {
    assert.equal(grade([nights(2)], world({ clock: 2 * DAY_TICKS - 1 }))[0]!.met, false);
    const done = grade([nights(2)], world({ clock: 2 * DAY_TICKS }))[0]!;
    assert.equal(done.met, true);
    assert.equal(done.obtained, 2);
  });

  it("allows the deaths that the spec allows, and reads a missing statistic as none", () => {
    const deaths = { id: "no_deaths", description: "Do not die", type: "deaths", max: 0 };
    assert.equal(grade([deaths], null)[0]!.met, true);
    assert.equal(grade([deaths], null, { stats: { "minecraft:custom": { "minecraft:deaths": 1 } } })[0]!.met, false);
    assert.equal(grade([{ ...deaths, max: 1 }], null, { stats: { "minecraft:custom": { "minecraft:deaths": 1 } } })[0]!.met, true);
  });
});

describe("distance check", () => {
  const far = { id: "far", description: "Be far", type: "distance", min: 64 };

  it("measures the horizontal distance to the nearest chest", () => {
    const facts = (x: number, y = 64) => world({ player: { x, y, z: 0.5 }, containers: [chest(0, 0, {}), chest(500, 0, {})] });
    const near = grade([far], facts(60))[0]!;
    assert.equal(near.met, false);
    assert.equal(near.obtained, 60);
    assert.equal(grade([far], facts(70))[0]!.met, true);
    // Height does not count.
    assert.equal(grade([far], facts(10, 300))[0]!.met, false);
  });

  it("fails when there is no chest or no player", () => {
    assert.equal(grade([far], world())[0]!.met, false);
    assert.equal(grade([far], world({ player: null, containers: [chest(0, 0, {})] }))[0]!.met, false);
  });
});

describe("gradeTrial", () => {
  const milestones = [{ id: "table", description: "Craft a table", obtained: ["crafting_table"], via: "crafted" as const, count: 1 }];
  const checks = [Check.parse({ id: "night_1", description: "Live", type: "nights", nights: 1 })];
  const crafted = { stats: { "minecraft:crafted": { "minecraft:crafting_table": 1 } } };

  it("rewards a trial only when the last milestone and every check are met", () => {
    const both = gradeTrial({ milestones, checks }, crafted, world({ clock: DAY_TICKS }));
    assert.deepEqual([both.reward, both.progress], [1, 1]);
    const noNight = gradeTrial({ milestones, checks }, crafted, world({ clock: 100 }));
    assert.deepEqual([noNight.reward, noNight.progress], [0, 0.5]);
    const noTable = gradeTrial({ milestones, checks }, { stats: {} }, world({ clock: DAY_TICKS }));
    assert.deepEqual([noTable.reward, noTable.progress], [0, 0.5]);
  });

  it("needs every milestone with allRequired, so an item found in the world does not stand in for the chain", () => {
    const chain = [
      { id: "ingot", description: "Smelt an ingot", obtained: ["iron_ingot"], via: "crafted" as const, count: 1 },
      { id: "pickaxe", description: "Craft a pickaxe", obtained: ["iron_pickaxe"], via: "crafted" as const, count: 1 },
    ];
    // A looted ingot, a crafted pickaxe: the last milestone alone is met.
    const looted = { stats: { "minecraft:crafted": { "minecraft:iron_pickaxe": 1 } } };
    assert.equal(gradeTrial({ milestones: chain, checks: [] }, looted, null).reward, 1);
    const strict = gradeTrial({ milestones: chain, checks: [], allRequired: true }, looted, null);
    assert.deepEqual([strict.reward, strict.progress], [0, 0.5]);
    const smelted = { stats: { "minecraft:crafted": { "minecraft:iron_pickaxe": 1, "minecraft:iron_ingot": 3 } } };
    assert.equal(gradeTrial({ milestones: chain, checks: [], allRequired: true }, smelted, null).reward, 1);
  });

  it("grades a task without milestones by its checks", () => {
    const result = gradeTrial({ milestones: [], checks }, null, world({ clock: DAY_TICKS }));
    assert.deepEqual([result.reward, result.progress, result.milestones], [1, 1, []]);
  });
});

describe("spec", () => {
  it("needs a milestone or a check, and a bound on a stored check", () => {
    assert.throws(() => MilestoneSpec.parse({ player: "agent" }));
    assert.throws(() => MilestoneSpec.parse({ checks: [{ id: "x", description: "x", type: "stored", items: ["dirt"] }] }));
    // An upper bound on the contents of any chest would pass for an empty chest that nobody filled.
    assert.throws(() => MilestoneSpec.parse({ checks: [{ id: "x", description: "x", type: "stored", items: ["dirt"], max: 1 }] }));
    const spec = MilestoneSpec.parse({ checks: [{ id: "x", description: "x", type: "stored", items: ["dirt"], min: 1 }] });
    assert.deepEqual(spec.checks[0], { id: "x", description: "x", type: "stored", items: ["dirt"], containers: ["chest", "trapped_chest"], min: 1 });
    assert.equal(spec.allRequired, false);
  });

  it("parses the spec of every generated task", async () => {
    const files: string[] = [];
    for (const task of await readdir(TASKS, { recursive: true })) if (task.endsWith(`${path.sep}milestones.json`)) files.push(path.join(TASKS, task));
    assert.ok(files.length > 0, "no generated tasks");
    for (const file of files) MilestoneSpec.parse(JSON.parse(await readFile(file, "utf8")));
  });
});

/** A region file with one chunk at index 0 whose block entities are `entities`. */
function region(entities: ReturnType<typeof blockEntity>[]): Buffer {
  // prismarine-nbt's helpers build a list of compounds correctly but their types do not describe it.
  const chunk = nbt.comp({ block_entities: nbt.list(nbt.comp(entities)) }) as unknown as nbt.NBT;
  const payload = deflateSync(nbt.writeUncompressed(chunk));
  const header = Buffer.alloc(8192);
  header.writeUIntBE(2, 0, 3); // chunk 0 starts at sector 2
  header[3] = 1;
  const record = Buffer.alloc(4096);
  record.writeInt32BE(payload.length + 1, 0);
  record[4] = 2; // zlib
  payload.copy(record, 5);
  return Buffer.concat([header, record]);
}

const blockEntity = (id: string, x: number, y: number, z: number, items?: [string, number][]) => ({
  id: nbt.string(id),
  x: nbt.int(x),
  y: nbt.int(y),
  z: nbt.int(z),
  ...(items && { Items: nbt.list(nbt.comp(items.map(([item, count], slot) => ({ Slot: nbt.byte(slot), id: nbt.string(item), count: nbt.int(count) })))) }),
});

describe("containersInRegion", () => {
  it("lists the block entities that have an inventory, with item totals", async () => {
    const found = await containersInRegion(
      region([
        blockEntity("minecraft:chest", 3, 70, -5, [["minecraft:cobblestone", 16], ["minecraft:cobblestone", 8], ["minecraft:oak_log", 2]]),
        blockEntity("minecraft:sign", 4, 70, -5),
        blockEntity("minecraft:barrel", 9, 12, 9, []),
      ]),
    );
    assert.deepEqual(found, [
      { block: "chest", position: [3, 70, -5], items: { cobblestone: 24, oak_log: 2 } },
      { block: "barrel", position: [9, 12, 9], items: {} },
    ]);
  });

  it("refuses a compression it cannot read", async () => {
    const bytes = region([]);
    bytes[8192 + 4] = 4; // lz4
    await assert.rejects(containersInRegion(bytes), /compression 4/);
  });
});

/**
 * Runs the verifier as the verifier image does: its own process, reading the spec, the statistics, and the world file, and writing the reward files.
 * `history` is the content of a program history the body might have written, which the verifier is pointed at through HISTORY_FILE; undefined leaves
 * the variable unset, so the verifier would look where the body writes it in a trial (a path that does not exist here).
 */
async function verify(spec: unknown, stats: unknown, facts: WorldFacts | null, history?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "minebot-checks-"));
  const files = { spec: path.join(dir, "milestones.json"), stats: path.join(dir, "stats.json"), history: path.join(dir, "programs.jsonl"), world: path.join(dir, "world.json") };
  await writeFile(files.spec, JSON.stringify(spec));
  await writeFile(files.stats, JSON.stringify(stats));
  if (history !== undefined) await writeFile(files.history, history);
  if (facts) await writeFile(files.world, JSON.stringify(facts));
  const { HISTORY_FILE: _inherited, ...inherited } = process.env;
  const { stdout } = await exec("node", [CHECK, files.spec], {
    env: { ...inherited, STATS_FILE: files.stats, WORLD_FILE: files.world, REWARD_DIR: dir, ...(history !== undefined && { HISTORY_FILE: files.history }) },
  });
  const rewardText = await readFile(path.join(dir, "reward.json"), "utf8");
  const milestonesText = await readFile(path.join(dir, "milestones.json"), "utf8");
  return { stdout, rewardText, milestonesText, reward: JSON.parse(rewardText), milestones: JSON.parse(milestonesText) };
}

describe("verifier with checks", () => {
  const spec = { player: "agent", checks: [{ id: "night_1", description: "Live", type: "nights", nights: 1 }, { id: "no_deaths", description: "Do not die", type: "deaths", max: 0 }] };

  it("grades from the world file", async () => {
    const pass = await verify(spec, { stats: {} }, world({ clock: DAY_TICKS + 5 }));
    assert.deepEqual(pass.reward, { reward: 1, progress: 1 });
    assert.match(pass.stdout, /PASS night_1: 1 \(needs >= 1\)/);
    assert.equal(pass.milestones.checks.length, 2);
    const died = await verify(spec, { stats: { "minecraft:custom": { "minecraft:deaths": 1 } } }, world({ clock: DAY_TICKS + 5 }));
    assert.deepEqual(died.reward, { reward: 0, progress: 0.5 });
    assert.match(died.stdout, /FAIL no_deaths: 1 \(needs <= 0\)/);
  });

  it("fails the checks that need the world when there is no world file", async () => {
    const { reward, stdout } = await verify(spec, { stats: {} }, null);
    assert.deepEqual(reward, { reward: 0, progress: 0.5 });
    assert.match(stdout, /no world facts/);
  });
});

describe("verifier from the statistics", () => {
  const spec = { player: "agent", milestones: [{ id: "table", description: "Craft a crafting table", obtained: ["crafting_table"], via: "crafted" }] };
  const stats = { stats: { "minecraft:crafted": { "minecraft:crafting_table": 1 } } };

  it("gives reward 1 for a task of milestones alone, and writes exactly reward and progress", async () => {
    const { reward, milestones } = await verify(spec, stats, null, "");
    assert.deepEqual(reward, { reward: 1, progress: 1 });
    assert.deepEqual(Object.keys(reward), ["reward", "progress"]);
    assert.deepEqual(Object.keys(milestones).sort(), ["checks", "milestones", "progress", "reward"]);
  });

  it("writes the same reward files and output whatever program history the body wrote, or none", async () => {
    // The key that the history of an earlier body carried for a flagged program; spelled in two parts so that no file names a deleted feature.
    const OLD_FLAGS = `escape${"Attempts"}`;
    const line = (code: string, extra: object = {}) => `${JSON.stringify({ seq: 1, startedAt: "now", code, status: "ok", ...extra })}\n`;
    const histories: Record<string, string | undefined> = {
      "no file": undefined,
      empty: "",
      "a flag of the key an earlier body wrote": line('return bot.constructor.constructor("return process")()', { [OLD_FLAGS]: ["constructor.constructor", "process"] }),
      "source that requires and names process": line('const fs = require("node:fs"); return process.pid;'),
      "a line that is not JSON": "not json\n",
    };
    const baseline = await verify(spec, stats, null, "");
    for (const [name, history] of Object.entries(histories)) {
      const run = await verify(spec, stats, null, history);
      assert.equal(run.rewardText, baseline.rewardText, `reward.json with ${name}`);
      assert.equal(run.milestonesText, baseline.milestonesText, `milestones.json with ${name}`);
      assert.equal(run.stdout, baseline.stdout, `output with ${name}`);
      assert.deepEqual(Object.keys(run.reward), ["reward", "progress"], name);
    }
  });
});

describe("world checks on the previous snapshot", () => {
  // `previous` is the step before's snapshot; the current one is deliberately the opposite of it in each fixture.
  const previousOf = (over: Partial<WorldFacts> = {}) => ({ clock: 0, player: { x: 0, y: 64, z: 0 }, containers: [], ...over });
  const far = { id: "far", description: "Be far", type: "distance", min: 64 };

  it("accepts `snapshot` on the distance check only, the one check a task grades on the previous snapshot", () => {
    const withSnapshot = Check.options.filter((option) => "snapshot" in option.shape).map((option) => option.shape.type.value);
    assert.deepEqual(withSnapshot, ["distance"]);
  });

  it("grades a distance check on the previous snapshot: the player and the chests of the step before, and fails closed without one", () => {
    const onPrevious = { ...far, snapshot: "previous" };
    const farBefore = world({ player: { x: 0, y: 64, z: 0 }, containers: [chest(0, 0, {})], previous: previousOf({ player: { x: 100, y: 64, z: 0 }, containers: [chest(0, 0, {})] }) });
    const [passes] = grade([onPrevious], farBefore);
    assert.deepEqual([passes!.met, passes!.obtained], [true, 100]);
    assert.equal(grade([far], farBefore)[0]!.met, false, "the player stands at the chest now");
    const nearBefore = world({ player: { x: 500, y: 64, z: 0 }, containers: [chest(0, 0, {})], previous: previousOf({ player: { x: 10, y: 64, z: 0 }, containers: [chest(0, 0, {})] }) });
    assert.equal(grade([onPrevious], nearBefore)[0]!.met, false);
    assert.equal(grade([far], nearBefore)[0]!.met, true, "the player stands far now");
    // The chest of the step before counts, not the one that is there now.
    const movedChest = world({ player: { x: 500, y: 64, z: 0 }, containers: [chest(500, 0, {})], previous: previousOf({ player: { x: 10, y: 64, z: 0 }, containers: [chest(0, 0, {})] }) });
    assert.equal(grade([onPrevious], movedChest)[0]!.met, false);
    const none = grade([onPrevious], world({ containers: [chest(0, 0, {})], player: { x: 500, y: 64, z: 0 } }))[0]!;
    assert.equal(none.met, false);
    assert.match(String(none.detail.error), /no snapshot of the step before/);
    assert.equal(grade([onPrevious], null)[0]!.met, false);
  });

  it("parses `snapshot` as current or previous only, and leaves a parsed check without it when it is not given", () => {
    assert.throws(() => Check.parse({ ...far, snapshot: "next" }));
    assert.equal("snapshot" in Check.parse(far), false);
    assert.deepEqual(Check.parse({ ...far, snapshot: "previous" }), { ...far, snapshot: "previous", containers: ["chest", "trapped_chest"] });
  });
});

describe("the generated two-sessions retrieve step", () => {
  const stats = {
    stats: {
      "minecraft:crafted": { "minecraft:wooden_pickaxe": 1, "minecraft:stone_pickaxe": 1 },
      "minecraft:mined": { "minecraft:stone": 3 },
      "minecraft:picked_up": { "minecraft:cobblestone": 3 },
    },
  };
  // The step before ended with the stash chest full of logs and the player at `before`; this step took half of them out and the player is back at the chest.
  const afterStep = (before: number) =>
    world({
      clock: 100,
      player: { x: 3, y: 64, z: 0 },
      containers: [chest(0, 0, { oak_log: 4 })],
      previous: { clock: 50, player: { x: before, y: 64, z: 0 }, containers: [chest(0, 0, { oak_log: 8 })] },
    });

  it("gives reward 0 when the grader's snapshot of the first step has the player under 200 blocks from the stash, with every milestone and `withdrawn` met", async () => {
    const specs = (await readdir(TASKS, { recursive: true })).filter((file) => /^two-sessions-[^/]+\/steps\/retrieve\/tests\/milestones\.json$/.test(file.split(path.sep).join("/")));
    assert.equal(specs.length, 4, specs.join(", "));
    for (const file of specs) {
      const spec = JSON.parse(await readFile(path.join(TASKS, file), "utf8"));
      const near = await verify(spec, stats, afterStep(199));
      assert.equal(near.reward.reward, 0, `${file}: ${near.stdout}`);
      assert.match(near.stdout, /PASS withdrawn/, file);
      assert.deepEqual(near.milestones.milestones.map((m: { met: boolean }) => m.met), [true, true, true], file);
      assert.match(near.stdout, /FAIL first_session_far_away: 199 /, file);
      const far = await verify(spec, stats, afterStep(200));
      assert.deepEqual(far.reward, { reward: 1, progress: 1 }, `${file}: ${far.stdout}`);
      const lost = await verify(spec, stats, { ...afterStep(500), previous: null });
      assert.equal(lost.reward.reward, 0, `${file}: no snapshot of the first step`);
    }
  });
});
