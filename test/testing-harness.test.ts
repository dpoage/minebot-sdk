import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { defineRoutine, goals, Vec3, within, z } from "minebot-sdk/routine";
import { createHarness, UnsupportedApiError } from "minebot-sdk/testing";
import { Notes } from "../src/notes.ts";
import { ProgramRunner } from "../src/program/runner.ts";
import { invokeRoutine } from "../src/routine/invoke.ts";
import * as combat from "../src/routines/combat.ts";
import * as container from "../src/routines/container.ts";
import * as craft from "../src/routines/craft.ts";
import * as crafter from "../src/routines/crafter.ts";
import * as dig from "../src/routines/dig.ts";
import * as furnace from "../src/routines/furnace.ts";
import * as gatherer from "../src/routines/gatherer.ts";
import * as inventory from "../src/routines/inventory.ts";
import * as items from "../src/routines/items.ts";
import * as move from "../src/routines/move.ts";
import * as place from "../src/routines/place.ts";
import * as sense from "../src/routines/sense.ts";
import * as survival from "../src/routines/survival.ts";
import { JsonStore } from "../src/store.ts";

/** Routines that reach for Mineflayer APIs the harness does not implement, and ones that break their schemas. */
const brawler = {
  hit: defineRoutine({ name: "brawler.hit", description: "Attacks the nearest entity.", args: z.object({}) }, (ctx) => ctx.bot.attack(Object.values(ctx.bot.entities)[0]!)),
  look: defineRoutine({ name: "brawler.look", description: "Raycasts.", args: z.object({}) }, (ctx) => ctx.bot.world.raycast(ctx.bot.entity.position, ctx.bot.entity.position, 4)),
  chatty: defineRoutine(
    { name: "brawler.chatty", description: "Talks, then reports the held item.", args: z.object({ message: z.string() }), returns: z.object({ held: z.string().nullable() }) },
    (ctx, { message }) => {
      ctx.bot.chat(message);
      return { held: ctx.bot.heldItem?.name ?? null };
    },
  ),
  bad: defineRoutine({ name: "brawler.bad", description: "Returns the wrong shape.", args: z.object({}), returns: z.object({ n: z.number() }) }, () => ({ n: "one" }) as never),
};

describe("minebot-sdk/testing crafting and gathering", () => {
  it("crafts a wooden pickaxe from 7 logs: the table's planks come first, and the table gets placed", async () => {
    const h = createHarness({ inventory: { oak_log: 7 } });
    assert.equal(await h.run(crafter.make, { item: "wooden_pickaxe" }), 1);
    assert.equal(h.count("wooden_pickaxe"), 1);
    assert.equal(h.count("crafting_table"), 0);
    const table = h.bot.findBlock({ matching: h.bot.registry.blocksByName.crafting_table!.id, maxDistance: 8 });
    assert.equal(table?.name, "crafting_table");
  });

  it("refuses to craft at a table that is not there", async () => {
    const h = createHarness({ inventory: { oak_planks: 4, stick: 2 } });
    await assert.rejects(h.run(craft.craft, { item: "wooden_pickaxe" }), /needs a crafting table within 4 blocks/);
  });

  it("gathers logs by walking to them, digging them, and picking up the drops", async () => {
    const h = createHarness({ blocks: [{ name: "oak_log", from: [8, 64, 0], to: [8, 67, 0] }] });
    const result = await h.run(gatherer.gather, { blocks: "*_log", count: 2 });
    assert.deepEqual(result, { dug: 2, gained: { oak_log: 2 }, skipped: 0 });
    assert.equal(h.count("oak_log"), 2);
    assert.equal(h.blockAt([8, 64, 0]).name, "air");
    assert.equal(h.blockAt([8, 67, 0]).name, "oak_log");
    assert.ok(h.position.distanceTo(h.blockAt([8, 64, 0]).position) < 8, "the bot walked to the trunk");
  });

  it("gathers stone only with a pickaxe, and the tool is chosen from the inventory", async () => {
    const blocks = [{ name: "stone", at: [3, 64, 0] as const }];
    const bare = createHarness({ blocks });
    await assert.rejects(bare.run(gatherer.gather, { blocks: "stone", count: 1 }), /needs one of: .*wooden_pickaxe/);
    const tooled = createHarness({ blocks, inventory: { wooden_pickaxe: 1 } });
    const result = await tooled.run(gatherer.gather, { blocks: "stone", count: 1 });
    assert.equal(result.dug, 1);
    assert.equal(tooled.count("cobblestone"), 1);
    assert.equal(tooled.bot.heldItem?.name, "wooden_pickaxe");
  });

  it("fails a gather when nothing matches in reach, naming the pattern", async () => {
    const h = createHarness();
    await assert.rejects(h.run(gatherer.gather, { blocks: "*_log", count: 1, radius: 16 }), /no reachable "\*_log" within 16 blocks/);
  });
});

