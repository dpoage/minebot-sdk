import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { BUILTIN_KITS } from "../src/kit/index.ts";
import { blueprintBlocks, blueprintMaterials } from "../src/kit/kits/builder.ts";
import { action, defineKit, type Kit, type KitContext, KitHost, KitLockedError } from "../src/kit/kit.ts";
import { nameMatcher } from "../src/mc/names.ts";
import { JsonStore } from "../src/store.ts";

/** A fresh per-kit store in a temp dir, like the body's state directory provides. */
function stores(): (kit: string) => JsonStore {
  const root = mkdtempSync(path.join(tmpdir(), "minebot-kits-"));
  const cache = new Map<string, JsonStore>();
  return (kit: string) => {
    let store = cache.get(kit);
    if (!store) {
      store = new JsonStore(path.join(root, `${kit}.json`));
      cache.set(kit, store);
    }
    return store;
  };
}

/** A scope like a running program's: log collects, sleep resolves, signal aborts on demand. */
function scope(log: string[] = [], signal = new AbortController().signal): Parameters<KitHost["api"]>[0] {
  return {
    log: (...args: unknown[]) => log.push(args.map(String).join(" ")),
    sleep: () => Promise.resolve(),
    signal,
    on: () => {},
  };
}

/** Two tiny kits: `base` with one action, and `upper` which uses it. */
const base = defineKit({
  name: "base",
  description: "echoes numbers",
  uses: [],
  actions: {
    echo: action({
      doc: "Returns { value } with the argument unchanged.",
      args: z.object({ value: z.number() }),
      run: (_ctx, { value }) => ({ value }),
    }),
  },
});

const upper = defineKit({
  name: "upper",
  description: "doubles through base",
  uses: ["base"],
  actions: {
    double: action({
      doc: "Calls base.echo and doubles the value.",
      args: z.object({ value: z.number(), timeoutMs: z.number().int().positive().default(50) }),
      run: async (ctx, { value }) => {
        const echoed = (await ctx.kits.base!.echo!({ value })) as { value: number };
        return { value: echoed.value * 2 };
      },
    }),
  },
});

const walker = defineKit({
  name: "walker",
  description: "walks",
  uses: ["base"],
  actions: {
    walk: action({ doc: "Returns the step count.", args: z.object({ steps: z.number().int().positive() }), run: (_ctx, { steps }) => ({ steps }) }),
  },
});

describe("defineKit and action", () => {
  it("validates names, uses, and actions", () => {
    assert.throws(() => defineKit({ name: "Bad-Name", description: "x", actions: {} }), /kit name "Bad-Name": use 1-32 lowercase/);
    assert.throws(() => defineKit({ name: "ok", description: "", actions: {} }), /description/);
    assert.throws(() => defineKit({ name: "ok", description: "x", uses: ["nope!"], actions: {} }), /kit names/);
    assert.throws(
      () => defineKit({ name: "ok", description: "x", actions: { Bad: action({ doc: "d", args: z.object({}), run: () => 1 }) } }),
      /action name "Bad"/,
    );
    assert.throws(
      () => defineKit({ name: "ok", description: "x", actions: { bad: { doc: "d" } as unknown as ReturnType<typeof action> } }),
      /action\(\{ doc, args, run \}\)/,
    );
  });
});

