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
    assert.deepEqual(retrieve.checks.map((c) => c.type), ["withdrawn", "distance"]);
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
  /** A map, or a list of `KEY=value` (a bare `KEY` passes the host's value through). */
  environment?: Record<string, string> | string[];
  /** Short syntax `source:target[:mode]`, or long syntax. */
  volumes?: (string | { source?: string; read_only?: boolean })[];
  network_mode?: string;
  depends_on?: Record<string, { condition?: string }>;
}

interface Compose {
  services: Record<string, ComposeService>;
}

const readCompose = async (dir: string) => parse(await read(dir, "environment", "docker-compose.yaml")) as Compose;

/** A service's environment in either compose syntax, as a map. */
function environment(service: ComposeService): Record<string, string | undefined> {
  const env = service.environment ?? {};
  if (!Array.isArray(env)) return env;
  return Object.fromEntries(env.map((entry) => (entry.includes("=") ? [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] : [entry, undefined])));
}

/** For each mount of the `world` volume in a service, in either compose syntax: whether it is read-only. */
function worldMounts(service: ComposeService): boolean[] {
  return (service.volumes ?? []).flatMap((volume) => {
    if (typeof volume !== "string") return volume.source === "world" ? [volume.read_only === true] : [];
    const [source, , mode = ""] = volume.split(":");
    return source === "world" ? [mode.split(",").includes("ro")] : [];
  });
}

/** The names of the services for which `test` holds, sorted. */
function servicesWhere(compose: Compose, test: (service: ComposeService) => boolean): string[] {
  return Object.entries(compose.services)
    .filter(([, service]) => test(service))
    .map(([name]) => name)
    .sort();
}

/** The body's `--bot=` value: the one player that the server lets in and that the grader snapshots. */
function bodyPlayer(compose: Compose, dir: string): string {
  const bots = (compose.services.body!.command ?? []).filter((arg) => arg.startsWith("--bot=")).map((arg) => arg.slice("--bot=".length));
  assert.equal(bots.length, 1, dir);
  return bots[0]!;
}

/**
 * Reads the TOML that gen-tasks.ts writes: comments, `[table]` and `[[array.of.tables]]` headers, dotted keys, and strings, numbers,
 * booleans, arrays and inline tables as values. It throws on anything else (multi-line strings, dates, a key set twice), so a task.toml
 * that it cannot read fails the test instead of hiding an entry from it.
 */
function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const tableArrays = new WeakSet<unknown[]>();
  let at = 0;

  function fail(what: string): never {
    throw new SyntaxError(`task.toml: ${what} at ${JSON.stringify(text.slice(at, at + 40))}`);
  }
  function skip(newlines: boolean) {
    for (;;) {
      const c = text[at];
      if (c === " " || c === "\t" || (newlines && (c === "\n" || c === "\r"))) at++;
      else if (c === "#") while (at < text.length && text[at] !== "\n") at++;
      else return;
    }
  }
  function expect(token: string) {
    if (!text.startsWith(token, at)) fail(`expected ${token}`);
    at += token.length;
  }
  function match(pattern: RegExp): string | undefined {
    pattern.lastIndex = at;
    const found = pattern.exec(text)?.[0];
    if (found !== undefined) at += found.length;
    return found;
  }
  function string(): string {
    if (text.startsWith('"""', at) || text.startsWith("'''", at)) fail("a multi-line string");
    const literal = match(/'[^'\n]*'/y);
    if (literal !== undefined) return literal.slice(1, -1);
    return JSON.parse(match(/"(?:[^"\\\n]|\\.)*"/y) ?? fail("expected a string")) as string;
  }
  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      skip(false);
      parts.push(match(/[A-Za-z0-9_-]+/y) ?? string());
      skip(false);
      if (text[at] !== ".") return parts;
      at++;
    }
  }
  /** The table `name` under `parent` (the last one, if `name` is an array of tables), created if absent. */
  function descend(parent: Record<string, unknown>, name: string): Record<string, unknown> {
    const node = (parent[name] ??= {});
    const table = Array.isArray(node) && tableArrays.has(node) ? node.at(-1) : node;
    if (table === null || typeof table !== "object" || Array.isArray(table)) fail(`${name} is not a table`);
    return table as Record<string, unknown>;
  }
  function assign(table: Record<string, unknown>, path: string[], value: unknown) {
    const parent = path.slice(0, -1).reduce(descend, table);
    const name = path.at(-1)!;
    if (Object.hasOwn(parent, name)) fail(`${path.join(".")} is set twice`);
    parent[name] = value;
  }
  function value(): unknown {
    if (text[at] === '"' || text[at] === "'") return string();
    if (text[at] === "[") {
      at++;
      const items: unknown[] = [];
      for (;;) {
        skip(true);
        if (text[at] === "]") break;
        items.push(value());
        skip(true);
        if (text[at] !== ",") break;
        at++;
      }
      expect("]");
      return items;
    }
    if (text[at] === "{") {
      at++;
      const table: Record<string, unknown> = {};
      skip(false);
      while (text[at] !== "}") {
        const path = key();
        expect("=");
        skip(false);
        assign(table, path, value());
        skip(false);
        if (text[at] !== ",") break;
        at++;
      }
      expect("}");
      return table;
    }
    const scalar = match(/true|false|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y) ?? fail("expected a value");
    return scalar === "true" ? true : scalar === "false" ? false : Number(scalar.replaceAll("_", ""));
  }

  let table = root;
  for (;;) {
    skip(true);
    if (at >= text.length) return root;
    if (text.startsWith("[[", at)) {
      at += 2;
      const path = key();
      expect("]]");
      const parent = path.slice(0, -1).reduce(descend, root);
      const name = path.at(-1)!;
      if (!Object.hasOwn(parent, name)) {
        const fresh: unknown[] = [];
        tableArrays.add(fresh);
        parent[name] = fresh;
      }
      const list = parent[name];
      if (!Array.isArray(list) || !tableArrays.has(list)) fail(`${path.join(".")} is not an array of tables`);
      table = {};
      list.push(table);
    } else if (text[at] === "[") {
      at++;
      const path = key();
      expect("]");
      table = path.reduce(descend, root);
    } else {
      const path = key();
      expect("=");
      skip(false);
      assign(table, path, value());
    }
    skip(false);
    if (at < text.length && text[at] !== "\n" && text[at] !== "\r") fail("expected the end of the line");
  }
}

