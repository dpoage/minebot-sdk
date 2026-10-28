// The run reference cannot drift from the bot and the catalog it describes. Every `bot.` member the
// reference names resolves on a real Mineflayer bot (a stub client fed the login, update_health and
// update_time packets a 26.1 server sent, test/fixtures/bot-packets-26.1.json, with the pathfinder
// plugin loaded as the body loads it), except the wrong column of the facts table, which lists members
// that do not exist. Every `<module>.<routine>` it names is in the catalog. The facts table has a row
// for each mistake agents made, every built-in call shape starts with `await`, and the goal table
// shows a row only for a module the body offers.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Builtins } from "../src/host/routines/builtins.ts";
import { KitStats } from "../src/host/routines/stats.ts";
import { MC_VERSION } from "../src/mc/version.ts";
import { BOT_FACTS, GOAL_BUILTINS, programApiDoc, type BodyFeatures } from "../src/protocol/features.ts";
import { BUILTIN_MODULES } from "../src/routines/index.ts";
import { JsonStore } from "../src/store.ts";

const { pathfinder } = pathfinderPkg;

const ALL = BUILTIN_MODULES.map((module) => module.name);
const FULL: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ALL };
const bodyFeatures = (builtins: string[], routines = true): BodyFeatures => ({ ...FULL, routines, builtins });
const builtinDocs = () => new Builtins({ stats: new KitStats(JsonStore.memory()) }).docs();

const PACKETS = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "bot-packets-26.1.json"), "utf8")) as {
  version: string;
  registry_data: unknown;
  login: unknown;
  update_health: unknown;
  update_time: unknown;
};

/** A client that has no server: Mineflayer's plugins listen on it and write to it, and the test emits the packets a server sent. */
class StubClient extends EventEmitter {
  version = MC_VERSION;
  username = "reference-drift";
  state = "play";
  registerChannel(): void {}
  writeChannel(): void {}
  write(): void {}
  end(): void {}
}

/** The `bot.` member paths a text names: `bot.a.b.c` at a word boundary (a `ctx.bot.` prefix counts), as the dotted path after `bot.`. */
function botPaths(text: string): Set<string> {
  return new Set([...text.matchAll(/(?<![\w$])bot\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)].map((found) => found[1]!));
}

/** The rows of the facts table in a reference, as [wrong, right] cells; the table is the `| wrong | right |` header, a separator, and the lines that follow it. */
function factRows(doc: string): { line: number; wrong: string; right: string }[] {
  const lines = doc.split("\n");
  const header = lines.indexOf("| wrong | right |");
  assert.ok(header >= 0, "the reference has a facts table");
  assert.equal(lines[header + 1], "| --- | --- |");
  const rows: { line: number; wrong: string; right: string }[] = [];
  for (let i = header + 2; i < lines.length && lines[i]!.startsWith("| "); i++) {
    const line = lines[i]!;
    const split = line.indexOf(" | ");
    assert.ok(split > 0, line);
    rows.push({ line: i, wrong: line.slice(2, split), right: line.slice(split + 3, -2) });
  }
  return rows;
}

/** The reference with the facts table's wrong-column cells blanked out by position: nothing else is removed. */
function withoutWrongCells(doc: string): string {
  const lines = doc.split("\n");
  for (const { line, wrong } of factRows(doc)) lines[line] = `| ${" ".repeat(wrong.length)} ${lines[line]!.slice(2 + wrong.length)}`;
  return lines.join("\n");
}

/** Whether `dotted` (the path after `bot.`) names a value that is not undefined on `root`; null counts as present. */
function resolves(root: unknown, dotted: string): boolean {
  let current = root as Record<string, unknown> | null | undefined;
  for (const segment of dotted.split(".")) {
    if (current === null || current === undefined) return false;
    current = (current as Record<string, unknown>)[segment] as Record<string, unknown> | null | undefined;
  }
  return current !== undefined;
}

