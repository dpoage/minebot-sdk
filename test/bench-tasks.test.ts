import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { MilestoneSpec, offlineUuid } from "../bench/verify/milestones.ts";

const BENCH = path.join(import.meta.dirname, "..", "bench");
const TASKS = path.join(BENCH, "tasks");
const NEW_FAMILIES = ["iron-tools", "diamond-night", "survive-nights", "stock-chest", "two-sessions"];
const TIERS = ["raw", "kits", "wiki", "full"];

const read = (...parts: string[]) => readFile(path.join(TASKS, ...parts), "utf8");

describe("generated tasks", () => {
  it("has every family in every tier", async () => {
    const dirs = await readdir(TASKS);
    for (const family of NEW_FAMILIES) for (const tier of TIERS) assert.ok(dirs.includes(`${family}-${tier}`), `${family}-${tier} is missing`);
  });

  it("starts the body without triggers, except where reflexes are the task", async () => {
    for (const tier of TIERS) {
      assert.doesNotMatch(await read(`survive-nights-${tier}`, "environment", "docker-compose.yaml"), /--no-triggers/);
      assert.match(await read(`survive-nights-${tier}`, "instruction.md"), /## Triggers/);
      assert.match(await read(`survive-nights-${tier}`, "task.toml"), /triggers = true/);
      for (const family of ["iron-tools", "stock-chest", "two-sessions", "craft-stone-pickaxe"]) {
        assert.match(await read(`${family}-${tier}`, "environment", "docker-compose.yaml"), /--no-triggers/);
      }
    }
    for (const step of ["stash", "retrieve"]) assert.doesNotMatch(await read("two-sessions-raw", "steps", step, "instruction.md"), /## Triggers/);
  });

  it("offers the kits a task needs in the kits tiers only", async () => {
    const offer = async (task: string) => /--kits=([^\n]*)/.exec(await read(task, "environment", "docker-compose.yaml"))![1];
    assert.equal(await offer("survive-nights-raw"), "");
    assert.equal(await offer("survive-nights-wiki"), "");
    for (const tier of ["kits", "full"]) {
      assert.match((await offer(`survive-nights-${tier}`))!, /survival,combat$/);
      assert.match((await offer(`stock-chest-${tier}`))!, /container$/);
      assert.doesNotMatch((await offer(`iron-tools-${tier}`))!, /container|survival|combat/);
      // The instruction names the primitives that the routine kits use, and the kits that the task adds.
      const instruction = await read(`survive-nights-${tier}`, "instruction.md");
      assert.match(instruction, /primitive kits move, sense, dig, place, inventory, craft, items, furnace, survival, combat and the routine kits gatherer, crafter, builder, explorer, social/);
    }
    // A tier without kits says nothing about them.
    assert.doesNotMatch(await read("stock-chest-raw", "instruction.md"), /\bkit\b|container/i);
  });

  it("makes two-sessions a multi-step task with a verifier and a solution for each step", async () => {
    const toml = await read("two-sessions-kits", "task.toml");
    assert.match(toml, /\[\[steps\]\]\nname = "stash"/);
    assert.match(toml, /\[\[steps\]\]\nname = "retrieve"/);
    assert.match(toml, /multi_step_reward_strategy = "final"/);
    const dirs = await readdir(path.join(TASKS, "two-sessions-kits"));
    assert.deepEqual(dirs.sort(), ["environment", "steps", "task.toml"]);
    for (const step of ["stash", "retrieve"]) {
      const files = await readdir(path.join(TASKS, "two-sessions-kits", "steps", step));
      assert.deepEqual(files.sort(), ["instruction.md", "solution", "tests"]);
      MilestoneSpec.parse(JSON.parse(await read("two-sessions-kits", "steps", step, "tests", "milestones.json")));
    }
    // A failed first step stops the trial, and the second step grades against the chest the first one filled.
    assert.match(toml, /name = "stash"\nmin_reward = 1\.0/);
    assert.doesNotMatch(toml, /name = "retrieve"\nmin_reward/);
    const retrieve = MilestoneSpec.parse(JSON.parse(await read("two-sessions-kits", "steps", "retrieve", "tests", "milestones.json")));
    assert.deepEqual(retrieve.checks.map((c) => c.type), ["withdrawn"]);
    // The chest is left outside the chunks that the body loads around the player (view distance 8: under 144 blocks).
    const stash = MilestoneSpec.parse(JSON.parse(await read("two-sessions-kits", "steps", "stash", "tests", "milestones.json")));
    const far = stash.checks.find((c) => c.type === "distance");
    assert.ok(far?.type === "distance" && far.min >= 144 + 32, "the stash must be beyond the loaded chunks");
    // The second session is told about the first only in words; both are told about the notes.
    for (const step of ["stash", "retrieve"]) assert.match(await read("two-sessions-raw", "steps", step, "instruction.md"), /minebot notes/);
  });

  it("runs a program that the oracle knows in every solution", async () => {
    const oracle = await readFile(path.join(BENCH, "oracle", "progression.js"), "utf8");
    const solutions = (await readdir(TASKS, { recursive: true })).filter((file) => file.endsWith(`solution${path.sep}solve.sh`));
    assert.ok(solutions.length >= TIERS.length * 8, `only ${solutions.length} solutions`);
    for (const file of solutions) {
      const target = /const TARGET = "(\w+)"/.exec(await read(file))![1]!;
      // The three early targets are the default branch of the dispatch; the others are named in it.
      if (!["logs", "wooden_pickaxe", "stone_pickaxe"].includes(target)) assert.ok(oracle.includes(`TARGET === "${target}"`), `${file}: the oracle has no ${target}`);
    }
  });

  it("requires every step of the iron chain, and does not claim that the world has no iron", async () => {
    for (const tier of TIERS) {
      const spec = MilestoneSpec.parse(JSON.parse(await read(`iron-tools-${tier}`, "tests", "milestones.json")));
      assert.equal(spec.allRequired, true);
      assert.doesNotMatch(await read(`iron-tools-${tier}`, "instruction.md"), /no iron lying around/);
    }
    assert.equal(MilestoneSpec.parse(JSON.parse(await read("craft-stone-pickaxe-raw", "tests", "milestones.json"))).allRequired, false);
  });

  it("makes survive-nights wait for the nights after the oracle program", async () => {
    const solve = await read("survive-nights-raw", "solution", "solve.sh");
    assert.match(solve, /minebot wait --types day/);
    assert.match(solve, /-lt 2 \]/);
  });

  it("makes diamond-night require the whole chain, the first dawn, and no death, with reflexes on", async () => {
    for (const tier of TIERS) {
      const spec = MilestoneSpec.parse(JSON.parse(await read(`diamond-night-${tier}`, "tests", "milestones.json")));
      assert.equal(spec.allRequired, true);
      const ids = spec.milestones.map((m) => m.id);
      assert.deepEqual(ids.slice(-4), ["iron_ingot", "iron_pickaxe", "diamond", "diamond_pickaxe"]);
      assert.deepEqual(spec.milestones.find((m) => m.id === "diamond")?.blocks, ["diamond_ore", "deepslate_diamond_ore"]);
      assert.deepEqual(spec.checks.map((c) => c.type), ["nights", "deaths"]);
      assert.doesNotMatch(await read(`diamond-night-${tier}`, "environment", "docker-compose.yaml"), /--no-triggers/);
    }
    const solve = await read("diamond-night-raw", "solution", "solve.sh");
    assert.match(solve, /const TARGET = "diamond_pickaxe"/);
    assert.match(solve, /bot\.time\.day < 1/);
  });
});

interface ComposeService {
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  network_mode?: string;
  depends_on?: Record<string, { condition?: string }>;
}

/** The tables of the form `[[name]]` in a task.toml: each one's header line and the lines up to the next table. */
function tomlTables(toml: string, name: string): string[] {
  return toml.split(/^(?=\[)/m).filter((table) => table.startsWith(`[[${name}]]`));
}

describe("the grading boundary of every generated task", () => {
  it("keeps RCON and the world out of every container but the grader", async () => {
    const dirs = await readdir(TASKS);
    assert.ok(dirs.length >= NEW_FAMILIES.length * TIERS.length);
    for (const dir of dirs) {
      const compose = parse(await read(dir, "environment", "docker-compose.yaml")) as { services: Record<string, ComposeService> };
      assert.deepEqual(Object.keys(compose.services).sort(), ["body", "grader", "main", "minecraft"], dir);
      for (const [name, service] of Object.entries(compose.services)) {
        if (name === "minecraft" || name === "grader") continue;
        assert.ok(!("RCON_PASSWORD" in (service.environment ?? {})), `${dir}: ${name} holds RCON_PASSWORD`);
        for (const volume of service.volumes ?? []) assert.notEqual(volume.split(":")[0], "world", `${dir}: ${name} mounts the world volume`);
      }
      const { grader, minecraft } = compose.services as { grader: ComposeService; minecraft: ComposeService };
      assert.equal(grader.network_mode, "service:minecraft", dir);
      assert.equal(grader.depends_on?.minecraft?.condition, "service_healthy", dir);
      assert.deepEqual(Object.keys(grader.environment ?? {}), ["RCON_PASSWORD"], dir);
      const worldMounts = (grader.volumes ?? []).filter((volume) => volume.split(":")[0] === "world");
      assert.ok(worldMounts.length > 0 && worldMounts.every((volume) => volume.endsWith(":ro")), `${dir}: the grader's world mount is not read-only`);
      assert.equal(minecraft.environment?.RCON_LOOPBACK_ONLY, "true", dir);
    }
  });

  it("lets only the body's player in", async () => {
    for (const dir of await readdir(TASKS)) {
      const compose = parse(await read(dir, "environment", "docker-compose.yaml")) as { services: Record<string, ComposeService> };
      const bots = (compose.services.body!.command ?? []).filter((arg) => arg.startsWith("--bot=")).map((arg) => arg.slice("--bot=".length));
      assert.equal(bots.length, 1, dir);
      const bot = bots[0]!;
      assert.deepEqual(JSON.parse(compose.services.minecraft!.environment!.WHITELIST!), [{ uuid: offlineUuid(bot), name: bot }], dir);
      // The grader snapshots, and the verifier grades, the same player.
      const toml = await read(dir, "task.toml");
      for (const table of tomlTables(toml, "verifier.collect")) assert.match(table, new RegExp(`snapshot\\.ts ${bot}"`), dir);
      const specs = (await readdir(path.join(TASKS, dir), { recursive: true })).filter((file) => file.endsWith(`${path.sep}milestones.json`));
      assert.ok(specs.length > 0, dir);
      for (const spec of specs) assert.equal(MilestoneSpec.parse(JSON.parse(await read(dir, spec))).player, bot, `${dir}/${spec}`);
    }
  });

  it("collects the snapshot and the grading artifact from the grader, and the history from the body", async () => {
    for (const dir of await readdir(TASKS)) {
      const toml = await read(dir, "task.toml");
      const hooks = tomlTables(toml, "verifier.collect");
      assert.ok(hooks.length > 0, `${dir} has no collect hook`);
      for (const hook of hooks) assert.match(hook, /^service = "grader"$/m, dir);
      assert.match(toml, /source = "\/var\/log\/grading", destination = "grading", service = "grader"/, dir);
      assert.match(toml, /source = "\/var\/log\/minebot", destination = "minebot", service = "body"/, dir);
    }
  });
});
