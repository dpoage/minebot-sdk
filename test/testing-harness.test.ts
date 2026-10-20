import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { action, defineKit, goals, Vec3, z } from "minebot-sdk/kit";
import { createKitHarness, UnsupportedApiError } from "minebot-sdk/testing";

/** A kit whose actions reach for Mineflayer APIs the harness does not implement. */
const brawler = defineKit(
  { name: "brawler", description: "Reaches for APIs the harness lacks." },
  {
    hit: action({ doc: "Attacks the nearest entity.", args: z.object({}), run: (ctx) => ctx.bot.attack(Object.values(ctx.bot.entities)[0]!) }),
    look: action({ doc: "Raycasts.", args: z.object({}), run: (ctx) => ctx.bot.world.raycast(ctx.bot.entity.position, ctx.bot.entity.position, 4) }),
    chatty: action({
      doc: "Talks, then reports the held item.",
      args: z.object({ message: z.string() }),
      returns: z.object({ held: z.string().nullable() }),
      run: (ctx, { message }) => {
        ctx.bot.chat(message);
        return { held: ctx.bot.heldItem?.name ?? null };
      },
    }),
    bad: action({ doc: "Returns the wrong shape.", args: z.object({}), returns: z.object({ n: z.number() }), run: () => ({ n: "one" }) as never }),
  },
);

describe("minebot-sdk/testing crafting and gathering", () => {
  it("crafts a wooden pickaxe from 7 logs: the table's planks come first, and the table gets placed", async () => {
    const h = createKitHarness({ inventory: { oak_log: 7 } });
    assert.equal(await h.kit.crafter.make({ item: "wooden_pickaxe" }), 1);
    assert.equal(h.count("wooden_pickaxe"), 1);
    assert.equal(h.count("crafting_table"), 0);
    const table = h.bot.findBlock({ matching: h.bot.registry.blocksByName.crafting_table!.id, maxDistance: 8 });
    assert.equal(table?.name, "crafting_table");
  });

  it("refuses to craft at a table that is not there", async () => {
    const h = createKitHarness({ inventory: { oak_planks: 4, stick: 2 } });
    await assert.rejects(h.call("craft.craft", { item: "wooden_pickaxe" }), /needs a crafting table within 4 blocks/);
  });

  it("gathers logs by walking to them, digging them, and picking up the drops", async () => {
    const h = createKitHarness({ blocks: [{ name: "oak_log", from: [8, 64, 0], to: [8, 67, 0] }] });
    const result = await h.call<{ dug: number; gained: Record<string, number>; skipped: number }>("gatherer.gather", { blocks: "*_log", count: 2 });
    assert.deepEqual(result, { dug: 2, gained: { oak_log: 2 }, skipped: 0 });
    assert.equal(h.count("oak_log"), 2);
    assert.equal(h.blockAt([8, 64, 0]).name, "air");
    assert.equal(h.blockAt([8, 67, 0]).name, "oak_log");
    assert.ok(h.position.distanceTo(h.blockAt([8, 64, 0]).position) < 8, "the bot walked to the trunk");
  });

  it("gathers stone only with a pickaxe, and the tool is chosen from the inventory", async () => {
    const blocks = [{ name: "stone", at: [3, 64, 0] as const }];
    const bare = createKitHarness({ blocks });
    await assert.rejects(bare.call("gatherer.gather", { blocks: "stone", count: 1 }), /needs one of: .*wooden_pickaxe/);
    const tooled = createKitHarness({ blocks, inventory: { wooden_pickaxe: 1 } });
    const result = await tooled.call<{ dug: number }>("gatherer.gather", { blocks: "stone", count: 1 });
    assert.equal(result.dug, 1);
    assert.equal(tooled.count("cobblestone"), 1);
    assert.equal(tooled.bot.heldItem?.name, "wooden_pickaxe");
  });

  it("fails a gather when nothing matches in reach, naming the pattern", async () => {
    const h = createKitHarness();
    await assert.rejects(h.call("gatherer.gather", { blocks: "*_log", count: 1, radius: 16 }), /no reachable "\*_log" within 16 blocks/);
  });
});