describe("the real bot the reference is held to", () => {
  let bot: Bot;

  before(async () => {
    const client = new StubClient();
    bot = mineflayer.createBot({ client: client as never, host: "127.0.0.1", port: 25565, username: client.username, version: MC_VERSION, auth: "offline" });
    bot.loadPlugin(pathfinder);
    await once(bot as unknown as EventEmitter, "inject_allowed");
    // The configuration phase's dimension registry, then the play packets, in the order a server sends them.
    client.emit("registry_data", PACKETS.registry_data);
    client.emit("login", PACKETS.login);
    client.emit("update_health", PACKETS.update_health);
    client.emit("update_time", PACKETS.update_time);
  });

  after(() => {
    bot.emit("end", "test over");
  });

  it("is the body's bot: the packets are the 26.1 ones and the pathfinder plugin is loaded", () => {
    assert.equal(PACKETS.version, MC_VERSION);
    assert.equal(bot.health, 20);
    assert.equal(typeof bot.pathfinder.goto, "function");
    assert.equal(typeof bot.time.timeOfDay, "number");
  });

  it("has every bot member the reference names, its facts table's wrong column apart", () => {
    const doc = programApiDoc(FULL);
    const named = botPaths(withoutWrongCells(doc));
    // The reference names the right member of each fact, so a reference that lost its members would not pass by naming nothing.
    for (const member of ["health", "equip", "inventory.items", "entities", "isRaining", "time.timeOfDay", "time.isDay", "pathfinder.goto", "entity.position.x"]) {
      assert.ok(named.has(member), `the reference names bot.${member}`);
    }
    const missing = [...named].filter((member) => !resolves(bot, member));
    assert.deepEqual(missing, [], `members the reference names that a real bot does not have: ${missing.map((member) => `bot.${member}`).join(", ")}`);
  });

  it("has every bot member the built-in docs name", () => {
    const missing = [...botPaths(builtinDocs())].filter((member) => !resolves(bot, member));
    assert.deepEqual(missing, []);
  });

  it("does not have the wrong column's members, so the table is about members that do not work", () => {
    for (const member of ["entity.health", "selectItem", "daylight", "time.moment", "entities.values", "entities.filter", "inventory.items.filter"]) {
      assert.equal(resolves(bot, member), false, `bot.${member} exists after all`);
    }
    assert.equal(typeof bot.isRaining, "boolean");
    assert.equal(typeof bot.inventory.items, "function");
  });
});