describe("minebot-sdk/testing world and inventory", () => {
  it("digs, drops, and places: the placed block spends the held item and takes the dug block's place", async () => {
    const h = createHarness({ blocks: [{ name: "dirt", at: [1, 64, 0] }], inventory: { cobblestone: 2 } });
    await h.run(dig.dig, { at: [1, 64, 0] });
    assert.equal(h.blockAt([1, 64, 0]).name, "air");
    assert.equal(h.count("dirt"), 1, "the bot stands within pickup range of the drop");
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([1, 64, 0]).name, "cobblestone");
    assert.equal(h.count("cobblestone"), 1);
    assert.equal(await h.run(place.place, { at: [1, 64, 0], item: "cobblestone" }), false);
  });

  it("limits digging to the player's reach", async () => {
    const h = createHarness({ blocks: [{ name: "dirt", at: [9, 64, 0] }] });
    await assert.rejects(h.run(dig.dig, { at: [9, 64, 0] }), /dirt at .* is out of reach/);
  });

  it("finds blocks nearest first and walks within range of a position", async () => {
    const h = createHarness({ blocks: [{ name: "coal_ore", at: [10, 64, 0] }, { name: "coal_ore", at: [3, 64, 3] }] });
    assert.deepEqual(await h.run(sense.find, { blocks: "coal_ore" }), [{ x: 3, y: 64, z: 3 }, { x: 10, y: 64, z: 0 }]);
    const stood = await h.run(move.to, { position: [10, 64, 0], range: 2 });
    assert.ok(Math.hypot(stood.x - 10, stood.z) <= 2);
    assert.equal(stood.y, 64);
  });

  it("holds, wears, and tosses items", async () => {
    const h = createHarness({ inventory: { stick: 3, iron_helmet: 1, diamond_helmet: 1 }, equipment: { head: "iron_helmet" } });
    assert.deepEqual(await h.run(survival.armor), { equipped: { head: "diamond_helmet" }, wearing: { head: "diamond_helmet", torso: null, legs: null, feet: null } });
    assert.equal(h.inventory.iron_helmet, 1, "the displaced helmet is back in the inventory");
    await h.run(inventory.equip, { item: "stick" });
    assert.equal(h.bot.heldItem?.name, "stick");
    await h.run(inventory.toss, { item: "stick", count: 2 });
    assert.equal(h.count("stick"), 1);
    assert.equal(h.entities.filter((e) => e.name === "item").length, 1);
  });

  it("reports recipes from the real registry, and drops lying on the ground", async () => {
    const h = createHarness({ entities: [{ name: "item", item: "stick", at: [2.5, 64, 0.5] }] });
    const [recipe] = await h.run(items.recipes, { item: "stick" });
    assert.equal(recipe?.makes, 4);
    assert.deepEqual(await h.run(items.drops, { radius: 4 }), [{ x: 2, y: 64, z: 0 }]);
  });

  it("cooks at a furnace on the clock: fuel burns for its real time and the output appears", async () => {
    const h = createHarness({ blocks: [{ name: "furnace", at: [1, 64, 0], properties: { lit: false } }], inventory: { raw_iron: 2, coal: 1 } });
    const smelted = await h.run(furnace.smelt, { item: "raw_iron", count: 2 });
    assert.deepEqual({ output: smelted.output, count: smelted.count, fuel: smelted.fuel }, { output: "iron_ingot", count: 2, fuel: { coal: 1 } });
    assert.equal(h.count("iron_ingot"), 2);
    assert.equal(h.count("raw_iron"), 0);
    assert.ok(h.bot.time.age >= 2 * 200, "two items took at least 400 ticks on the clock");
    assert.equal(h.blockAt([1, 64, 0]).getProperties().lit, true, "coal still burns after the batch");
  });
});