/** Every value of a key called `name`, at any depth of a parsed TOML document; an array's items count one by one. */
function valuesNamed(node: unknown, name: string): unknown[] {
  if (Array.isArray(node)) return node.flatMap((item) => valuesNamed(item, name));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => (key === name ? [value].flat() : valuesNamed(value, name)));
}

describe("the grading boundary of every generated task", () => {
  it("keeps RCON and the world out of every container but the grader", async () => {
    const dirs = await readdir(TASKS);
    assert.ok(dirs.length >= NEW_FAMILIES.length * TIERS.length);
    for (const dir of dirs) {
      const compose = await readCompose(dir);
      assert.deepEqual(Object.keys(compose.services).sort(), ["body", "grader", "main", "minecraft"], dir);
      assert.deepEqual(servicesWhere(compose, (service) => Object.hasOwn(environment(service), "RCON_PASSWORD")), ["grader", "minecraft"], `${dir}: who holds RCON_PASSWORD`);
      assert.deepEqual(servicesWhere(compose, (service) => worldMounts(service).length > 0), ["grader", "minecraft"], `${dir}: who mounts the world volume`);
      assert.deepEqual(servicesWhere(compose, (service) => "network_mode" in service), ["grader"], `${dir}: who shares a network namespace`);
      assert.deepEqual(servicesWhere(compose, (service) => "volumes_from" in service), [], `${dir}: who mounts another service's volumes`);
      assert.deepEqual(servicesWhere(compose, (service) => "ports" in service), [], `${dir}: who publishes ports`);
      const { grader, minecraft } = compose.services as { grader: ComposeService; minecraft: ComposeService };
      assert.equal(grader.network_mode, "service:minecraft", dir);
      assert.equal(grader.depends_on?.minecraft?.condition, "service_healthy", dir);
      assert.deepEqual(Object.keys(environment(grader)), ["RCON_PASSWORD"], dir);
      assert.ok(worldMounts(grader).every((readOnly) => readOnly), `${dir}: the grader's world mount is not read-only`);
      assert.equal(environment(minecraft).RCON_LOOPBACK_ONLY, "true", dir);
    }
  });

  it("lets only the body's player in", async () => {
    for (const dir of await readdir(TASKS)) {
      const compose = await readCompose(dir);
      const bot = bodyPlayer(compose, dir);
      assert.deepEqual(JSON.parse(environment(compose.services.minecraft!).WHITELIST!), [{ uuid: offlineUuid(bot), name: bot }], dir);
      // The verifier grades the same player that the grader snapshots (see the next test).
      const specs = (await readdir(path.join(TASKS, dir), { recursive: true })).filter((file) => file.endsWith(`${path.sep}milestones.json`));
      assert.ok(specs.length > 0, dir);
      for (const spec of specs) assert.equal(MilestoneSpec.parse(JSON.parse(await read(dir, spec))).player, bot, `${dir}/${spec}`);
    }
  });

  it("collects the snapshot and the grading artifact from the grader only, and the history from the body, at every level of the task", async () => {
    // Harbor copies the artifacts in order: a later entry with the grader's source overwrites the grader's copy, and an earlier entry
    // with its destination makes Harbor skip the grader's. So the list holds these two entries and nothing else, at any level.
    const artifacts = [
      { source: "/var/log/minebot", destination: "minebot", service: "body" },
      { source: "/var/log/grading", destination: "grading", service: "grader" },
    ];
    for (const dir of await readdir(TASKS)) {
      const toml = parseToml(await read(dir, "task.toml"));
      assert.deepEqual(new Set(valuesNamed(toml, "artifacts")), new Set(artifacts), `${dir}: the artifacts`);
      const hooks = valuesNamed(toml, "collect").map((hook) => {
        const { service, command } = hook as Record<string, unknown>;
        return { service, command };
      });
      const command = `node /opt/minebot/bench/verify/snapshot.ts ${bodyPlayer(await readCompose(dir), dir)}`;
      assert.deepEqual(hooks, [{ service: "grader", command }], `${dir}: the collect hooks`);
    }
  });
});
