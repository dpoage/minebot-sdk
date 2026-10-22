import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RoutineContext } from "minebot-sdk/routine";
import { createHarness } from "minebot-sdk/testing";
import { BodyState } from "../src/host/state.ts";
import type { ProgramScope } from "../src/program/scope.ts";
import * as explorer from "../src/routines/explorer.ts";

const SCOPE: ProgramScope = { log: () => {}, sleep: async () => {}, signal: new AbortController().signal, on: () => {} };

/**
 * What the explorer kit did at 5218f99 (the last commit that had the kit framework), recorded once and committed:
 * the store files its `remember` and `explore` wrote (`plain`, and `legacy` with the key an older kit wrote), and for each
 * scenario below what the kit answered and the file it left. The routines must read those files, answer as the kit did, and write the same format.
 */
interface Frozen {
  plain: Record<string, unknown>;
  legacy: Record<string, unknown>;
  scenarioLegacy: { places: unknown; placesFarm: unknown; waypoints: unknown; travel: unknown; position: unknown; fileAfter: Record<string, unknown> };
  scenarioRemember: { args: Parameters<typeof explorer.remember>[1]; result: unknown; fileAfter: Record<string, unknown>; placesAfter: unknown };
  scenarioConvert: { seed: Record<string, unknown>; waypoints: unknown; places: unknown; fileAfter: Record<string, unknown> };
}
const KIT = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "explorer", "kit-5218f99.json"), "utf8")) as Frozen;

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "minebot-explorer-"));
  scratchDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
const storeFile = (dir: string) => path.join(dir, "stores", "explorer.json");
const parsed = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(storeFile(dir), "utf8"));
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A state directory whose explorer store holds `file`, as the kit left it. */
function stateWith(file: Record<string, unknown>): string {
  const dir = scratch();
  mkdirSync(path.join(dir, "stores"));
  writeFileSync(storeFile(dir), `${JSON.stringify(file, null, 2)}\n`);
  return dir;
}

/** What the routines run against: a bot in a harness world, over the state directory `dir`. */
function side(dir: string) {
  const h = createHarness({ position: [100, 64, 0] });
  const state = new BodyState(dir);
  // The body's context: `ctx.store(namespace)` is the state directory's store, as the host builds it.
  const ctx = { bot: h.bot, ...SCOPE, store: (namespace: string) => state.routineStore(namespace) } as unknown as RoutineContext;
  return { h, ctx };
}

/** A place without its time of last change, which is the clock's and not the store's. */
const timeless = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === "updatedAt" ? "" : v)));

describe("explorer routines over a store the explorer kit wrote", () => {
  it("holds the files the kit wrote: places and visited cells, and the legacy key beside them", () => {
    assert.deepEqual(Object.keys(KIT.plain).sort(), ["places", "visited"]);
    assert.deepEqual(Object.keys(KIT.legacy).sort(), ["places", "visited", "waypoints"]);
    assert.equal(Object.keys(KIT.plain.places as object).length, 2);
  });

  it("returns the kit's places, waypoints, and travel on the same file, and leaves the legacy key alone", async () => {
    const dir = stateWith(KIT.legacy);
    const r = side(dir);
    const frozen = KIT.scenarioLegacy;
    assert.deepEqual(json(await explorer.places(r.ctx)), frozen.places);
    assert.deepEqual(json(await explorer.places(r.ctx, { kind: "farm", radius: 1000 })), frozen.placesFarm);
    assert.deepEqual(json(await explorer.waypoints(r.ctx)), frozen.waypoints);
    assert.deepEqual(json(await explorer.travel(r.ctx, { name: "home" })), frozen.travel);
    assert.deepEqual(json(r.h.position), frozen.position);
    await assert.rejects(explorer.travel(r.ctx, { name: "nowhere" }), /no place "nowhere"; known: home, far farm/);
    assert.deepEqual(parsed(dir), frozen.fileAfter);
    assert.deepEqual(parsed(dir).waypoints, KIT.legacy.waypoints);
  });

  it("remembers into the same file format: the routine writes the kit's entry, and what it leaves is what the kit left", async () => {
    const dir = stateWith(KIT.plain);
    const r = side(dir);
    const frozen = KIT.scenarioRemember;
    assert.deepEqual(timeless(await explorer.remember(r.ctx, frozen.args)), timeless(frozen.result));
    assert.deepEqual(timeless(parsed(dir)), timeless(frozen.fileAfter));
    assert.deepEqual(timeless(await explorer.places(r.ctx)), timeless(frozen.placesAfter));
    assert.deepEqual(Object.keys(parsed(dir)).sort(), ["places", "visited"]);
  });

  it("keeps the visited cells: the routine's explore adds to the file", async () => {
    const dir = stateWith(KIT.plain);
    const before = parsed(dir).visited as string[];
    assert.ok(before.length > 0);
    const r = side(dir);
    const walked = await explorer.explore(r.ctx, { distance: 40 });
    const after = parsed(dir).visited as string[];
    assert.ok(before.every((cell) => after.includes(cell)));
    assert.ok(walked.cellsVisited >= before.length);
    assert.equal(walked.cellsVisited, after.length);
    // A second explore from the same body starts from what the first left.
    const next = await explorer.explore(side(dir).ctx, { distance: 40 });
    assert.ok(next.cellsVisited >= after.length);
  });

  it("converts a legacy waypoints-only file as the kit does, once", async () => {
    const dir = stateWith(KIT.scenarioConvert.seed);
    const r = side(dir);
    const frozen = KIT.scenarioConvert;
    assert.deepEqual(json(await explorer.waypoints(r.ctx)), frozen.waypoints);
    assert.deepEqual(timeless(await explorer.places(r.ctx)), timeless(frozen.places));
    assert.deepEqual(timeless(parsed(dir)), timeless(frozen.fileAfter));
    assert.deepEqual(Object.keys(parsed(dir)).sort(), ["places", "visited"]);
  });
});
