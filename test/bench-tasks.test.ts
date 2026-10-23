import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { BODY_FLAG_OPTIONS, builtinOffer, parseBodyFlags } from "../src/client/body-flags.ts";
import { usageFor } from "../src/client/usage.ts";
import { Builtins } from "../src/host/routines/builtins.ts";
import { KitStats } from "../src/host/routines/stats.ts";
import { MC_VERSION } from "../src/mc/version.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";
import { JsonStore } from "../src/store.ts";
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
      assert.doesNotMatch(await read(`diamond-night-${tier}`, "environment", "docker-compose.yaml"), /--no-reflexes|--no-routines/);
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

/** The tier table of bench/README.md: the built-in modules that the kits and full tiers name, and the ones a task adds. */
const KITS_TIER = ["gatherer", "crafter", "builder", "explorer", "social"];
const TASK_EXTRAS: Record<string, string[]> = {
  "diamond-night": ["survival", "combat"],
  "survive-nights": ["survival", "combat"],
  "stock-chest": ["container"],
  "two-sessions": ["container"],
};

/** The built-in modules that `names` list and everything they use, in catalog order. Computed here, not by the generator. */
function closure(names: readonly string[]): string[] {
  const wanted = new Set<string>();
  const visit = (name: string): void => {
    if (wanted.has(name)) return;
    const module = BUILTIN_MODULES.find((candidate) => candidate.name === name);
    assert.ok(module, `unknown built-in module ${name}`);
    wanted.add(name);
    module.uses.forEach(visit);
  };
  names.forEach(visit);
  return BUILTIN_MODULES.map((module) => module.name).filter((name) => wanted.has(name));
}

/** Compose reads `$$` in a value as a literal `$`: the command that the container runs. */
const interpolated = (value: string) => value.replaceAll("$$", "$");

interface TaskRow {
  dir: string;
  task: string;
  tier: string;
  /** The container's command. */
  command: string[];
  /** The body's arguments: the command after `body`. */
  argv: string[];
}

async function taskRows(): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  for (const dir of await readdir(TASKS)) {
    const command = ((await readCompose(dir)).services.body!.command ?? []).map(interpolated);
    rows.push({ dir, task: dir.slice(0, dir.lastIndexOf("-")), tier: dir.slice(dir.lastIndexOf("-") + 1), command, argv: command.slice(command.indexOf("body") + 1) });
  }
  return rows;
}

/** The tier's row: what the body of this task and tier offers. */
function tierRow(row: TaskRow): { names: string[]; wiki: "off" | "read" } {
  const withBuiltins = row.tier === "kits" || row.tier === "full";
  return { names: withBuiltins ? [...KITS_TIER, ...(TASK_EXTRAS[row.task] ?? [])] : [], wiki: row.tier === "wiki" || row.tier === "full" ? "read" : "off" };
}

describe("the body of every generated task", () => {
  it("starts with the flags of its tier row, which the body's own parser accepts", async () => {
    const rows = await taskRows();
    assert.equal(rows.length, 8 * TIERS.length);
    for (const row of rows) {
      const { names, wiki } = tierRow(row);
      assert.deepEqual(
        row.argv,
        ["--bot=agent", "--host=minecraft", "--api-host=0.0.0.0", "--api-port=7070", "--history=/var/log/minebot/programs.jsonl", `--builtins=${names.length > 0 ? names.join(",") : "none"}`, `--wiki=${wiki}`, "--no-milestones"],
        row.dir,
      );
      // The same argv through the parser of `minebot body`: routines and reflexes are on (neither is turned off), milestones are off.
      const { values } = parseArgs({ args: row.argv, options: { bot: { type: "string" }, ...BODY_FLAG_OPTIONS } });
      const flags = parseBodyFlags(values.bot!, values);
      assert.deepEqual([flags.noRoutines, flags.noReflexes, flags.noMilestones, flags.wiki, flags.routines], [false, false, true, wiki, undefined], row.dir);
      assert.deepEqual(builtinOffer(flags.builtins), names, row.dir);
    }
  });

  it("lists in task.toml the built-ins that the flags offer, the closure over what each module uses, and the wiki", async () => {
    for (const row of await taskRows()) {
      const { names, wiki } = tierRow(row);
      const toml = parseToml(await read(row.dir, "task.toml"));
      const metadata = toml.metadata as Record<string, unknown>;
      assert.deepEqual(metadata.builtins, closure(names), row.dir);
      assert.equal(metadata.wiki, wiki, row.dir);
      assert.deepEqual(Object.keys(metadata).sort(), ["builtins", "category", "difficulty_explanation", "goals", "tier", "wiki"], `${row.dir}: the metadata keys`);
    }
    // A kits body offers every module that a named module uses: gatherer alone brings its primitives.
    assert.deepEqual(closure(["gatherer"]), ["move", "sense", "dig", "inventory", "items", "gatherer"]);
  });

  it("lists in task.toml exactly the built-ins that the body's own service offers for its --builtins flag", async () => {
    for (const row of await taskRows()) {
      // The body's path from its arguments to its offer: the flag parser of `minebot body`, then the host's built-in service.
      const { values } = parseArgs({ args: row.argv, options: { bot: { type: "string" }, ...BODY_FLAG_OPTIONS } });
      const offer = builtinOffer(parseBodyFlags(values.bot!, values).builtins);
      const offered = new Builtins({ offer, stats: new KitStats(JsonStore.memory()) }).offered;
      const metadata = parseToml(await read(row.dir, "task.toml")).metadata as Record<string, unknown>;
      assert.deepEqual(metadata.builtins, offered, row.dir);
    }
  });

  it("runs the body behind the removal step that must succeed before the body starts", async () => {
    const script = 'node --conditions=minebot-sdk:source /opt/minebot/bench/tier/remove.ts "$@" && exec minebot "$@"';
    for (const row of await taskRows()) {
      assert.deepEqual(row.command.slice(0, 5), ["sh", "-c", script, "tier", "body"], row.dir);
      // The compose file writes each "$@" as "$$@", so that compose does not interpolate it.
      assert.equal((await read(row.dir, "environment", "docker-compose.yaml")).split("$$@").length - 1, 2, row.dir);
    }
  });
});

