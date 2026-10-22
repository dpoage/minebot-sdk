// The built-in routine modules a body offers: the offered set, call-name lookup, reference text,
// search, source, the call counter, and the offer gate in the library loader. Everything here runs
// without a player; test/builtin-calls.test.ts runs the same service inside a bot host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { BODY_FLAG_OPTIONS, builtinOffer, parseBodyFlags } from "../src/client/body-flags.ts";
import { Builtins } from "../src/host/routines/builtins.ts";
import { KitStats } from "../src/host/routines/stats.ts";
import { defineRoutine, metaOf, observerOf, withObserver, type Routine } from "../src/routine/define.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";
import { JsonStore } from "../src/store.ts";

const ROOT = path.join(import.meta.dirname, "..");
const SCRATCH = realpathSync(mkdtempSync(path.join(tmpdir(), "minebot-builtins-")));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const ALL = BUILTIN_MODULES.map((module) => module.name);
const memoryStats = () => new KitStats(JsonStore.memory());

/** The modules `names` list and what they use, in catalog order, worked out here from the catalog's `uses` alone. */
function closure(names: readonly string[]): string[] {
  const wanted = new Set<string>();
  const visit = (name: string): void => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dep of BUILTIN_MODULES.find((module) => module.name === name)!.uses) visit(dep);
  };
  names.forEach(visit);
  return ALL.filter((name) => wanted.has(name));
}

/** Every routine of the catalog as [module, routine name, routine value]. */
const ROUTINES = BUILTIN_MODULES.flatMap((module) => Object.entries(module.routines).map(([name, routine]) => [module.name, name, routine] as const));

describe("the offered set", () => {
  it("is every built-in module by default, none for an empty list, and the closure of the names over `uses` otherwise", () => {
    assert.equal(ALL.length, 18);
    assert.deepEqual(new Builtins({ stats: memoryStats() }).offered, ALL);
    assert.deepEqual(new Builtins({ offer: [], stats: memoryStats() }).offered, []);
    // The closure of one module, each module alone: what the module uses is offered with it, and nothing else.
    for (const name of ALL) assert.deepEqual(new Builtins({ offer: [name], stats: memoryStats() }).offered, closure([name]), name);
    // A body that offers the gatherer offers the primitives it calls.
    assert.deepEqual(new Builtins({ offer: ["gatherer"], stats: memoryStats() }).offered, ["move", "sense", "dig", "inventory", "items", "gatherer"]);
  });

  it("does not depend on the order or the repetition of the names", () => {
    const offered = new Builtins({ offer: ["gatherer", "move", "crafter", "gatherer"], stats: memoryStats() }).offered;
    assert.deepEqual(offered, new Builtins({ offer: ["crafter", "gatherer"], stats: memoryStats() }).offered);
    assert.deepEqual(offered, closure(["gatherer", "crafter"]));
  });

  it("refuses an unknown name, naming it and the modules there are", () => {
    assert.throws(() => new Builtins({ offer: ["move", "nope"], stats: memoryStats() }), new RegExp(`^Error: unknown built-in module "nope"; available: ${ALL.join(", ")}$`));
    assert.throws(() => new Builtins({ offer: ["constructor"], stats: memoryStats() }), /unknown built-in module "constructor"/);
  });
});

describe("a call name", () => {
  const builtins = new Builtins({ offer: ["gatherer"], stats: memoryStats() });
  const offered = new Set(builtins.offered);

  it("finds exactly the routines of the offered modules, and they are the catalog's routine values", () => {
    for (const [module, name, routine] of ROUTINES) {
      assert.equal(builtins.routine(`${module}.${name}`), offered.has(module) ? routine : undefined, `${module}.${name}`);
    }
    assert.ok(ROUTINES.length >= 50);
  });

  it("finds nothing for a name that is not `<module>.<routine>` of an offered module", () => {
    for (const name of ["move", "move.", ".to", "move.to.again", "move.constructor", "move.__proto__", "move.hasOwnProperty", "toString.call", "Move.to", "gatherer.nope", "place.place", "explorer.scan", ""]) {
      assert.equal(builtins.routine(name), undefined, JSON.stringify(name));
    }
  });
});