describe("minebot-sdk/testing framework", () => {
  it("validates arguments and results, and names the call that failed", async () => {
    const h = createHarness();
    await assert.rejects(h.run((ctx) => brawler.chatty(ctx, {} as never)), /routine "brawler\.chatty" arguments:[\s\S]*message/);
    assert.deepEqual(await h.run(brawler.chatty, { message: "hi" }), { held: null });
    assert.deepEqual(h.chat, ["hi"]);
    await assert.rejects(h.run((ctx) => brawler.bad(ctx)), /routine "brawler\.bad" returned a value that does not match its returns schema/);
  });

  it("fails a routine that calls an unsupported Mineflayer API with a clear error", async () => {
    const h = createHarness({ entities: [{ name: "cow", at: [3, 64, 0] }], blocks: [{ name: "red_bed", at: [1, 64, 0] }], time: 13000 });
    await assert.rejects(h.run(brawler.hit), (err: unknown) => {
      assert.ok(err instanceof UnsupportedApiError);
      assert.equal(err.message, "not supported by minebot-sdk/testing: bot.attack");
      return true;
    });
    await assert.rejects(h.run(brawler.look), /not supported by minebot-sdk\/testing: bot\.world\.raycast/);
    await assert.rejects(h.run(survival.sleep, {}), /not supported by minebot-sdk\/testing: bot\.sleep/);
    await assert.rejects(h.run(container.list, { at: [1, 64, 0] }), /no container at|not supported by minebot-sdk\/testing: bot\.openContainer/);
  });

  it("records every routine call, nested ones with the arguments the caller passed", async () => {
    const h = createHarness({ inventory: { oak_planks: 4 } });
    await h.run(crafter.make, { item: "crafting_table" });
    assert.deepEqual(h.calls[0], { kit: "crafter", action: "make", args: { item: "crafting_table" } });
    assert.ok(h.calls.some((c) => c.kit === "craft" && c.action === "craft" && c.args instanceof Object && "item" in c.args && c.args.item === "crafting_table"));
    assert.deepEqual(new Set(h.calls.map((c) => c.kit)), new Set(["crafter", "inventory", "craft"]));
  });
});

/** Routines that wait on the clock or reach for a table, the way polling and crafting routines do. */
const waiter = {
  hungry: defineRoutine({ name: "waiter.hungry", description: "Waits for food that never comes, under a 50 ms limit.", args: z.object({}) }, (ctx) =>
    within(
      50,
      "waiting for food",
      (async () => {
        while (ctx.bot.food < 20) await ctx.sleep(1000);
      })(),
      () => {},
    ),
  ),
  forever: defineRoutine({ name: "waiter.forever", description: "Sleeps until it is aborted.", args: z.object({}) }, async (ctx) => {
    for (;;) await ctx.sleep(100);
  }),
  craftFar: defineRoutine({ name: "waiter.craftFar", description: "Finds a crafting table within 32 blocks and crafts a wooden pickaxe there without walking.", args: z.object({}) }, async (ctx) => {
    const recipe = ctx.bot.recipesFor(ctx.bot.registry.itemsByName.wooden_pickaxe!.id, null, 1, true)[0]!;
    const table = ctx.bot.findBlock({ matching: ctx.bot.registry.blocksByName.crafting_table!.id, maxDistance: 32 });
    await ctx.bot.craft(recipe, 1, table ?? undefined);
  }),
};