describe("minebot-sdk/testing world and inventory", () => {
  it("digs, drops, and places: the placed block spends the held item and takes the dug block's place", async () => {
    const h = createKitHarness({ blocks: [{ name: "dirt", at: [1, 64, 0] }], inventory: { cobblestone: 2 } });
    await h.call("dig.dig", { at: [1, 64, 0] });
    assert.equal(h.blockAt([1, 64, 0]).name, "air");
    assert.equal(h.count("dirt"), 1, "the bot stands within pickup range of the drop");
    assert.equal(await h.call("place.place", { at: [1, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([1, 64, 0]).name, "cobblestone");
    assert.equal(h.count("cobblestone"), 1);
    assert.equal(await h.call("place.place", { at: [1, 64, 0], item: "cobblestone" }), false);
  });

  it("limits digging to the player's reach", async () => {
    const h = createKitHarness({ blocks: [{ name: "dirt", at: [9, 64, 0] }] });
    await assert.rejects(h.call("dig.dig", { at: [9, 64, 0] }), /dirt at .* is out of reach/);
  });

  it("finds blocks nearest first and walks within range of a position", async () => {
    const h = createKitHarness({ blocks: [{ name: "coal_ore", at: [10, 64, 0] }, { name: "coal_ore", at: [3, 64, 3] }] });
    assert.deepEqual(await h.call("sense.find", { blocks: "coal_ore" }), [{ x: 3, y: 64, z: 3 }, { x: 10, y: 64, z: 0 }]);
    const stood = await h.call<{ x: number; y: number; z: number }>("move.to", { position: [10, 64, 0], range: 2 });
    assert.ok(Math.hypot(stood.x - 10, stood.z) <= 2);
    assert.equal(stood.y, 64);
  });

  it("holds, wears, and tosses items", async () => {
    const h = createKitHarness({ inventory: { stick: 3, iron_helmet: 1, diamond_helmet: 1 }, equipment: { head: "iron_helmet" } });
    assert.deepEqual(await h.call("survival.armor"), { equipped: { head: "diamond_helmet" }, wearing: { head: "diamond_helmet", torso: null, legs: null, feet: null } });
    assert.equal(h.inventory.iron_helmet, 1, "the displaced helmet is back in the inventory");
    await h.call("inventory.equip", { item: "stick" });
    assert.equal(h.bot.heldItem?.name, "stick");
    await h.call("inventory.toss", { item: "stick", count: 2 });
    assert.equal(h.count("stick"), 1);
    assert.equal(h.entities.filter((e) => e.name === "item").length, 1);
  });

  it("reports recipes from the real registry, and drops lying on the ground", async () => {
    const h = createKitHarness({ entities: [{ name: "item", item: "stick", at: [2.5, 64, 0.5] }] });
    const [recipe] = await h.call<{ makes: number; ingredients: Record<string, number> }[]>("items.recipes", { item: "stick" });
    assert.equal(recipe?.makes, 4);
    assert.deepEqual(await h.call("items.drops", { radius: 4 }), [{ x: 2, y: 64, z: 0 }]);
  });

  it("cooks at a furnace on the clock: fuel burns for its real time and the output appears", async () => {
    const h = createKitHarness({ blocks: [{ name: "furnace", at: [1, 64, 0], properties: { lit: false } }], inventory: { raw_iron: 2, coal: 1 } });
    const smelted = await h.call<{ output: string; count: number; fuel: Record<string, number> }>("furnace.smelt", { item: "raw_iron", count: 2 });
    assert.deepEqual({ output: smelted.output, count: smelted.count, fuel: smelted.fuel }, { output: "iron_ingot", count: 2, fuel: { coal: 1 } });
    assert.equal(h.count("iron_ingot"), 2);
    assert.equal(h.count("raw_iron"), 0);
    assert.ok(h.bot.time.age >= 2 * 200, "two items took at least 400 ticks on the clock");
    assert.equal(h.blockAt([1, 64, 0]).getProperties().lit, true, "coal still burns after the batch");
  });
});

describe("minebot-sdk/testing framework", () => {
  it("validates arguments and results, and names the call that failed", async () => {
    const h = createKitHarness({ kits: [brawler] });
    await assert.rejects(h.call("brawler.chatty", {}), /kit\.brawler\.chatty arguments:[\s\S]*message/);
    assert.deepEqual(await h.call("brawler.chatty", { message: "hi" }), { held: null });
    assert.deepEqual(h.chat, ["hi"]);
    await assert.rejects(h.call("brawler.bad"), /kit\.brawler\.bad returned a value that does not match its returns schema/);
  });

  it("fails an action that calls an unsupported Mineflayer API with a clear error", async () => {
    const h = createKitHarness({ kits: [brawler], entities: [{ name: "cow", at: [3, 64, 0] }], blocks: [{ name: "red_bed", at: [1, 64, 0] }], time: 13000 });
    await assert.rejects(h.call("brawler.hit"), (err: unknown) => {
      assert.ok(err instanceof UnsupportedApiError);
      assert.equal(err.message, "not supported by minebot-sdk/testing: bot.attack");
      return true;
    });
    await assert.rejects(h.call("brawler.look"), /not supported by minebot-sdk\/testing: bot\.world\.raycast/);
    await assert.rejects(h.call("survival.sleep", {}), /not supported by minebot-sdk\/testing: bot\.sleep/);
    await assert.rejects(h.call("container.list", { at: [1, 64, 0] }), /no container at|not supported by minebot-sdk\/testing: bot\.openContainer/);
  });

  it("runs the real kit host: unknown kits, inactive kits, uses, and the signal", async () => {
    const h = createKitHarness({ kits: [brawler], active: ["move"] });
    await assert.rejects(h.call("nope.act"), /no kit "nope" is offered/);
    await assert.rejects(h.call("brawler.chatty", { message: "x" }), /"brawler" kit is not active/);
    h.host.use(["brawler"]);
    await h.call("brawler.chatty", { message: "x" });
    h.host.use(["gatherer"]);
    h.abort(new Error("stop now"));
    await assert.rejects(h.call("gatherer.collectDrops", {}), /stop now/);
  });

  it("records every action call, nested ones with the arguments the caller passed", async () => {
    const h = createKitHarness({ inventory: { oak_planks: 4 } });
    await h.call("crafter.make", { item: "crafting_table" });
    assert.deepEqual(h.calls[0], { kit: "crafter", action: "make", args: { item: "crafting_table" } });
    assert.ok(h.calls.some((c) => c.kit === "craft" && c.action === "craft" && c.args instanceof Object && "item" in c.args && c.args.item === "crafting_table"));
    assert.deepEqual(new Set(h.calls.map((c) => c.kit)), new Set(["crafter", "inventory", "craft"]));
  });

  it("keeps each kit's store in memory, per harness", async () => {
    const keeper = defineKit(
      { name: "keeper", description: "Counts calls in its store." },
      { bump: action({ doc: "Adds one.", args: z.object({}), returns: z.number(), run: (ctx) => {
          const n = Number(ctx.store.get("n") ?? 0) + 1;
          ctx.store.set("n", n);
          return n;
        },
      }),
    },
    );
    const a = createKitHarness({ kits: [keeper], builtins: false });
    await a.call("keeper.bump");
    assert.equal(await a.call("keeper.bump"), 2);
    assert.equal(await createKitHarness({ kits: [keeper], builtins: false }).call("keeper.bump"), 1);
  });
});

/** A kit whose actions wait on the clock or reach for a table, the way polling and crafting kits do. */
const waiter = defineKit(
  { name: "waiter", description: "Polls with ctx.sleep and crafts at a table it finds." },
  {
    hungry: action({
      doc: "Waits for food that never comes, under a 50 ms limit.",
      args: z.object({}),
      run: (ctx) =>
        ctx.within(
          50,
          "waiting for food",
          (async () => {
            while (ctx.bot.food < 20) await ctx.sleep(1000);
          })(),
          () => {},
        ),
    }),
    forever: action({
      doc: "Sleeps until it is aborted.",
      args: z.object({}),
      run: async (ctx) => {
        for (;;) await ctx.sleep(100);
      },
    }),
    craftFar: action({
      doc: "Finds a crafting table within 32 blocks and crafts a wooden pickaxe there without walking.",
      args: z.object({}),
      run: async (ctx) => {
        const recipe = ctx.bot.recipesFor(ctx.bot.registry.itemsByName.wooden_pickaxe!.id, null, 1, true)[0]!;
        const table = ctx.bot.findBlock({ matching: ctx.bot.registry.blocksByName.crafting_table!.id, maxDistance: 32 });
        await ctx.bot.craft(recipe, 1, table ?? undefined);
      },
    }),
  },
);

describe("minebot-sdk/testing matches Mineflayer where kits can tell", () => {
  // The real timers here are the point: `within` and the abort timer can only fire if ctx.sleep yields a macrotask, which no fake clock shows.
  it("lets timers fire while a kit polls with ctx.sleep, so within and a timed abort work", { timeout: 5_000 }, async () => {
    const h = createKitHarness({ kits: [waiter], food: 10 });
    await assert.rejects(h.call("waiter.hungry"), /waiting for food took longer than 50 ms/);
    const pending = assert.rejects(h.call("waiter.forever"), /stop now/);
    setTimeout(() => h.abort(new Error("stop now")), 20);
    await pending;
  });

  it("finds a stand spot beyond 12 blocks for a GoalInvert, so combat.retreat works at any distance", async () => {
    const h = createKitHarness();
    const far = await h.call<{ position: { x: number; z: number }; distance: number }>("combat.retreat", { from: [0, 64, 0], distance: 20 });
    assert.ok(far.distance > 20, `stopped ${far.distance} blocks away`);
    assert.ok(Math.hypot(h.position.x, h.position.z) > 20);
  });

  it("requires the crafting table to be within reach, as the server does", async () => {
    const supplies = { oak_planks: 3, stick: 2 };
    const far = createKitHarness({ kits: [waiter], inventory: supplies, blocks: [{ name: "crafting_table", at: [12, 64, 0] }] });
    await assert.rejects(far.call("waiter.craftFar"), /crafting_table at .* is out of reach/);
    assert.equal(far.count("wooden_pickaxe"), 0);
    const near = createKitHarness({ kits: [waiter], inventory: supplies, blocks: [{ name: "crafting_table", at: [2, 64, 0] }] });
    await near.call("waiter.craftFar");
    assert.equal(near.count("wooden_pickaxe"), 1);
  });

  it("tosses one item for a null count, as Mineflayer does", async () => {
    const h = createKitHarness({ inventory: { stick: 5 } });
    await h.bot.toss(h.bot.registry.itemsByName.stick!.id, null, null);
    assert.equal(h.count("stick"), 4);
    assert.equal(h.entities.filter((e) => e.name === "item").length, 1);
  });

  it("drops the crop item for ripe wheat and beetroots, a bed's head, and nothing for a dead bush", async () => {
    const h = createKitHarness({
      blocks: [
        { name: "wheat", at: [1, 64, 0], properties: { age: 7 } },
        { name: "wheat", at: [0, 64, 1], properties: { age: 3 } },
        { name: "beetroots", at: [-1, 64, 0], properties: { age: 3 } },
      ],
    });
    for (const at of [[1, 64, 0], [0, 64, 1], [-1, 64, 0]] as const) await h.bot.dig(h.blockAt(at));
    assert.deepEqual(h.inventory, { wheat: 1, wheat_seeds: 2, beetroot: 1, beetroot_seeds: 1 });
    const bed = createKitHarness({
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
    const h = createKitHarness();
    h.bot.pathfinder.setGoal(new goals.GoalNear(5, 64, 0, 1));
    await new Promise<void>((resolve) => h.bot.once("goal_reached", () => resolve()));
    assert.equal(h.bot.pathfinder.goal, null);
    assert.ok(h.position.distanceTo(new Vec3(5, 64, 0)) <= 1.5);
  });

  it("searches blocks like findBlocks: floored point, || defaults, extra-info filter, palette check", () => {
    const id = (name: string) => createKitHarness().bot.registry.blocksByName[name]!.id;
    const h = createKitHarness({
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
    const h = createKitHarness({ inventory: { stick: 2 } });
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
    const h = createKitHarness({ ground: { y: 70, name: "dirt" } });
    assert.equal(h.position.y, 71);
    assert.equal(h.blockAt([0, 70, 0]).name, "dirt");
    assert.equal(createKitHarness().position.y, 64);
  });

  it("refuses to place a block into the bot's own cell, and the place kit steps out first", async () => {
    const h = createKitHarness({ inventory: { cobblestone: 2 } });
    await h.call("inventory.equip", { item: "cobblestone" });
    await assert.rejects(h.bot.placeBlock(h.blockAt([0, 63, 0]), new Vec3(0, 1, 0)), /cannot place cobblestone at .*stands there/);
    assert.equal(h.blockAt([0, 64, 0]).name, "air");
    assert.equal(await h.call("place.place", { at: [0, 64, 0], item: "cobblestone" }), true);
    assert.equal(h.blockAt([0, 64, 0]).name, "cobblestone");
    assert.ok(!h.position.floored().equals(new Vec3(0, 64, 0)));
  });

  it("updates an open furnace window as it burns, with fuel as a fraction of the fuel item", async () => {
    const h = createKitHarness({ blocks: [{ name: "furnace", at: [1, 64, 0], properties: { lit: false } }], inventory: { raw_iron: 1, coal: 1 } });
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