describe("reference text", () => {
  /** What the routine's argument schema says, as JSON Schema, which this test reads independently of the zod classes the docs read. */
  function declared(routine: Routine): { keys: { name: string; optional: boolean; fallback?: unknown }[]; returns: boolean } {
    const meta = metaOf(routine)!;
    const schema = z.toJSONSchema(meta.args!, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, { default?: unknown }>; required?: string[] };
    const required = new Set(schema.required ?? []);
    const keys = Object.entries(schema.properties ?? {}).map(([name, property]) => ({ name, optional: !required.has(name), ...("default" in property && { fallback: property.default }) }));
    return { keys, returns: meta.returns !== undefined };
  }

  /** The text of one routine's section: from its `###` heading to the next heading. */
  function section(docs: string, heading: string): string {
    const start = docs.indexOf(`### ${heading}\n`);
    assert.ok(start >= 0, `no section ${heading}`);
    const rest = docs.slice(start + 4);
    const end = rest.search(/\n##/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  it("gives every routine its call shape, its description, one line per argument with type, `?` and default, and its return", () => {
    const docs = new Builtins({ stats: memoryStats() }).docs();
    for (const [module, name, routine] of ROUTINES) {
      const { keys, returns } = declared(routine);
      // A routine that takes no arguments is called with the context alone.
      const shape = keys.length === 0 ? `${module}.${name}(ctx)` : `${module}.${name}(ctx, { ${keys.map((key) => `${key.name}${key.optional ? "?" : ""}`).join(", ")} })`;
      const text = section(docs, shape);
      const lines = text.split("\n");
      assert.equal(lines[1], metaOf(routine)!.description, `${shape} description`);
      const argumentLines = lines.filter((line) => line.startsWith("- "));
      assert.equal(argumentLines.length, keys.length, `${shape}: one line per argument`);
      keys.forEach((key, i) => {
        const line = argumentLines[i]!;
        assert.match(line, new RegExp(`^- ${key.name}${key.optional ? "\\?" : ""}: \\S`), `${shape} ${key.name}`);
        if ("fallback" in key) assert.ok(line.endsWith(` (default ${JSON.stringify(key.fallback)})`), `${shape}: ${line}`);
        else assert.ok(!line.includes("(default"), `${shape}: ${line}`);
      });
      assert.equal(lines.some((line) => line.startsWith("Returns: ")), returns, `${shape} returns`);
    }
  });

  it("documents the named modules, in the order given and once, with their uses, and every offered module when none is named", () => {
    const builtins = new Builtins({ offer: ["gatherer"], stats: memoryStats() });
    const all = builtins.docs();
    assert.deepEqual([...all.matchAll(/^## (\S+)$/gm)].map((match) => match[1]), builtins.offered);
    assert.deepEqual([...builtins.docs(["items", "move", "items"]).matchAll(/^## (\S+)$/gm)].map((match) => match[1]), ["items", "move"]);
    assert.match(all, /^## gatherer\n.+\nUses: move, sense, dig, inventory, items\.$/m);
    assert.match(all, /^## move\n.+\nUses no other built-in modules\.$/m);
    assert.throws(() => builtins.docs(["place"]), /^Error: unknown built-in module "place"; offered: move, sense, dig, inventory, items, gatherer$/);
    assert.throws(() => builtins.docs(["move", "nope"]), /unknown built-in module "nope"/);
  });

  it("is generated from the routine's metadata: a routine that declares another default is documented with it", () => {
    const move = BUILTIN_MODULES.find((module) => module.name === "move")!;
    const routines = move.routines as Record<string, Routine>;
    const original = routines.to!;
    routines.to = defineRoutine({ name: "move.to", description: "Walks somewhere else.", args: z.object({ position: z.number().default(123), speed: z.string().optional() }), returns: z.boolean() }, () => true);
    try {
      const docs = new Builtins({ offer: ["move"], stats: memoryStats() }).docs(["move"]);
      assert.match(docs, /### move\.to\(ctx, \{ position\?, speed\? \}\)\nWalks somewhere else\.\n- position\?: number \(default 123\)\n- speed\?: string\nReturns: boolean/);
    } finally {
      routines.to = original;
    }
  });
});

describe("search", () => {
  /** The queries of the base kit tests (kit search: agent-kit.test, the body API's /kits/search), plus ones that tie. */
  const CORPUS = ["walk", "collect logs", "collect drops", "waypoints", "crafter", "pickaxe", "xyzzy plugh", "   ", "smelt iron", "eat food", "place block", "chat players", "follow player", "bucket water", "dig down", "attack hostile", "craft table", "inventory", "items", "gather", "make", "list", "scan", "stop", "to", "position range"];

  const builtins = new Builtins({ stats: memoryStats() });

  /** What the kit search at 5218f99 ranked for each query and limit of the corpus, recorded once and committed: (module, routine) hits with score and text. */
  const KIT_SEARCH = JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", "catalog", "kit-search-5218f99.json"), "utf8")) as { query: string; limit: number; hits: unknown[] }[];

  it("ranks the (module, routine) sequence the kit search ranked for the same (kit, action) catalog, for every query and limit", () => {
    assert.deepEqual(KIT_SEARCH.map(({ query, limit }) => [query, limit]), CORPUS.flatMap((query) => [1, 5, 20].map((limit) => [query, limit])), "the committed table covers the corpus");
    let nonEmpty = 0;
    for (const { query, limit, hits } of KIT_SEARCH) {
      const actual = builtins.search(query, limit).map(({ stats: _stats, ...hit }) => hit);
      assert.deepEqual(actual, hits, `${JSON.stringify(query)} limit ${limit}`);
      if (hits.length > 0) nonEmpty++;
    }
    assert.ok(nonEmpty >= 60, "the corpus must find things");
  });

  it("keeps routines in the order their module declares them when scores tie", () => {
    // `gather` and `collectDrops` both match "gatherer drops" through the module; the module's own order decides ties between its routines.
    const hits = builtins.search("gatherer", 20).filter((hit) => hit.module === "gatherer" && hit.routine !== undefined).map((hit) => hit.routine);
    assert.deepEqual(hits, Object.keys(BUILTIN_MODULES.find((module) => module.name === "gatherer")!.routines).filter((name) => hits.includes(name)));
    const moves = builtins.search("move", 20);
    assert.deepEqual(moves.filter((hit) => hit.module === "move" && hit.routine !== undefined).map((hit) => hit.routine), ["to", "stop"]);
  });

  it("finds the module and its routines, and nothing of a module that is not offered", () => {
    const hits = builtins.search("collect logs", 5);
    assert.equal(hits[0]!.module, "gatherer");
    assert.ok(hits.some((hit) => hit.module === "gatherer" && hit.routine === "gather"));
    const gatherer = new Builtins({ offer: ["gatherer"], stats: memoryStats() });
    for (const query of CORPUS) for (const hit of gatherer.search(query, 20)) assert.ok(gatherer.offered.includes(hit.module), `${query}: ${hit.module}`);
    assert.deepEqual(gatherer.search("furnace smelt", 20).filter((hit) => hit.module === "furnace"), []);
  });

  it("shows how often a routine worked", () => {
    const stats = memoryStats();
    stats.record("gatherer", "gather");
    stats.record("gatherer", "gather", { message: "no trees" });
    const hit = new Builtins({ stats }).search("gather", 20).find((candidate) => candidate.module === "gatherer" && candidate.routine === "gather")!;
    assert.deepEqual(hit.stats, { ok: 1, failed: 1, lastError: "no trees" });
    assert.equal(new Builtins({ stats }).search("gather", 20).find((candidate) => candidate.routine === undefined)!.stats, undefined);
  });
});

describe("source", () => {
  it("is the shipped file of an offered module, byte for byte, and nothing for any other name", () => {
    const builtins = new Builtins({ offer: ["gatherer"], stats: memoryStats() });
    for (const module of BUILTIN_MODULES) {
      assert.equal(builtins.source(module.name), builtins.offered.includes(module.name) ? readFileSync(path.join(ROOT, "src", "routines", `${module.name}.ts`), "utf8") : undefined, module.name);
    }
    for (const name of ["index", "../routines/move", "move.ts", "", "constructor"]) assert.equal(builtins.source(name), undefined, name);
  });
});

describe("the module listing", () => {
  it("lists the offered modules with their descriptions, uses, routines in declaration order, and the counts", () => {
    const stats = memoryStats();
    stats.record("move", "stop");
    stats.record("sense", "find", { message: "x".repeat(400) });
    const list = new Builtins({ offer: ["gatherer"], stats }).list();
    assert.deepEqual(list.map((info) => info.name), ["move", "sense", "dig", "inventory", "items", "gatherer"]);
    for (const info of list) {
      const module = BUILTIN_MODULES.find((candidate) => candidate.name === info.name)!;
      assert.deepEqual([info.description, info.uses, info.routines], [module.description, [...module.uses], Object.keys(module.routines)]);
    }
    assert.deepEqual(list[0]!.stats, { stop: { ok: 1, failed: 0 } });
    assert.equal(list[1]!.stats.find!.lastError!.length, 300);
    assert.deepEqual(list[2]!.stats, {});
  });
});

describe("the call counter", () => {
  const aborted = { ok: false as const, message: "stopped", aborted: true };
  const failed = { ok: false as const, message: "boom", aborted: false };
  const move = BUILTIN_MODULES.find((module) => module.name === "move")!.routines;

  it("counts the end of a call of an offered built-in routine by its identity in the catalog", () => {
    const stats = memoryStats();
    const { observe } = new Builtins({ stats });
    observe({ routine: move.to!, name: "move.to", args: {} })({ ok: true });
    observe({ routine: move.to!, name: "move.to", args: {} })(failed);
    observe({ routine: move.to!, name: "move.to", args: {} })({ ok: true });
    observe({ routine: move.stop!, name: "move.stop", args: {} })({ ok: true });
    assert.deepEqual(stats.forKit("move"), { to: { ok: 2, failed: 1, lastError: "boom" }, stop: { ok: 1, failed: 0 } });
  });

  it("does not count a failure after the run was aborted, and does count a success", () => {
    const stats = memoryStats();
    const { observe } = new Builtins({ stats });
    observe({ routine: move.to!, name: "move.to", args: {} })(aborted);
    assert.deepEqual(stats.forKit("move"), {});
    observe({ routine: move.to!, name: "move.to", args: {} })({ ok: true });
    assert.deepEqual(stats.forKit("move"), { to: { ok: 1, failed: 0 } });
  });

  it("does not count a routine that only names itself like a built-in, nor a routine of a module the body does not offer", () => {
    const stats = memoryStats();
    const impostor = defineRoutine({ name: "move.to" }, () => 1);
    const { observe } = new Builtins({ offer: ["move"], stats });
    observe({ routine: impostor, name: "move.to", args: {} })({ ok: true });
    observe({ routine: BUILTIN_MODULES.find((module) => module.name === "place")!.routines.place!, name: "place.place", args: {} })({ ok: true });
    observe({ routine: (() => 1) as unknown as Routine, args: {} })({ ok: true });
    assert.deepEqual([stats.forKit("move"), stats.forKit("place")], [{}, {}]);
  });

  it("never throws, even when the stats it counts into cannot take the count", () => {
    const store = JsonStore.memory();
    store.set("actions", { move: "not an object" });
    const { observe } = new Builtins({ stats: new KitStats(store) });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      assert.doesNotThrow(() => observe({ routine: move.to!, name: "move.to", args: {} })({ ok: true }));
      assert.doesNotThrow(() => observe({ routine: move.to!, name: "move.to", args: {} })(failed));
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1, "reported once");
  });

  it("counts a call made with a context that carries the observer, however deep, and not through a context without it", async () => {
    const stats = memoryStats();
    const builtins = new Builtins({ stats });
    const signal = new AbortController().signal;
    const bot = { pathfinder: { setGoal: () => {} }, clearControlStates: () => {} };
    const ctx = withObserver({ bot, signal } as never, builtins.observe);
    assert.equal(observerOf(ctx), builtins.observe);
    const outer = defineRoutine({ name: "agent.outer" }, async (inner) => {
      await move.stop!({ ...inner });
    });
    await outer(ctx);
    assert.deepEqual(stats.forKit("move"), { stop: { ok: 1, failed: 0 } });
    await move.stop!({ bot, signal } as never);
    assert.deepEqual(stats.forKit("move"), { stop: { ok: 1, failed: 0 } });
  });

  it("writes the counts it holds when flushed, also when it holds none", () => {
    const file = path.join(SCRATCH, "counts", "kit-stats.json");
    const stats = new KitStats(new JsonStore(file));
    const builtins = new Builtins({ stats });
    builtins.flush();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { actions: {} });
    builtins.observe({ routine: move.stop!, name: "move.stop", args: {} })({ ok: true });
    builtins.flush();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { actions: { move: { stop: { ok: 1, failed: 0 } } } });
  });
});

describe("the offer gate", () => {
  const builtins = new Builtins({ offer: ["gatherer"], stats: memoryStats() });

  it("refuses `minebot-sdk/routines/<module>` of a built-in module that is not offered, and nothing else", () => {
    for (const module of ALL) assert.equal(builtins.allows(`minebot-sdk/routines/${module}`), builtins.offered.includes(module), module);
    for (const specifier of ["zod", "mineflayer", "minebot-sdk/routine", "minebot-sdk/testing", "minebot-sdk/routines/unknown", "minebot-sdk/routines/index", "node:fs", "./move.ts", "other/minebot-sdk/routines/place"]) {
      assert.equal(builtins.allows(specifier), true, specifier);
    }
    assert.equal(new Builtins({ offer: [], stats: memoryStats() }).allows("minebot-sdk/routines/move"), false);
  });
});

describe("--builtins", () => {
  /** The values `minebot body` hands `parseBodyFlags` when only `--builtins` is given: the flags' own defaults. */
  const flags = (builtins?: string) => parseBodyFlags("x", { ...Object.fromEntries(Object.entries(BODY_FLAG_OPTIONS).map(([name, option]) => [name, "default" in option ? option.default : undefined])), ...(builtins !== undefined && { builtins }) });

  it("reads a list of names, `none` alone, and nothing as every module", () => {
    assert.equal(builtinOffer(undefined), undefined);
    assert.deepEqual(builtinOffer("none"), []);
    assert.deepEqual(builtinOffer("move, gatherer,"), ["move", "gatherer"]);
    assert.equal(flags().builtins, undefined);
    assert.equal(flags("none").builtins, "none");
    assert.equal(flags("move,gatherer").builtins, "move,gatherer");
  });

  it("refuses an empty list and `none` among names", () => {
    // A ZodError's message is JSON, so the quotes in the refusal arrive escaped.
    for (const value of ["", ",", "none,move", "move,none"]) assert.throws(() => flags(value), /--builtins takes module names separated by commas, or \\"none\\" alone/, JSON.stringify(value));
  });
});

/** Runs `script` (TypeScript, absolute imports) in a node process with the source condition and a scratch runtime directory. */
function runScript(name: string, script: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(SCRATCH, `${name}.ts`);
  writeFileSync(file, script);
  return spawnSync(process.execPath, ["--conditions=minebot-sdk:source", file, ...args], { encoding: "utf8", timeout: 90_000, env: { ...process.env, MINEBOT_RUNTIME_DIR: path.join(SCRATCH, "runtime") } });
}

describe("the loader gate, in a process of its own", () => {
  // A library module that imports `minebot-sdk/routines/<module>` by import, by a call-time import(), and by require().
  const MODULES: Record<string, string> = {
    "uses-place.ts": 'import * as place from "minebot-sdk/routines/place";\nexport default () => typeof place.place;\n',
    "uses-inventory.ts": 'import * as inventory from "minebot-sdk/routines/inventory";\nexport default () => typeof inventory.list;\n',
    "uses-move.ts": 'import * as move from "minebot-sdk/routines/move";\nexport default () => typeof move.to;\n',
    "lazy-place.ts": 'export default async () => typeof (await import("minebot-sdk/routines/place")).place;\n',
    "requires-place.ts": 'const place = require("minebot-sdk/routines/place");\nexport default () => typeof place;\n',
    "plain.ts": 'import { z } from "zod";\nexport default () => typeof z.string;\n',
  };

  it("refuses a withheld module to every library module in the process, naming the specifier, while an offered one loads", () => {
    const control = path.join(SCRATCH, "gate-control");
    const first = path.join(SCRATCH, "gate-first");
    const second = path.join(SCRATCH, "gate-second");
    for (const dir of [control, first, second]) {
      mkdirSync(dir, { recursive: true });
      for (const [file, source] of Object.entries(MODULES)) writeFileSync(path.join(dir, file), source);
    }
    const result = runScript(
      "gate",
      `
import { Builtins } from ${JSON.stringify(path.join(ROOT, "src/host/routines/builtins.ts"))};
import { RoutineLoader, setOfferGate } from ${JSON.stringify(path.join(ROOT, "src/host/routines/loader.ts"))};
import { KitStats } from ${JSON.stringify(path.join(ROOT, "src/host/routines/stats.ts"))};
import { JsonStore } from ${JSON.stringify(path.join(ROOT, "src/store.ts"))};

const loaders = [new RoutineLoader(${JSON.stringify(control)}), new RoutineLoader(${JSON.stringify(first)}), new RoutineLoader(${JSON.stringify(second)})];
const attempt = async (loader, name) => {
  try {
    return { ok: true, value: await (await loader.load(name)).default() };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
};
const names = ${JSON.stringify(Object.keys(MODULES).map((file) => file.slice(0, -3)))};
const before = [];
for (const name of names) before.push([name, await attempt(loaders[0], name)]);
setOfferGate(new Builtins({ offer: ["gatherer"], stats: new KitStats(JsonStore.memory()) }).allows);
const out = { before: Object.fromEntries(before), first: {}, second: {} };
for (const name of names) {
  out.first[name] = await attempt(loaders[1], name);
  out.second[name] = await attempt(loaders[2], name);
}
console.log(JSON.stringify(out));
`,
    );
    assert.equal(result.status, 0, result.stderr);
    type Answer = { ok: boolean; value?: string; error?: string };
    const out = JSON.parse(result.stdout) as { before: Record<string, Answer>; first: Record<string, Answer>; second: Record<string, Answer> };
    // Control: before the gate is set, a library module loads whatever it imports.
    assert.ok(Object.values(out.before).every((answer) => answer.ok), JSON.stringify(out.before));
    for (const libraryAnswers of [out.first, out.second]) {
      for (const name of ["uses-place", "lazy-place", "requires-place"]) {
        assert.equal(libraryAnswers[name]!.ok, false, name);
        assert.match(libraryAnswers[name]!.error!, /"minebot-sdk\/routines\/place"/, name);
      }
      assert.deepEqual(libraryAnswers["uses-inventory"], { ok: true, value: "function" }, "inventory is used by the gatherer, so it is offered");
      assert.deepEqual(libraryAnswers["uses-move"], { ok: true, value: "function" });
      assert.deepEqual(libraryAnswers.plain, { ok: true, value: "function" }, "the gate is about built-in modules only");
    }
  });
});

describe("a body that is asked for a module that does not exist", () => {
  it("fails to start, naming it", () => {
    const state = path.join(SCRATCH, "unknown-state");
    const result = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", path.join(ROOT, "src/cli.ts"), "body", "--bot", "unknown", "--host", "127.0.0.1", "--port", "1", "--state", state, "--builtins", "move,nope"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, MINEBOT_RUNTIME_DIR: path.join(SCRATCH, "runtime-unknown") },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /unknown built-in module "nope"; available: move, sense/);
  });
});

describe("the published package", () => {
  /** Runs `command` in `cwd` without the source condition (NODE_OPTIONS dropped), as an installed package runs. */
  function run(command: string, args: string[], cwd: string): string {
    const { NODE_OPTIONS: _options, NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 90_000 });
    assert.equal(result.status, 0, `${path.basename(args[0] ?? command)} exited ${result.status ?? result.signal}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }

  it("serves a module's source from the layout npm installs: the shipped .ts, whose routines are the ones the dist modules export", { timeout: 180_000 }, () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[]; dependencies: Record<string, string> };
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), "minebot-builtins-dist-")));
    try {
      const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
      run(process.execPath, [tsc, "-p", path.join(ROOT, "tsconfig.build.json"), "--outDir", path.join(work, "dist")], ROOT);
      const app = path.join(work, "app");
      const installed = path.join(app, "node_modules", "minebot-sdk");
      mkdirSync(installed, { recursive: true });
      cpSync(path.join(ROOT, "package.json"), path.join(installed, "package.json"));
      renameSync(path.join(work, "dist"), path.join(installed, "dist"));
      for (const entry of manifest.files.filter((file) => file !== "dist" && existsSync(path.join(ROOT, file)))) cpSync(path.join(ROOT, entry), path.join(installed, entry), { recursive: true });
      for (const name of [...Object.keys(manifest.dependencies), "@types/node"]) {
        mkdirSync(path.dirname(path.join(app, "node_modules", name)), { recursive: true });
        symlinkSync(path.join(ROOT, "node_modules", name), path.join(app, "node_modules", name));
      }
      writeFileSync(path.join(app, "package.json"), JSON.stringify({ type: "module", private: true }));
      writeFileSync(
        path.join(app, "check.mjs"),
        `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as move from "minebot-sdk/routines/move";

const installed = process.argv[2];
const load = (file) => import(pathToFileURL(installed + "/dist/" + file).href);
const { Builtins } = await load("host/routines/builtins.js");
const { KitStats } = await load("host/routines/stats.js");
const { JsonStore } = await load("store.js");
assert.match(import.meta.resolve("minebot-sdk/routines/move"), /\\/node_modules\\/minebot-sdk\\/dist\\/routines\\/move\\.js$/);
const builtins = new Builtins({ stats: new KitStats(JsonStore.memory()) });
assert.equal(builtins.offered.length, 18);
assert.equal(builtins.routine("move.to"), move.to, "the catalog's routine is the one the package exports");
for (const name of builtins.offered) {
  const shipped = readFileSync(installed + "/src/routines/" + name + ".ts", "utf8");
  assert.equal(builtins.source(name), shipped, name);
  assert.match(shipped, /defineRoutine/);
}
assert.match(builtins.docs(["move"]), /^### move\\.to\\(ctx, \\{ position/m);
console.log("published layout ok");
`,
      );
      assert.match(run(process.execPath, ["check.mjs", installed], app), /^published layout ok$/m);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