/** The features of a generated task's body, as the flags give them. */
function featuresOf(row: TaskRow): BodyFeatures {
  const { names, wiki } = tierRow(row);
  return { wiki, lessons: false, milestones: false, reflexes: true, routines: true, builtins: closure(names) };
}

/** The built-in modules that an instruction names: by import path, by call name, or in a list of modules. */
function namedModules(text: string): string[] {
  const named = new Set<string>();
  for (const module of BUILTIN_MODULES) {
    if (new RegExp(`minebot-sdk/routines/${module.name}\\b`).test(text)) named.add(module.name);
    for (const routine of Object.keys(module.routines)) if (new RegExp(`(?<![\\w.])${module.name}\\.${routine}\\b`).test(text)) named.add(module.name);
  }
  const names = BUILTIN_MODULES.map((module) => module.name).join("|");
  for (const list of text.matchAll(new RegExp(`\\b(?:${names})(?:(?:, | and |, and )(?:${names}))+\\b`, "g"))) for (const word of list[0].match(/[a-z]+/g)!) if (names.split("|").includes(word)) named.add(word);
  return [...named].sort();
}

describe("the instruction of every generated task", () => {
  const instructions = async (row: TaskRow) =>
    Promise.all((await readdir(path.join(TASKS, row.dir), { recursive: true })).filter((file) => file.endsWith("instruction.md")).map(async (file) => ({ file: `${row.dir}/${file}`, text: await read(row.dir, file) })));

  it("names only built-in modules that the body offers, and none in a tier that offers none", async () => {
    for (const row of await taskRows()) {
      const features = featuresOf(row);
      for (const { file, text } of await instructions(row)) {
        for (const module of namedModules(text)) assert.ok(features.builtins.includes(module), `${file} names the module ${module}, which its body does not offer`);
      }
    }
  });

  it("describes a capability when the body offers it, and only then", async () => {
    const tokens = {
      builtins: ["minebot builtins", "minebot-sdk/routines/", "minebot call <module>.<routine>"],
      wiki: ["minebot wiki", "ctx.wiki"],
      routines: ["minebot routines", "bind action"],
      reflexes: ["bind reflex"],
    };
    for (const row of await taskRows()) {
      const features = featuresOf(row);
      const on = { builtins: features.builtins.length > 0, wiki: features.wiki !== "off", routines: features.routines, reflexes: features.reflexes };
      for (const { file, text } of await instructions(row)) {
        for (const [capability, list] of Object.entries(tokens)) {
          for (const token of list) assert.equal(text.includes(token), on[capability as keyof typeof on], `${file}: "${token}" with ${capability} ${on[capability as keyof typeof on] ? "on" : "off"}`);
        }
      }
    }
  });

  it("names only commands that the usage text of its body lists", async () => {
    for (const row of await taskRows()) {
      const usage = usageFor(featuresOf(row), true);
      const commands = new Set([...usage.split("Commands:\n")[1]!.split("\nOptions:")[0]!.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1]));
      for (const { file, text } of await instructions(row)) {
        for (const [, command, sub] of text.matchAll(/\bminebot ([a-z]+)(?: ([a-z]+)(?=[\s`'.,;:)]|$))?/g)) {
          if (command === "command") continue; // "The `minebot` command in this terminal"
          assert.ok(commands.has(command!), `${file}: \`minebot ${command}\` is not a command of this body`);
          if (sub && ["routines", "bind", "builtins", "wiki", "notes"].includes(command!)) assert.match(usage, new RegExp(`\\b${command} ${sub}\\b`), `${file}: \`minebot ${command} ${sub}\``);
        }
      }
    }
  });

  it("holds modules that parse once their types are stripped", async () => {
    let blocks = 0;
    for (const row of await taskRows()) {
      for (const { file, text } of await instructions(row)) {
        for (const [, code] of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
          blocks++;
          assert.doesNotThrow(() => stripTypeScriptTypes(code!), `${file}`);
          assert.match(code!, /export default/, `${file}: a run is a module with a default export`);
        }
      }
    }
    assert.ok(blocks >= TIERS.length * 8 * 3, `only ${blocks} module examples`);
  });

  it("says nothing of an audit or a disqualification, here or in the generator", async () => {
    for (const row of await taskRows()) for (const { file, text } of await instructions(row)) assert.doesNotMatch(text, /audit|disqualif/i, file);
    assert.doesNotMatch(await readFile(path.join(BENCH, "gen-tasks.ts"), "utf8"), /audit|disqualif/i);
  });
});

describe("the compose file of every generated task", () => {
  /** The one compose document that the generator may write, except the body's command (its own test). */
  const expectedCompose = (command: string[]) => ({
    services: {
      main: { depends_on: { body: { condition: "service_healthy" } }, networks: ["agent", "api"] },
      minecraft: {
        image: `minebot.local/minebot-server:${MC_VERSION}`,
        pull_policy: "never",
        environment: {
          EULA: "true",
          RCON_PASSWORD: "minebot-bench",
          LEVEL_SEED: "-1395321890861809374",
          DIFFICULTY: "easy",
          RESTRICT_TO_OWN_SUBNET: "true",
          RCON_LOOPBACK_ONLY: "true",
          WHITELIST: JSON.stringify([{ uuid: offlineUuid("agent"), name: "agent" }]),
        },
        cap_add: ["NET_ADMIN"],
        volumes: ["world:/opt/minecraft/world"],
        networks: ["game"],
        healthcheck: {
          test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/25575 && grep -qx white-list=true /opt/minecraft/server.properties && nft list table inet rcon_guard | grep -q 'tcp dport 25575 drop'"],
          interval: "2s",
          timeout: "2s",
          retries: 90,
          start_period: "5s",
        },
      },
      body: {
        image: "minebot.local/minebot:dev",
        pull_policy: "never",
        command,
        environment: { MINEBOT_TOKEN: "minebot-bench-body" },
        networks: ["api", "game"],
        depends_on: { minecraft: { condition: "service_healthy" } },
        healthcheck: {
          test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7070/health').then(r => r.json()).then(h => process.exit(h.connected ? 0 : 1), () => process.exit(1))"],
          interval: "2s",
          timeout: "5s",
          retries: 90,
          start_period: "5s",
        },
      },
      grader: {
        image: "minebot.local/minebot:dev",
        pull_policy: "never",
        network_mode: "service:minecraft",
        command: ["node", "-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1 << 30)"],
        environment: { RCON_PASSWORD: "minebot-bench" },
        volumes: ["world:/srv/minecraft-world:ro"],
        depends_on: { minecraft: { condition: "service_healthy" } },
      },
    },
    networks: { agent: null, api: { internal: true }, game: { internal: true } },
    volumes: { world: null },
  });

  it("has exactly the keys and values of the allowlist, in the file and in each service", async () => {
    const dirs = await readdir(TASKS);
    assert.ok(dirs.length >= NEW_FAMILIES.length * TIERS.length);
    for (const dir of dirs) {
      const compose = (await readCompose(dir)) as unknown as { services: Record<string, ComposeService & Record<string, unknown>>; networks: Record<string, { internal?: boolean } | null> };
      const allowed: Record<string, string[]> = {
        main: ["depends_on", "networks"],
        minecraft: ["cap_add", "environment", "healthcheck", "image", "networks", "pull_policy", "volumes"],
        body: ["command", "depends_on", "environment", "healthcheck", "image", "networks", "pull_policy"],
        grader: ["command", "depends_on", "environment", "image", "network_mode", "pull_policy", "volumes"],
      };
      assert.deepEqual(Object.keys(compose).sort(), ["networks", "services", "volumes"], `${dir}: the top-level keys`);
      assert.deepEqual(Object.keys(compose.services).sort(), Object.keys(allowed).sort(), `${dir}: the services`);
      for (const [name, keys] of Object.entries(allowed)) assert.deepEqual(Object.keys(compose.services[name]!).sort(), keys, `${dir}: the keys of ${name}`);
      // The properties that the isolation rests on, by name.
      assert.deepEqual(compose.services.main!.networks, ["agent", "api"], `${dir}: main is on the agent and api networks only`);
      assert.deepEqual(compose.services.body!.networks, ["api", "game"], `${dir}: body is on the api and game networks only`);
      for (const network of compose.services.body!.networks as string[]) assert.equal(compose.networks[network]?.internal, true, `${dir}: the body's network ${network} is internal`);
      assert.equal(compose.networks.game?.internal, true, `${dir}: the game network is internal`);
      assert.ok(!compose.networks.agent?.internal, `${dir}: the agent network is not internal`);
      // The whole document: every nested key and value.
      assert.deepEqual(compose, expectedCompose(compose.services.body!.command!), dir);
    }
  });
});