describe("KitHost", () => {
  it("activates used kits before the kits that need them", () => {
    const host = new KitHost({ kits: [base, upper, walker], stores: stores() });
    assert.deepEqual(host.use(["upper", "walker"]), ["base", "upper", "walker"]);
  });

  it("offers every kit active by default, and resolves the explicit active set", () => {
    const host = new KitHost({ kits: [base, upper], stores: stores() });
    assert.deepEqual(host.active, ["base", "upper"]);
    assert.deepEqual(new KitHost({ kits: [base, upper], stores: stores(), active: ["upper"] }).active, ["base", "upper"]);
  });

  it("calls actions namespaced with one object argument, and validates it", () => {
    const host = new KitHost({ kits: [base, upper], stores: stores() });
    const kit = host.api(scope(), {} as KitContext["bot"]);
    assert.deepEqual(kit.base!.echo!({ value: 2 }), { value: 2 });
    assert.throws(() => kit.base!.echo!({ value: "two" }), /kit\.base\.echo arguments:[\s\S]*value/);
    assert.throws(() => kit.base!.echo!({}), /kit\.base\.echo arguments:[\s\S]*value/);
  });

  it("documents actions from their schemas: names, optionals, and defaults", () => {
    const host = new KitHost({ kits: [base, upper], stores: stores() });
    const docs = host.docs(["upper"]);
    assert.match(docs, /## upper\n[\s\S]*Uses: base\./);
    assert.match(docs, /### kit\.upper\.double\(\{ value, timeoutMs\? \}\)/);
    assert.match(docs, /- value: number/);
    assert.match(docs, /- timeoutMs\?: number \(default 50\)/);
  });

  it("names the kit to activate when its action is called while inactive", () => {
    const host = new KitHost({ kits: [base, upper, walker], stores: stores() });
    const kit = host.api(scope(), {} as KitContext["bot"]);
    host.use(["walker"]);
    assert.deepEqual(kit.walker!.walk!({ steps: 2 }), { steps: 2 });
    assert.throws(() => kit.upper!.double!({ value: 1 }), /"upper" kit is not active; call kits\.use\("upper"\)/);
  });

  it("locks the active set and hides the kits that are not active", () => {
    const host = new KitHost({ kits: [base, upper, walker], stores: stores(), active: ["walker"], locked: true });
    assert.throws(() => host.use(["base"]), KitLockedError);
    assert.deepEqual(host.info().map((k) => k.name), ["base", "walker"]);
    assert.deepEqual(host.offered, ["base", "upper", "walker"]);
    const kit = host.api(scope(), {} as KitContext["bot"]);
    assert.equal(kit.upper, undefined);
    assert.throws(() => host.docs(["upper"]), /unknown kit "upper"/);
    assert.throws(() => new KitHost({ kits: [base], stores: stores(), active: [], locked: true }).docs(), /no kits are available/);
  });

  it("rejects unknown kits and use cycles", () => {
    const host = new KitHost({ kits: [base], stores: stores() });
    assert.throws(() => host.use(["flying"]), /unknown kit "flying"; available: base/);
    const loopA = defineKit({ name: "loop_a", description: "x", uses: ["loop_b"], actions: {} });
    const loopB = defineKit({ name: "loop_b", description: "x", uses: ["loop_a"], actions: {} });
    const cyclic = new KitHost({ kits: [loopA, loopB], stores: stores() });
    assert.throws(() => cyclic.use(["loop_a"]), /dependency cycle: loop_a -> loop_b -> loop_a/);
  });

  it("gives each kit its own store, and no kit reads another's", () => {
    const seen: string[] = [];
    const root = mkdtempSync(path.join(tmpdir(), "minebot-kits-"));
    const provider = (kit: string) => {
      seen.push(kit);
      return new JsonStore(path.join(root, `${kit}.json`));
    };
    const write = defineKit({
      name: "writer",
      description: "writes its store",
      uses: [],
      actions: {
        put: action({ doc: "Puts a value.", args: z.object({ key: z.string(), value: z.number() }), run: (ctx, { key, value }) => ctx.store.set(key, value) }),
      },
    });
    const read = defineKit({
      name: "reader",
      description: "reads its store",
      uses: [],
      actions: {
        get: action({ doc: "Gets a value.", args: z.object({ key: z.string() }), run: (ctx, { key }) => ctx.store.get(key) ?? null }),
      },
    });
    const host = new KitHost({ kits: [write, read], stores: provider });
    const kit = host.api(scope(), {} as KitContext["bot"]);
    kit.writer!.put!({ key: "n", value: 7 });
    assert.equal(kit.reader!.get!({ key: "n" }), null);
    // A second host over the same files still sees only the writer's value in the writer's store.
    const again = new KitHost({ kits: [write, read], stores: provider });
    assert.equal(again.api(scope(), {} as KitContext["bot"]).writer!.put!({ key: "n", value: 8 }), undefined);
    assert.deepEqual(new Set(seen), new Set(["writer", "reader"]));
  });

  it("propagates the program's signal into nested actions", async () => {
    const controller = new AbortController();
    const deep = defineKit({
      name: "deep",
      description: "waits",
      uses: [],
      actions: {
        wait: action({
          doc: "Rejects when the signal fires.",
          args: z.object({}),
          run: async (ctx) => {
            const stopped = Promise.withResolvers<never>();
            ctx.signal.addEventListener("abort", () => stopped.reject(ctx.signal.reason), { once: true });
            return stopped.promise;
          },
        }),
      },
    });
    const outer = defineKit({
      name: "outer",
      description: "calls deep",
      uses: ["deep"],
      actions: {
        run: action({ doc: "Calls deep.wait.", args: z.object({}), run: (ctx) => ctx.kits.deep!.wait!({}) }),
      },
    });
    const host = new KitHost({ kits: [deep, outer], stores: stores() });
    const call = host.api(scope([], controller.signal), {} as KitContext["bot"]).outer!.run!({}) as Promise<unknown>;
    const rejection = assert.rejects(call, /stop now/);
    controller.abort(new Error("stop now"));
    await rejection;
  });

  it("keeps a kit from reaching kits it did not declare in uses", () => {
    const secret = defineKit({
      name: "secret",
      description: "not for upper",
      uses: [],
      actions: {
        read: action({ doc: "Returns 1.", args: z.object({}), run: () => 1 }),
      },
    });
    const nosy = defineKit({
      name: "nosy",
      description: "tries to use secret",
      uses: ["base"],
      actions: {
        peek: action({
          doc: "Reaches for secret.read.",
          args: z.object({}),
          run: (ctx) => {
            const namespace = (ctx.kits as Record<string, unknown>)["secret"];
            if (namespace !== undefined) throw new Error("secret was reachable");
            return { listed: Object.keys(ctx.kits), hasSecret: "secret" in ctx.kits, baseActions: Object.keys(ctx.kits.base!) };
          },
        }),
      },
    });
    const host = new KitHost({ kits: [base, secret, nosy], stores: stores() });
    const kit = host.api(scope(), {} as KitContext["bot"]);
    assert.deepEqual(kit.nosy!.peek!({}), { listed: ["base"], hasSecret: false, baseActions: ["echo"] });
  });

  it("adds, updates, and removes kits while running", async () => {
    const host = new KitHost({ kits: [base], stores: stores() });
    host.add(upper);
    assert.deepEqual(host.active, ["base", "upper"]);
    const kit = host.api(scope(), {} as KitContext["bot"]);
    assert.deepEqual(await kit.upper!.double!({ value: 3 }), { value: 6 });
    host.remove("upper");
    assert.equal(kit.upper, undefined);
  });

  it("keeps a locked body's active set fixed when a kit is added", () => {
    const host = new KitHost({ kits: [base], stores: stores(), active: ["base"], locked: true });
    host.add(upper);
    assert.deepEqual(host.active, ["base"]);
    assert.deepEqual(host.offered, ["base", "upper"]);
  });

  it("ships kits that can all be active together, primitives first", () => {
    const host = new KitHost({ kits: BUILTIN_KITS, stores: stores() });
    assert.deepEqual(host.use(BUILTIN_KITS.map((k) => k.name)), BUILTIN_KITS.map((k) => k.name));
    const names = host.info().map((k) => k.name);
    const primitives = ["move", "sense", "dig", "place", "inventory", "craft", "items", "furnace", "container", "survival", "combat", "farm", "bucket"];
    assert.deepEqual(names.slice(0, primitives.length), primitives);
    for (const kit of host.info()) {
      assert.equal(kit.agent, false, kit.name);
      assert.ok(kit.actions.length > 0, kit.name);
      assert.ok(kit.description.length > 0, kit.name);
    }
    assert.deepEqual(
      host.info().filter((k) => k.uses.length === 0).map((k) => k.name),
      primitives,
    );
  });

  it("documents the shipped kits with call shapes from their schemas", () => {
    const host = new KitHost({ kits: BUILTIN_KITS, stores: stores() });
    const docs = host.docs(["move"]);
    assert.match(docs, /### kit\.move\.to\(\{ position, range\?, timeoutMs\? \}\)/);
    assert.match(docs, /- position: \{ x: number, y: number, z: number \} \| \[number, number, number\]/);
    assert.match(docs, /- range\?: number \(default 1\)/);
    const gather = host.docs(["gatherer"]);
    assert.match(gather, /Uses: move, sense, dig, inventory, items\./);
    assert.match(gather, /### kit\.gatherer\.gather\(\{ blocks, count, radius\? \}\)/);
  });
});

describe("blueprints", () => {
  const hut = {
    palette: { "#": "cobblestone", d: "minecraft:oak_door" },
    layers: [
      `
        ###
        #.#
        #d#
      `,
      ["###", "# #", "###"],
    ],
  };

  it("maps characters to offsets: layers to y, rows to z, columns to x, ignoring indentation", () => {
    const blocks = blueprintBlocks(hut);
    assert.equal(blocks.length, 16);
    assert.deepEqual(blocks.find((b) => b.block === "oak_door"), { dx: 1, dy: 0, dz: 2, block: "oak_door" });
    assert.ok(!blocks.some((b) => b.dx === 1 && b.dz === 1));
  });

  it("counts materials", () => {
    assert.deepEqual(blueprintMaterials(hut), { cobblestone: 15, oak_door: 1 });
  });

  it("rejects characters missing from the palette", () => {
    assert.throws(() => blueprintBlocks({ palette: {}, layers: ["x"] }), /character "x" is not in the palette/);
  });
});

describe("nameMatcher", () => {
  it("matches globs and lists, with or without namespace", () => {
    const logs = nameMatcher(["*_log", "minecraft:crafting_table"]);
    assert.ok(logs("minecraft:oak_log"));
    assert.ok(logs("crafting_table"));
    assert.ok(!logs("oak_log_extra"));
    assert.ok(!nameMatcher("a.b")("axb"));
  });
});
