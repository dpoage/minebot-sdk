import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MilestoneSpec } from "../bench/verify/milestones.ts";

const BENCH = path.join(import.meta.dirname, "..", "bench");
const TASKS = path.join(BENCH, "tasks");
const NEW_FAMILIES = ["iron-tools", "survive-nights", "stock-chest", "two-sessions"];
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
});