describe("the catalog names in the reference", () => {
  const byModule = new Map(BUILTIN_MODULES.map((module) => [module.name, new Set(Object.keys(module.routines))] as const));
  const texts = () => [programApiDoc(FULL), builtinDocs(), ...[["move"], ["inventory"], []].map((builtins) => programApiDoc(bodyFeatures(builtins)))];

  it("has every `<module>.<routine>` the reference names, and every module it imports or calls", () => {
    let named = 0;
    for (const text of texts()) {
      // A call or a name of a module of the catalog.
      for (const [, module, routine] of text.matchAll(/(?<![\w$.])(\w+)\.(\w+)\b(?=\(ctx|`| ?[,)}])/g)) {
        if (!byModule.has(module!)) continue;
        named++;
        assert.ok(byModule.get(module!)!.has(routine!), `${module}.${routine} is not in the catalog`);
      }
      // A call of any module: the module must be one.
      for (const [, module, routine] of text.matchAll(/await (\w+)\.(\w+)\(ctx/g)) {
        assert.ok(byModule.get(module!)?.has(routine!), `await ${module}.${routine}(ctx is not in the catalog`);
      }
      for (const [, module] of text.matchAll(/import \* as \w+ from "minebot-sdk\/routines\/(\w+)"/g)) {
        assert.ok(byModule.has(module!), `${module} is not in the catalog`);
      }
    }
    assert.ok(named > 20, `named ${named}`);
  });

  it("has every routine of the goal table", () => {
    for (const { goal, routines } of GOAL_BUILTINS) {
      for (const call of routines) {
        // A row names a routine, or the call that carries the args the goal needs: the routine is what precedes any `(`.
        const [module, routine] = call.split("(")[0]!.split(".");
        assert.ok(byModule.get(module!)?.has(routine!), `${goal}: ${call} is not in the catalog`);
      }
    }
  });
});

describe("the facts table", () => {
  /** One row per mistake agents made: what they wrote, and what the reference must tell them instead. */
  const CORPUS: { mistake: string; wrong: string; right: string[] }[] = [
    { mistake: "bot.entity.health is undefined", wrong: "bot.entity.health", right: ["`bot.health`"] },
    { mistake: "block.type is a numeric id", wrong: "block.type", right: ["`block.name`", "numeric id"] },
    { mistake: "bot.entities is not a Map", wrong: "bot.entities.values()", right: ["`Object.values(bot.entities)`"] },
    { mistake: "bot.entities has no filter", wrong: "bot.entities.filter(", right: ["`Object.values(bot.entities)`"] },
    { mistake: "bot.inventory.items is a method", wrong: "bot.inventory.items.filter", right: ["bot.inventory.items().filter(f)", "method"] },
    { mistake: "there is no selectItem", wrong: "bot.selectItem(", right: ['`await bot.equip(item, "hand")`'] },
    { mistake: "bot.isRaining is a boolean", wrong: "`bot.isRaining()`", right: ["`bot.isRaining` (a boolean"] },
    { mistake: "there is no daylight()", wrong: "bot.daylight()", right: ["`bot.time.timeOfDay`", "`bot.time.isDay`"] },
    { mistake: "there is no time.moment", wrong: "bot.time.moment", right: ["`bot.time.timeOfDay`", "`bot.time.isDay`"] },
    { mistake: "floored() is a Vec3 method", wrong: "pos.floored()", right: ["`new Vec3(x, y, z).floored()`"] },
  ];

  for (const features of [FULL, bodyFeatures([], false)]) {
    for (const { mistake, wrong, right } of CORPUS) {
      it(`teaches: ${mistake}${features.routines ? "" : " (a body with nothing optional)"}`, () => {
        const row = factRows(programApiDoc(features)).find((candidate) => candidate.wrong.includes(wrong));
        assert.ok(row, `no row for ${wrong}`);
        for (const text of right) assert.ok(row.right.includes(text), `${wrong}: right cell lacks ${text}: ${row.right}`);
      });
    }
  }

  it("is the data BOT_FACTS holds, one row each, and no row is without both cells", () => {
    const rows = factRows(programApiDoc(FULL));
    assert.deepEqual(rows.map(({ wrong, right }) => ({ wrong, right })), BOT_FACTS);
    assert.equal(rows.length, BOT_FACTS.length);
    for (const { wrong, right } of rows) assert.ok(wrong !== "" && right !== "");
  });
});

describe("the built-in call shapes", () => {
  it("start with await: the count of `### ` headings is the count of `### await ` headings, and there is one for each routine", () => {
    const docs = builtinDocs();
    const headings = docs.split("\n").filter((line) => line.startsWith("### "));
    const awaited = headings.filter((line) => line.startsWith("### await "));
    assert.equal(headings.length, BUILTIN_MODULES.reduce((sum, module) => sum + Object.keys(module.routines).length, 0));
    assert.equal(awaited.length, headings.length, `without await: ${headings.filter((line) => !line.startsWith("### await ")).join("; ")}`);
    for (const line of awaited) assert.match(line, /^### await \w+\.\w+\(ctx(, \{ .*\}|, args)?\)$/);
  });

  it("start with await in the docs of one module, as GET /builtins/docs?names= answers", () => {
    const docs = new Builtins({ offer: ["move"], stats: new KitStats(JsonStore.memory()) }).docs(["move"]);
    assert.deepEqual(docs.split("\n").filter((line) => line.startsWith("### ")), ["### await move.to(ctx, { position, range?, timeoutMs?, allowDigOwnBuilds? })", "### await move.stop(ctx)"]);
  });
});

describe("the goal table", () => {
  const TABLE = "| to | call |";
  const rowsOf = (features: BodyFeatures): string[] => {
    const lines = programApiDoc(features).split("\n");
    const header = lines.indexOf(TABLE);
    if (header < 0) return [];
    const rows: string[] = [];
    for (let i = header + 2; i < lines.length && lines[i]!.startsWith("| "); i++) rows.push(lines[i]!);
    return rows;
  };
  const rowFor = (rows: string[], routine: string) => rows.filter((row) => row.includes(`\`${routine}\``));

  it("is absent when the body offers no built-in", () => {
    assert.doesNotMatch(programApiDoc(bodyFeatures([])), /\| to \| call \|/);
    assert.doesNotMatch(programApiDoc(bodyFeatures([], false)), /already does it/);
  });

  it("is absent when the body offers modules that none of its rows are about", () => {
    for (const builtins of [["move"], ["move", "sense", "dig", "inventory"]]) {
      assert.deepEqual(rowsOf(bodyFeatures(builtins)), [], builtins.join(","));
      assert.doesNotMatch(programApiDoc(bodyFeatures(builtins)), /already does it/);
    }
  });

  it("has a row for each goal of a body that offers every module: sell or buy, make tools, place a block, sleep, find blocks, plan a craft, sleep at nightfall", () => {
    const rows = rowsOf(bodyFeatures(ALL));
    assert.equal(rows.length, GOAL_BUILTINS.length);
    assert.match(rowFor(rows, "trade.offers")[0] ?? "", /sell to or buy from a villager or wandering trader \| `trade\.offers`, `trade\.buy` \|$/);
    assert.match(rowFor(rows, "crafter.make")[0] ?? "", /make tools/);
    assert.match(rowFor(rows, "place.place")[0] ?? "", /place a block/);
    assert.match(rowFor(rows, "survival.sleep")[0] ?? "", /sleep in a bed/);
    assert.match(rowFor(rows, "explorer.scan")[0] ?? "", /find blocks/);
    // The two rows that name a goal rather than its routine's module: a plan, and a sleep that carries its args.
    assert.deepEqual(rowFor(rows, "crafter.plan"), ["| plan what a craft still needs | `crafter.plan` |"]);
    assert.deepEqual(rowFor(rows, "survival.sleep(ctx, { wait: true })"), ["| sleep as soon as night falls | `survival.sleep(ctx, { wait: true })` |"]);
  });

  it("has a row only for the module a body offers, with what it uses", () => {
    // Offering a module offers what it uses (move for trade), and no row of another module.
    assert.deepEqual(rowsOf(bodyFeatures(["move", "trade"])).map((row) => row.includes("`trade.offers`")), [true]);
    assert.deepEqual(rowsOf(bodyFeatures(["place"])).length, 1);
    assert.equal(rowFor(rowsOf(bodyFeatures(["place"])), "place.place").length, 1);
    // survival and crafter each carry two rows: the bed and the nightfall wait, the make and the plan.
    assert.deepEqual(rowsOf(bodyFeatures(["survival"])).map((row) => row.includes("`survival.sleep")), [true, true]);
    assert.deepEqual(rowsOf(bodyFeatures(["explorer", "move", "dig"])).length, 1);
    assert.deepEqual(rowsOf(bodyFeatures(["crafter", "move"])).map((row) => row.includes("`crafter.")), [true, true]);
  });

  it("is shown on a body that has built-ins and no library, where a call is POST /call", () => {
    assert.equal(rowsOf(bodyFeatures(ALL, false)).length, GOAL_BUILTINS.length);
  });
});
