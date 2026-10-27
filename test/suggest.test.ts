import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, before, after } from "node:test";
import mineflayer from "mineflayer";
import { pathfinder } from "mineflayer-pathfinder";
import { ZodError, z } from "zod";
import { explainError, suggestBotMember } from "../src/host/suggest.ts";
import { MC_VERSION } from "../src/mc/version.ts";

/**
 * One row per bot member path an agent used in a run of the corpus (history.jsonl, sha256 91e51173…). `message`
 * is the TypeError message as the run record prints it; `named` are the members the suggestion tells the agent
 * to use; `says` is the instruction the line must carry.
 */
const CORPUS = [
  { seq: 10, path: "setYaw", message: "bot.setYaw is not a function", named: ["look"], says: "bot.look(yaw, pitch)" },
  { seq: 10, path: "isSneaking", message: "bot.isSneaking is not a function", named: ["getControlState"], says: 'bot.getControlState("sneak")' },
  { seq: 6, path: "getSkyLight", message: "bot.getSkyLight is not a function", named: ["blockAt"], says: "bot.blockAt(pos).skyLight" },
  { seq: 24, path: "daylight", message: "bot.daylight is not a function", named: ["time.timeOfDay", "time.isDay"], says: "bot.time.timeOfDay" },
  { seq: 29, path: "selectItem", message: "bot.selectItem is not a function", named: ["equip"], says: 'bot.equip(item, "hand")' },
  { seq: 29, path: "isRaining", message: "bot.isRaining is not a function", named: ["isRaining"], says: "bot.isRaining is a boolean" },
  {
    seq: 12,
    path: "entities.values",
    message: "bot.entities.values is not a function or its return value is not iterable",
    named: ["entities"],
    says: "Object.values(bot.entities)",
  },
  { seq: 90, path: "entities.filter", message: "bot.entities.filter is not a function", named: ["entities"], says: "Object.values(bot.entities).filter(" },
  {
    seq: 18,
    path: "inventory.items.filter",
    message: "bot.inventory.items.filter is not a function",
    named: ["inventory.items"],
    says: "bot.inventory.items().filter(",
  },
  { seq: 126, path: "inventory.findItem", message: "bot.inventory.findItem is not a function", named: ["inventory.items"], says: "bot.inventory.items().find(" },
  {
    seq: 457,
    path: "inventory.findInventorySlot",
    message: "bot.inventory.findInventorySlot is not a function",
    named: ["inventory.items"],
    says: "bot.inventory.items().find(",
  },
] as const;

/** A real Mineflayer bot over a stub client (no server, no socket), with the pathfinder plugin the body loads. */
async function realBot(): Promise<mineflayer.Bot> {
  const client = Object.assign(new EventEmitter(), {
    version: MC_VERSION,
    state: "play",
    write: () => {},
    writeChannel: () => {},
    registerChannel: () => {},
    end: () => {},
  });
  // The stub is the part of a node-minecraft-protocol client the plugins touch; the typings want the whole client.
  const bot = mineflayer.createBot({ client: client as unknown as mineflayer.BotOptions["client"], username: "suggest-test", version: MC_VERSION });
  bot.loadPlugin(pathfinder);
  const injected = Promise.withResolvers<void>();
  bot.once("inject_allowed", () => injected.resolve());
  await injected.promise;
  return bot;
}

