import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { RoutineContext } from "minebot-sdk/routine";
import { createKitHarness } from "minebot-sdk/testing";
import { BodyState } from "../src/host/state.ts";
import { BUILTIN_KITS } from "../src/kit/index.ts";
import { type KitCalls, KitHost } from "../src/kit/kit.ts";
import type { ProgramScope } from "../src/program/scope.ts";
import * as explorer from "../src/routines/explorer.ts";

const SCOPE: ProgramScope = { log: () => {}, sleep: async () => {}, signal: new AbortController().signal, on: () => {} };

const scratch = () => mkdtempSync(path.join(tmpdir(), "minebot-explorer-"));
const storeFile = (dir: string) => path.join(dir, "stores", "explorer.json");
const parsed = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(storeFile(dir), "utf8"));

/** What one side of the comparison runs against: a bot in a harness world, over the state directory `dir`. */
function side(dir: string) {
  const h = createKitHarness({ position: [100, 64, 0] });
  const state = new BodyState(dir);
  const kit = new KitHost({ kits: BUILTIN_KITS, stores: (name) => state.store(name) }).api(SCOPE, h.bot) as KitCalls;
  // The body's context: `ctx.store(namespace)` is the state directory's store, as the host builds it.
  const ctx = { bot: h.bot, ...SCOPE, store: (namespace: string) => state.routineStore(namespace) } as unknown as RoutineContext;
  return { h, kit: kit.explorer!, ctx };
}

/** A place without its time of last change, which is the clock's and not the store's. */
const timeless = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === "updatedAt" ? "" : v)));

/** The explorer store as a file: places and visited cells from kit calls, then the key an older kit wrote (`legacy`) when asked. */
async function writtenByKit(dir: string, legacy: boolean): Promise<void> {
  const { kit } = side(dir);
  await kit.remember!({ name: "home", at: [5, 64, 6], kind: "chest", tags: ["food"], contents: { bread: 5 } });
  await kit.remember!({ name: "far farm", at: [400, 64, 0], kind: "farm", note: "wheat" });
  await kit.explore!({ distance: 40 });
  if (legacy) new BodyState(dir).store("explorer").set("waypoints", { old: { x: 1, y: 2, z: 3, dimension: "minecraft:overworld" } });
}

describe("explorer routines over a store the explorer kit wrote", () => {
  it("returns the kit's places, waypoints, and travel on the same file, and leaves the legacy key alone", async () => {
    const dirKit = scratch();
    await writtenByKit(dirKit, true);
    const dirRoutine = scratch();
    cpSync(path.join(dirKit, "stores"), path.join(dirRoutine, "stores"), { recursive: true });
    assert.deepEqual(Object.keys(parsed(dirRoutine)).sort(), ["places", "visited", "waypoints"]);

    const k = side(dirKit);
    const r = side(dirRoutine);
    const places = await k.kit.places!({});
    assert.equal((places as unknown[]).length, 2);
    assert.deepEqual(await explorer.places(r.ctx), await k.kit.places!({}));
    assert.deepEqual(await explorer.places(r.ctx, { kind: "farm", radius: 1000 }), await k.kit.places!({ kind: "farm", radius: 1000 }));
    assert.deepEqual(await explorer.waypoints(r.ctx), await k.kit.waypoints!({}));
    assert.deepEqual(JSON.parse(JSON.stringify(await explorer.travel(r.ctx, { name: "home" }))), JSON.parse(JSON.stringify(await k.kit.travel!({ name: "home" }))));
    assert.deepEqual(r.h.position, k.h.position);
    await assert.rejects(explorer.travel(r.ctx, { name: "nowhere" }), /no place "nowhere"; known: home, far farm/);
    assert.deepEqual(parsed(dirRoutine), parsed(dirKit));
  });

  it("remembers into the same file format: the kit reads the routine's write, and both write the same entry", async () => {
    const dirKit = scratch();
    await writtenByKit(dirKit, false);
    const dirRoutine = scratch();
    cpSync(path.join(dirKit, "stores"), path.join(dirRoutine, "stores"), { recursive: true });
    const k = side(dirKit);
    const r = side(dirRoutine);

    const args: Parameters<typeof explorer.remember>[1] = { name: "home", note: "stocked", at: [9, 64, 9] };
    assert.deepEqual(timeless(await explorer.remember(r.ctx, args)), timeless(await k.kit.remember!(args)));
    assert.deepEqual(timeless(parsed(dirRoutine)), timeless(parsed(dirKit)));

    // The kit, on a fresh host over the routine's file, answers as the routine does.
    const reread = side(dirRoutine);
    assert.deepEqual(await reread.kit.places!({}), await explorer.places(r.ctx));
    assert.deepEqual(Object.keys(parsed(dirRoutine)).sort(), ["places", "visited"]);
  });

  it("keeps the visited cells: the routine's explore adds to the file and the kit's explore adds to that", async () => {
    const dir = scratch();
    await writtenByKit(dir, false);
    const before = parsed(dir).visited as string[];
    assert.ok(before.length > 0);
    const r = side(dir);
    const walked = await explorer.explore(r.ctx, { distance: 40 });
    const afterRoutine = parsed(dir).visited as string[];
    assert.ok(before.every((cell) => afterRoutine.includes(cell)));
    assert.ok(walked.cellsVisited >= before.length);
    assert.equal(walked.cellsVisited, afterRoutine.length);
    const next = await side(dir).kit.explore!({ distance: 40 });
    assert.ok(Number(Reflect.get(next as object, "cellsVisited")) >= afterRoutine.length);
  });

  it("converts a legacy waypoints-only file as the kit does, once", async () => {
    const seed = scratch();
    mkdirSync(path.join(seed, "stores"));
    writeFileSync(storeFile(seed), `${JSON.stringify({ waypoints: { home: { x: 5, y: 70, z: 6, dimension: "minecraft:overworld" } }, visited: ["0,0"] }, null, 2)}\n`);
    const dirRoutine = scratch();
    cpSync(path.join(seed, "stores"), path.join(dirRoutine, "stores"), { recursive: true });
    const k = side(seed);
    const r = side(dirRoutine);
    assert.deepEqual(await explorer.waypoints(r.ctx), await k.kit.waypoints!({}));
    assert.deepEqual(timeless(await explorer.places(r.ctx)), timeless(await k.kit.places!({})));
    assert.deepEqual(timeless(parsed(dirRoutine)), timeless(parsed(seed)));
    assert.deepEqual(Object.keys(parsed(dirRoutine)).sort(), ["places", "visited"]);
  });
});