describe("minebot-sdk/testing matches Mineflayer where routines can tell", () => {
  // The real timers here are the point: `within` and the abort timer can only fire if ctx.sleep yields a macrotask, which no fake clock shows.
  it("lets timers fire while a routine polls with ctx.sleep, so within and a timed abort work", { timeout: 5_000 }, async () => {
    const h = createHarness({ food: 10 });
    await assert.rejects(h.run(waiter.hungry), /waiting for food took longer than 50 ms/);
    const pending = assert.rejects(h.run(waiter.forever), /stop now/);
    setTimeout(() => h.abort(new Error("stop now")), 20);
    await pending;
  });

  it("finds a stand spot beyond 12 blocks for a GoalInvert, so combat.retreat works at any distance", async () => {
    const h = createHarness();
    const far = await h.run(combat.retreat, { from: [0, 64, 0], distance: 20 });
    assert.ok(far.distance > 20, `stopped ${far.distance} blocks away`);
    assert.ok(Math.hypot(h.position.x, h.position.z) > 20);
  });

  it("requires the crafting table to be within reach, as the server does", async () => {
    const supplies = { oak_planks: 3, stick: 2 };
    const far = createHarness({ inventory: supplies, blocks: [{ name: "crafting_table", at: [12, 64, 0] }] });
    await assert.rejects(far.run(waiter.craftFar), /crafting_table at .* is out of reach/);
    assert.equal(far.count("wooden_pickaxe"), 0);
    const near = createHarness({ inventory: supplies, blocks: [{ name: "crafting_table", at: [2, 64, 0] }] });
    await near.run(waiter.craftFar);
    assert.equal(near.count("wooden_pickaxe"), 1);
  });

  it("tosses one item for a null count, as Mineflayer does", async () => {
    const h = createHarness({ inventory: { stick: 5 } });
    await h.bot.toss(h.bot.registry.itemsByName.stick!.id, null, null);
    assert.equal(h.count("stick"), 4);
    assert.equal(h.entities.filter((e) => e.name === "item").length, 1);
  });

  it("drops the crop item for ripe wheat and beetroots, a bed's head, and nothing for a dead bush", async () => {
    const h = createHarness({
      blocks: [
        { name: "wheat", at: [1, 64, 0], properties: { age: 7 } },
        { name: "wheat", at: [0, 64, 1], properties: { age: 3 } },
        { name: "beetroots", at: [-1, 64, 0], properties: { age: 3 } },
      ],
    });
    for (const at of [[1, 64, 0], [0, 64, 1], [-1, 64, 0]] as const) await h.bot.dig(h.blockAt(at));
    assert.deepEqual(h.inventory, { wheat: 1, wheat_seeds: 2, beetroot: 1, beetroot_seeds: 1 });
    const bed = createHarness({
      blocks: [
        { name: "red_bed", at: [1, 64, 0], properties: { part: "head" } },
        { name: "red_bed", at: [-1, 64, 0], properties: { part: "foot" } },
        { name: "dead_bush", at: [0, 64, 1] },
      ],
    });
    for (const at of [[1, 64, 0], [-1, 64, 0], [0, 64, 1]] as const) await bed.bot.dig(bed.blockAt(at));
    assert.deepEqual(bed.inventory, { red_bed: 1 });
  });

  it("reports setGoal's arrival on a later turn and drops a reached goal", { timeout: 2_000 }, async () => {
    const h = createHarness();
    h.bot.pathfinder.setGoal(new goals.GoalNear(5, 64, 0, 1));
    await new Promise<void>((resolve) => h.bot.once("goal_reached", () => resolve()));
    assert.equal(h.bot.pathfinder.goal, null);
    assert.ok(h.position.distanceTo(new Vec3(5, 64, 0)) <= 1.5);
  });

  it("searches blocks like findBlocks: floored point, || defaults, extra-info filter, palette check", () => {
    const id = (name: string) => createHarness().bot.registry.blocksByName[name]!.id;
    const h = createHarness({
      blocks: [
        { name: "diamond_ore", at: [16, 64, 0] },
        { name: "diamond_ore", at: [-16, 64, 0] },
        { name: "diamond_ore", at: [0, 66, 4] },
      ],
    });
    // The bot stands at 0.5, 64, 0.5; Mineflayer measures from the floored point (0, 64, 0).
    assert.equal(h.bot.findBlocks({ matching: id("diamond_ore"), maxDistance: 16, count: 10 }).length, 3);
    assert.equal(h.bot.findBlocks({ matching: id("diamond_ore"), maxDistance: 16, count: 0 }).length, 1, "count 0 reads as the default 1");
    assert.equal(h.bot.findBlocks({ matching: id("diamond_ore"), maxDistance: 0, count: 10 }).length, 3, "maxDistance 0 reads as the default 16");
    const high = h.bot.findBlocks({ matching: id("diamond_ore"), count: 10, useExtraInfo: (block) => block.position.y > 65 });
    assert.deepEqual(high.map(String), ["(0, 66, 4)"]);
    assert.deepEqual(h.bot.findBlocks({ matching: (block) => block.name === "diamond_ore", count: 1 }).map(String), ["(0, 66, 4)"]);
    // A predicate is first asked about palette blocks, which have no position, as in Mineflayer.
    assert.throws(() => h.bot.findBlocks({ matching: (block) => block.position.y > 60 }), TypeError);
  });

  it("gives data members their idle values and makes the rest of the inventory strict", () => {
    const h = createHarness({ inventory: { stick: 2 } });
    assert.equal(h.bot.quickBarSlot, 0);
    assert.equal(h.bot.currentWindow, null);
    assert.equal(h.bot.targetDigBlock, null);
    assert.equal(h.bot.usingHeldItem, false);
    assert.equal(Reflect.get(h.bot, "isAlive"), true);
    assert.equal(h.bot.inventory.emptySlotCount(), 35);
    assert.equal(h.bot.inventory.selectedItem, null);
    // A named const: reading a member the harness lacks gives a function that throws when called.
    const containerItems: unknown = Reflect.get(h.bot.inventory, "containerItems");
    assert.throws(() => Reflect.apply(containerItems as () => void, undefined, []), /not supported by minebot-sdk\/testing: bot\.inventory\.containerItems/);
    assert.equal(h.bot.time.day, 0);
    h.advance(48_000);
    assert.equal(h.bot.time.day, 2);
  });

  it("puts the bot on the ground layer it was given", () => {
    const h = createHarness({ ground: { y: 70, name: "dirt" } });
    assert.equal(h.position.y, 71);
    assert.equal(h.blockAt([0, 70, 0]).name, "dirt");
    assert.equal(createHarness().position.y, 64);
  });

  it("refuses to place a block into the bot's own cell, and the place routine steps out first", async () => {
    const h = createHarness({ inventory: { cobblestone: 2 } });
    await h.run(inventory.equip, { item: "cobblestone" });
    await assert.rejects(h.bot.placeBlock(h.blockAt([0, 63, 0]), new Vec3(0, 1, 0)), /cannot place cobblestone at .*stands there/);
    assert.equal(h.blockAt([0, 64, 0]).name, "air");
    assert.equal(await h.run(place.place, { at: [0, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([0, 64, 0]).name, "cobblestone");
    assert.ok(!h.position.floored().equals(new Vec3(0, 64, 0)));
  });

  it("updates an open furnace window as it burns, with fuel as a fraction of the fuel item", async () => {
    const h = createHarness({ blocks: [{ name: "furnace", at: [1, 64, 0], properties: { lit: false } }], inventory: { raw_iron: 1, coal: 1 } });
    const window = await h.bot.openFurnace(h.blockAt([1, 64, 0]));
    await window.putInput(h.bot.registry.itemsByName.raw_iron!.id, null, 1);
    await window.putFuel(h.bot.registry.itemsByName.coal!.id, null, 1);
    let updates = 0;
    window.on("update", () => updates++);
    h.advance(20);
    assert.ok(updates > 0, "the window announced the burn");
    assert.equal(Reflect.get(window, "totalFuel"), 1600);
    assert.ok(window.fuel > 0.98 && window.fuel < 1, `fuel ${window.fuel}`);
    assert.equal(window.fuelItem(), null, "the coal is burning, not in the slot, and fuel still reads above zero");
  });
});

/** The outcome of a promise, as data: what a caller of `invokeRoutine` or `h.run` can tell apart. */
async function outcome(promise: Promise<unknown>): Promise<{ value: unknown } | { error: string }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe("minebot-sdk/testing routines", () => {
  const labelled = defineRoutine({ args: z.object({ n: z.number().default(3), label: z.string() }), returns: z.string() }, (_ctx, args) => `${args.label}:${args.n}`);
  const strict = defineRoutine({ returns: z.object({ ok: z.boolean() }) }, (() => ({ ok: "yes" })) as never);
  const parsed = defineRoutine({ returns: z.object({ n: z.string().transform(Number) }) }, () => ({ n: "42" }));
  const echo = (_ctx: unknown, args: unknown) => args;
  const defaulted = defineRoutine({ args: z.object({ n: z.number().default(3) }) }, (_ctx, args) => args.n);

  // The reference the harness has to match: the body's own `invokeRoutine`, over the same module and arguments.
  const cases: [string, unknown, unknown, RegExp | unknown][] = [
    ["defaults applied", labelled, { label: "x" }, "x:3"],
    ["an argument that does not match", labelled, { label: "x", n: "one" }, /^routine "under test" arguments: .*\nargs schema: .*"type":"number"/s],
    ["no arguments for an object schema", labelled, undefined, /^routine "under test" arguments: /],
    ["no arguments for a schema with defaults", defaulted, undefined, 3],
    ["no arguments for a plain function", echo, undefined, {}],
    ["a result that does not match", strict, undefined, /^routine "under test" returned a value that does not match its returns schema: .*"type":"boolean"/s],
    ["a parsed result", parsed, undefined, { n: 42 }],
    ["a plain function", echo, { a: [1] }, { a: [1] }],
    ["a module namespace", { default: labelled }, { label: "y", n: 1 }, "y:1"],
    ["a module namespace of a plain function", { default: echo, other: 1 }, "as given", "as given"],
    ["a routine that throws", () => Promise.reject(new Error("no luck")), undefined, /^no luck$/],
    ["a default export that is not a function", { default: 5 }, undefined, /^routine "under test" must default-export a function \(ctx, args\) => result; its default export is of type number$/],
    ["a module without a default export", { helper: 1 }, undefined, /^routine "under test" must default-export a function .*it has no default export \(it exports: helper\)$/],
    ["no module", null, undefined, /^routine "under test" must default-export a function .*the module is null$/],
  ];

  for (const [name, routine, args, expected] of cases) {
    it(`resolves and rejects as invokeRoutine does: ${name}`, async () => {
      const h = createHarness();
      const ran = await outcome(h.run(routine as never, args as never));
      const reference = await outcome(invokeRoutine(typeof routine === "function" ? { default: routine } : routine, "under test", { bot: h.bot } as never, args));
      assert.deepEqual(ran, reference);
      if (expected instanceof RegExp) {
        assert.ok("error" in ran, `expected a rejection, got ${JSON.stringify(ran)}`);
        assert.match(ran.error, expected);
      } else {
        assert.deepEqual(ran, { value: expected });
      }
    });
  }

  it("gives a routine exactly the context members, and the routines it calls run with the run's scope", async () => {
    const signals: AbortSignal[] = [];
    const probe = defineRoutine({ name: "probe.look", description: "Records the signal.", args: z.object({}) }, (ctx) => void signals.push(ctx.signal));
    const h = createHarness({ inventory: { oak_log: 1 } });
    const seen = await h.run(async (ctx) => {
      await probe(ctx);
      return { keys: Object.keys(ctx).sort(), bot: ctx.bot === h.bot, nestedSignal: signals[0] === ctx.signal, signal: ctx.signal.aborted };
    });
    assert.deepEqual(seen, { keys: ["bot", "log", "notes", "on", "signal", "sleep", "status", "store", "wiki"], bot: true, nestedSignal: true, signal: false });
    // The nested routine ran with that run's signal, which ended with the run.
    assert.deepEqual([signals[0]!.aborted, String(signals[0]!.reason)], [true, "Error: finished"]);
    assert.equal(await h.run((ctx) => crafter.make(ctx, { item: "oak_planks" })), 4);
    assert.deepEqual(h.calls[1], { kit: "crafter", action: "make", args: { item: "oak_planks" } });
    assert.equal(h.count("oak_planks"), 4);
  });

  it("lands a routine's log lines in h.logs as the body's run log writes them, with those of the routines it calls", async () => {
    const announcer = defineRoutine({ name: "announcer.shout", description: "Logs a line.", args: z.object({}) }, (ctx) => ctx.log("nested says", { from: "announcer" }));
    const h = createHarness();
    const talk = (ctx: { log(...args: unknown[]): void }) => {
      ctx.log("routine says", 1, { a: 2 });
      ctx.log({ deep: { er: { than: { three: { levels: [1, 2] } } } }, list: ["x"] });
      ctx.log("plain", null, undefined, 3n);
    };
    // The body's reference: the same routine run by ProgramRunner.call.
    const body = await new ProgramRunner({ globals: () => ({}) }).call(async (scope) => talk(scope), { sourceDir: "/" });
    assert.equal(body.status, "ok");
    await h.run(async (ctx) => {
      talk(ctx);
      await announcer(ctx);
    });
    assert.deepEqual(h.logs.slice(0, 3), body.logs.split("\n"));
    assert.deepEqual(h.logs, ["routine says 1 { a: 2 }", "{ deep: { er: { than: { three: [Object] } } }, list: [ 'x' ] }", "plain null undefined 3n", "nested says { from: 'announcer' }"]);
  });

  it("passes the clock when a routine sleeps, rejects its sleep once the harness aborts, and starts the next run unaborted", async () => {
    const h = createHarness({ time: 1000 });
    await h.run((ctx) => ctx.sleep(1000));
    assert.equal(h.bot.time.timeOfDay, 1020);
    const stopping = new Error("stop now");
    let sleeps = 0;
    await assert.rejects(
      h.run(async (ctx) => {
        assert.equal(ctx.signal.aborted, false);
        for (;;) {
          if (++sleeps === 3) h.abort(stopping);
          await ctx.sleep(50);
        }
      }),
      /stop now/,
    );
    assert.equal(sleeps, 3);
    // The abort stopped that run only: the next one has a signal and a clock of its own, and built-in routines still run.
    assert.deepEqual(await h.run(async (ctx) => [ctx.signal.aborted, await ctx.sleep(50), ctx.signal.aborted]), [false, undefined, false]);
    await h.run(move.to, { position: [3, 64, 0], range: 2 });
  });

  it("ends a run's signal and sleep when the call settles, as the body's runner does", async () => {
    const h = createHarness();
    const ended = await h.run((ctx) => ctx);
    const scopes: { sleep: (ms: number) => Promise<void>; signal: AbortSignal }[] = [];
    await new ProgramRunner({ globals: () => ({}) }).call(async (scope) => void scopes.push(scope), { sourceDir: "/" });
    const body = scopes[0]!;
    assert.deepEqual([ended.signal.aborted, String(ended.signal.reason)], [body.signal.aborted, String(body.signal.reason)]);
    assert.deepEqual(await outcome(ended.sleep(10)), await outcome(body.sleep(10)));
    assert.deepEqual(await outcome(ended.sleep(10)), { error: "finished" });
  });

  it("keeps notes in memory, newest change first, per harness, under the body's key and text rules", async () => {
    const h = createHarness();
    const listed = await h.run((ctx) => {
      assert.equal(ctx.notes.get("plan"), undefined);
      const a = ctx.notes.set("plan", "mine");
      ctx.notes.set("base", "at 0 0");
      ctx.notes.set("plan", "mine, then smelt");
      assert.deepEqual(Object.keys(a).sort(), ["key", "text", "updated"]);
      assert.equal(Number.isNaN(Date.parse(a.updated)), false);
      assert.throws(() => ctx.notes.set("Bad Key", "x"));
      assert.throws(() => ctx.notes.set("empty", ""));
      return ctx.notes.list().map((note) => [note.key, note.text]);
    });
    assert.deepEqual(listed, [["plan", "mine, then smelt"], ["base", "at 0 0"]]);
    // Notes belong to the harness, not to one run; deleting reports whether the note existed.
    assert.deepEqual(await h.run((ctx) => [ctx.notes.get("base"), ctx.notes.delete("base"), ctx.notes.delete("base"), ctx.notes.list().length]), ["at 0 0", true, false, 1]);
    assert.equal(await createHarness().run((ctx) => ctx.notes.get("plan")), undefined);
    await assert.rejects(
      h.run((ctx) => {
        for (let i = 0; i < 201; i++) ctx.notes.set(`n${i}`, "x");
      }),
      /a body keeps at most 200 notes/,
    );
  });

  it("delivers the bot's events to a run's ctx.on handlers during the run only", async () => {
    const h = createHarness();
    const heard: string[] = [];
    const listening = h.bot.listenerCount("chat");
    await h.run(async (ctx) => {
      ctx.on("chat", (_user, text) => heard.push(String(text)));
      h.bot.emit("chat" as never, "someone" as never, "during" as never);
      await ctx.sleep(50);
    });
    await h.run(async (ctx) => ctx.on("chat", (_user, text) => heard.push(`second ${String(text)}`)));
    h.bot.emit("chat" as never, "someone" as never, "after both runs" as never);
    assert.deepEqual(heard, ["during"]);
    assert.equal(h.bot.listenerCount("chat"), listening);
    // An abort ends the subscriptions at once, before the routine itself settles.
    await assert.rejects(
      h.run(async (ctx) => {
        ctx.on("chat", (_user, text) => heard.push(String(text)));
        h.bot.emit("chat" as never, "someone" as never, "before the abort" as never);
        h.abort(new Error("stop"));
        h.bot.emit("chat" as never, "someone" as never, "after the abort" as never);
        await ctx.sleep(50);
      }),
      /stop/,
    );
    // A context kept past its run subscribes nothing.
    const ended = await h.run((ctx) => ctx);
    ended.on("chat", (_user, text) => heard.push(String(text)));
    h.bot.emit("chat" as never, "someone" as never, "to a finished run" as never);
    assert.deepEqual(heard, ["during", "before the abort"]);
    assert.equal(h.bot.listenerCount("chat"), listening);
  });

  it("keeps one set of notes rules: the harness's notes answer as the body's Notes do, limit included", async () => {
    // One frozen instant: every note has the same `updated`, so the order is the rules' own, not the clock's.
    mock.timers.enable({ apis: ["Date"], now: 0 });
    try {
      const script = (notes: { list(): unknown; get(key: string): unknown; set(key: string, text: string): unknown; delete(key: string): unknown }) => {
        const results: unknown[] = [];
        const step = (run: () => unknown) => {
          try {
            results.push({ value: run() });
          } catch (error) {
            results.push({ error: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error) });
          }
        };
        step(() => notes.set("a", "first"));
        step(() => notes.set("b", "second"));
        step(() => notes.list());
        step(() => notes.set("a", "first again"));
        step(() => notes.list());
        step(() => notes.get("a"));
        step(() => notes.get("missing"));
        step(() => notes.delete("b"));
        step(() => notes.delete("b"));
        step(() => notes.set("Bad Key", "x"));
        step(() => notes.set("empty", ""));
        step(() => notes.set("long", "x".repeat(8001)));
        for (let i = 0; i < 199; i++) notes.set(`n${i}`, "x");
        step(() => notes.set("one-too-many", "x"));
        step(() => notes.set("a", "replacing at the limit"));
        step(() => notes.list());
        return results;
      };
      const host = new Notes(JsonStore.memory());
      const body = script({ list: () => host.list(), get: (key) => host.get(key)?.text, set: (key, text) => host.set(key, text), delete: (key) => host.delete(key) });
      const harness = await createHarness().run((ctx) => script(ctx.notes));
      assert.deepEqual(harness, body);
      assert.deepEqual(body[12], { error: "NoteLimitError: a body keeps at most 200 notes; delete or merge some first" });
    } finally {
      mock.timers.reset();
    }
  });

  it("makes status and wiki unsupported, naming the member", async () => {
    const h = createHarness();
    const reasons = await h.run((ctx) => {
      const reached: unknown[] = [];
      for (const use of [() => ctx.status(), () => ctx.wiki!.search("iron"), () => ctx.wiki!.read("x"), () => ctx.wiki!.list()]) {
        try {
          use();
        } catch (error) {
          reached.push(error instanceof UnsupportedApiError ? error.api : error);
        }
      }
      return reached;
    });
    assert.deepEqual(reasons, ["ctx.status", "ctx.wiki.search", "ctx.wiki.read", "ctx.wiki.list"]);
    await assert.rejects(h.run((ctx) => ctx.status()), /not supported by minebot-sdk\/testing: ctx\.status/);
  });

  it("types a defineRoutine value's arguments and result through h.run", async () => {
    const h = createHarness();
    const text: string = await h.run(labelled, { label: "a" });
    assert.equal(text, "a:3");
    const n: number = (await h.run(parsed)).n;
    assert.equal(n, 42);
    const five: number = await h.run(async () => 5);
    assert.equal(five, 5);
    const plain: number = await h.run(async (_ctx, args: { n: number }) => args.n + 1, { n: 1 });
    assert.equal(plain, 2);
    const fromModule: number = await h.run({ default: async (_ctx: unknown, args: { n: number }) => args.n * 2 }, { n: 4 });
    assert.equal(fromModule, 8);
    // Never executed: the compiler is the test.
    const compileOnly = async () => {
      // @ts-expect-error `label` is required
      await h.run(labelled, { n: 1 });
      // @ts-expect-error `n` is a number
      await h.run(labelled, { label: "a", n: "one" });
      // @ts-expect-error the parsed result's `n` is a number
      const wrong: string = (await h.run(parsed)).n;
      // @ts-expect-error the argument is a number
      await h.run(async (_ctx, args: { n: number }) => args.n, { n: "1" });
      return wrong;
    };
    assert.equal(typeof compileOnly, "function");
  });
});