function member(bot: object, path: string): unknown {
  let at: unknown = bot;
  for (const segment of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[segment];
  return at;
}

/** The TypeError V8 itself throws for `source` run with `bot` and `ctx`: not a hand-written message. */
function thrownBy(source: string, bot: object): unknown {
  try {
    new Function("bot", "ctx", source)(bot, { bot });
  } catch (err) {
    return err;
  }
  assert.fail(`expected ${source} to throw`);
}

describe("did-you-mean for bot members", () => {
  let bot: mineflayer.Bot;
  before(async () => {
    bot = await realBot();
  });
  after(() => {
    bot.emit("end", "test over");
  });

  describe("P3.1 each corpus error names a real member and how to call it", () => {
    for (const row of CORPUS) {
      it(`${row.path} (corpus run #${row.seq})`, () => {
        const line = explainError(new TypeError(row.message), bot);
        assert.ok(line, `no suggestion for ${row.message}`);
        assert.ok(line.includes(row.says), `${line} should say ${row.says}`);
        assert.equal(line.split("\n").length, 1, "one line");
        for (const name of row.named) assert.notEqual(member(bot, name), undefined, `bot.${name} is not on a real bot`);
        assert.equal(member(bot, row.path) === undefined || row.path === "isRaining", true, `bot.${row.path} must be a real hallucination`);
      });

      it(`${row.path}: the error V8 throws for the call gets the same line`, () => {
        const call = row.path === "entities.values" ? "for (const e of bot.entities.values()) {}" : `bot.${row.path}()`;
        const thrown = thrownBy(call, bot);
        assert.ok(thrown instanceof TypeError);
        assert.equal(explainError(thrown, bot), suggestBotMember(row.path));
      });
    }

    it("the instructions work on a real bot", () => {
      assert.equal(typeof bot.look, "function");
      assert.equal(bot.getControlState("sneak"), false);
      assert.equal(typeof bot.blockAt, "function");
      assert.ok("timeOfDay" in bot.time && "isDay" in bot.time);
      assert.equal(typeof bot.equip, "function");
      assert.equal(typeof bot.isRaining, "boolean");
      assert.ok(Array.isArray(Object.values(bot.entities)));
      assert.ok(Array.isArray(bot.inventory.items().filter(() => true)));
      assert.equal(bot.inventory.items().find(() => true), undefined);
    });

    it("also matches ctx.bot and a destructured alias that ends in bot", () => {
      const selectItem = suggestBotMember("selectItem");
      assert.ok(selectItem);
      assert.equal(explainError(new TypeError("ctx.bot.selectItem is not a function"), bot), selectItem);
      assert.equal(explainError(thrownBy("const { bot: myBot } = ctx; myBot.selectItem({})", bot), bot), selectItem);
      assert.equal(explainError(new Error("TypeError: bot.selectItem is not a function\n    at default (/x/run.ts:3:7)")), selectItem);
    });

    it("a curated line is withheld on a bot that lacks the member it names", () => {
      assert.equal(explainError(new TypeError("bot.selectItem is not a function"), {}), undefined);
      assert.equal(explainError(new TypeError("bot.selectItem is not a function"), { equip: () => {} }), suggestBotMember("selectItem"));
      assert.equal(suggestBotMember("entities.values", {}), undefined);
      assert.equal(suggestBotMember("daylight", { time: { isDay: true } }), undefined);
      assert.equal(suggestBotMember("isRaining", { isRaining: false }), suggestBotMember("isRaining"));
    });

    it("a path that is a real function is not suggested against", () => {
      assert.equal(explainError(new TypeError("bot.equip is not a function"), bot), undefined);
      assert.equal(suggestBotMember("inventory.items", bot), undefined);
    });
  });

  describe("edit distance over the real members, for paths nobody curated", () => {
    it("names the nearest real member and how to call it", () => {
      assert.equal(suggestBotMember("equipp", bot), "bot.equipp does not exist: the nearest real member is bot.equip(...)");
      assert.equal(suggestBotMember("chatt", bot), "bot.chatt does not exist: the nearest real member is bot.chat(...)");
      assert.equal(suggestBotMember("getControlStat", bot), "bot.getControlStat does not exist: the nearest real member is bot.getControlState(...)");
      assert.equal(suggestBotMember("inventory.itemz", bot), "bot.inventory.itemz does not exist: the nearest real member is bot.inventory.items(...)");
      assert.equal(suggestBotMember("Equip", bot), "bot.Equip does not exist: the nearest real member is bot.equip(...)");
    });

    it("tells an agent to read, not call, a real value", () => {
      assert.equal(suggestBotMember("isRainin", bot), "bot.isRainin does not exist: the nearest real member is bot.isRaining, a boolean to read, not call");
      assert.equal(suggestBotMember("version", bot), "bot.version is a string, not a function: read bot.version");
      assert.equal(explainError(new TypeError("bot.version is not a function"), bot), suggestBotMember("version", bot));
    });

    it("says nothing when no member is close, or the name is too short to judge", () => {
      assert.equal(suggestBotMember("teleportToSpawn", bot), undefined);
      assert.equal(suggestBotMember("xyz", bot), undefined);
      assert.equal(suggestBotMember("fly", bot), undefined);
      assert.equal(suggestBotMember("deeply.nested.thing", bot), undefined);
      assert.equal(suggestBotMember("version.anything", bot), undefined);
    });

    it("without a live bot nothing uncurated is answered", () => {
      assert.equal(suggestBotMember("equipp"), undefined);
      assert.equal(explainError(new TypeError("bot.chatt is not a function")), undefined);
    });
  });

  describe("P3.2 no false suggestion, never throws", () => {
    const refusal =
      "the run did not start: the type check found 1 error(s) in your code. Fix them and run again, or put // @ts-nocheck as the first line to run it unchecked.\n  line 3:7 Property 'selectItem' does not exist on type 'Bot'.\n    bot.selectItem does not exist: use bot.equip(item, \"hand\")";
    const throwingProxy = new Proxy(new Error("bot.selectItem is not a function"), {
      get() {
        throw new Error("proxy trap");
      },
      getPrototypeOf() {
        throw new Error("proxy trap");
      },
    });
    const throwingMessage = Object.defineProperty(new TypeError("x"), "message", {
      get() {
        throw new Error("message getter");
      },
    });
    const zod = (() => {
      const parsed = z.object({ bot: z.string() }).safeParse({});
      assert.ok(!parsed.success);
      return parsed.error;
    })();
    assert.ok(zod instanceof ZodError);

    const cases: Array<[string, unknown]> = [
      ["g.on is not a function", new TypeError("g.on is not a function")],
      ["a callee that is not rooted at bot", new TypeError("g.selectItem is not a function")],
      ["a receiver that merely contains bot", new TypeError("bots.selectItem is not a function")],
      ["ctx.notes.get(...).catch", new TypeError("ctx.notes.get(...).catch is not a function")],
      ["a call chain on bot", new TypeError("bot.inventory.items(...).filter is not a function")],
      ["bed not intact", new Error("bed not intact: air")],
      ["a ZodError", zod],
      ["bot text inside a longer message", new Error("could not run: bot.selectItem is not a function")],
      ["Cannot read properties", new TypeError("Cannot read properties of undefined (reading 'position')")],
      ["a refusal as an Error", new Error(refusal)],
      ["a refusal as text", refusal],
      ["a thrown string that looks like the message", "bot.selectItem is not a function"],
      ["a thrown object that looks like the error", { message: "bot.selectItem is not a function" }],
      ["a thrown number", 42],
      ["null", null],
      ["undefined", undefined],
      ["a Proxy whose get throws", throwingProxy],
      ["an Error whose message getter throws", throwingMessage],
      ["a message of 100 000 characters", new TypeError(`bot.${"x".repeat(100_000)} is not a function`)],
    ];
    for (const [label, err] of cases) {
      it(`${label}: undefined, with and without a bot`, () => {
        assert.equal(explainError(err), undefined);
        assert.equal(explainError(err, bot), undefined);
      });
    }

    it("a bot whose members throw gives no suggestion and no exception", () => {
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("hostile");
          },
          has() {
            throw new Error("hostile");
          },
          ownKeys() {
            throw new Error("hostile");
          },
        },
      );
      assert.equal(suggestBotMember("selectItem", hostile), undefined);
      assert.equal(suggestBotMember("equipp", hostile), undefined);
      assert.equal(explainError(new TypeError("bot.selectItem is not a function"), hostile), undefined);
    });

    it("paths that are not member paths are refused", () => {
      for (const path of ["", ".", "a..b", "a.", "selectItem()", "a b", "bot.selectItem(", "a-b"]) {
        assert.equal(suggestBotMember(path), undefined, path);
        assert.equal(suggestBotMember(path, bot), undefined, path);
      }
      assert.equal(suggestBotMember(undefined as unknown as string), undefined);
      assert.equal(suggestBotMember("constructor"), undefined);
      assert.equal(suggestBotMember("__proto__"), undefined);
    });
  });

  describe("P3.3 the curated table answers without a live bot", () => {
    for (const row of CORPUS) {
      it(`${row.path}`, () => {
        const line = suggestBotMember(row.path);
        assert.ok(line, `no curated line for ${row.path}`);
        assert.ok(line.includes(row.says), line);
        assert.equal(line, explainError(new TypeError(row.message), bot));
        assert.equal(line, explainError(new TypeError(row.message)));
      });
    }

    it("the example line from the contract", () => {
      assert.equal(suggestBotMember("selectItem"), 'bot.selectItem does not exist: use bot.equip(item, "hand")');
    });
  });
});
