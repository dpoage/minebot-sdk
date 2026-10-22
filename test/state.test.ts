import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import { MAX_NOTES, NoteLimitError, Notes } from "../src/notes.ts";
import { StallTracker } from "../src/host/progress.ts";
import { statsFromEntries } from "../src/host/stats.ts";
import { JsonStore } from "../src/store.ts";

const tempFile = async (name: string) => path.join(await mkdtemp(path.join(tmpdir(), "minebot-state-")), name);

describe("JsonStore", () => {
  it("persists values for the next store on the same file, leaving no temp files", async () => {
    const file = await tempFile("kit.json");
    const store = new JsonStore(file);
    store.set("waypoints", { home: { x: 1, y: 2, z: 3 } });
    store.set("gone", 1);
    store.delete("gone");
    const reloaded = new JsonStore(file);
    assert.deepEqual(reloaded.get("waypoints"), { home: { x: 1, y: 2, z: 3 } });
    assert.deepEqual(reloaded.keys(), ["waypoints"]);
    assert.deepEqual(await readdir(path.dirname(file)), ["kit.json"]);
  });

  it("refuses to load a corrupt file instead of starting empty and overwriting it", async () => {
    const file = await tempFile("notes.json");
    await writeFile(file, "{ not json");
    assert.throws(() => new JsonStore(file), /cannot load/);
  });
});

describe("Notes", () => {
  it("lists the most recently changed note first and survives a reload", async () => {
    const file = await tempFile("notes.json");
    const notes = new Notes(new JsonStore(file));
    notes.set("plan", "get wood");
    await new Promise((r) => setTimeout(r, 5));
    notes.set("places/base", "x=10 z=20");
    const reloaded = new Notes(new JsonStore(file));
    assert.deepEqual(reloaded.list().map((n) => n.key), ["places/base", "plan"]);
    assert.equal(reloaded.get("plan")?.text, "get wood");
  });

  it("rejects bad keys and caps the number of notes, but still allows updates at the cap", async () => {
    const notes = new Notes(new JsonStore(await tempFile("notes.json")));
    assert.throws(() => notes.set("Plan!", "x"), /lowercase/);
    for (let i = 0; i < MAX_NOTES; i++) notes.set(`n${i}`, "x");
    assert.throws(() => notes.set("one-more", "x"), NoteLimitError);
    assert.equal(notes.set("n0", "updated").text, "updated");
  });
});

describe("StallTracker", () => {
  it("counts programs in a row that end in the same state, and resets on any change", () => {
    const tracker = new StallTracker();
    const at = (position: string, inventory: Record<string, number> = {}) => ({ position, inventory });
    assert.equal(tracker.record(at("1,64,1")), 0);
    assert.equal(tracker.record(at("1,64,1")), 1);
    assert.equal(tracker.record(at("1,64,1")), 2);
    assert.equal(tracker.record(at("1,64,1", { dirt: 1 })), 0);
    // Inventory order does not matter.
    tracker.record(at("1,64,1", { dirt: 1, stick: 2 }));
    assert.equal(tracker.record(at("1,64,1", { stick: 2, dirt: 1 })), 1);
  });
});

describe("statsFromEntries", () => {
  it("maps statistics packet entries to stats-file categories and namespaced ids", () => {
    const registry = {
      items: { 10: { name: "oak_log" }, 20: { name: "stick" } },
      blocks: { 5: { name: "stone" } },
      entities: { 7: { name: "zombie" } },
    } as unknown as Bot["registry"];
    const stats = statsFromEntries(
      [
        { categoryId: 0, statisticId: 5, value: 3 }, // mined stone
        { categoryId: 1, statisticId: 20, value: 4 }, // crafted stick
        { categoryId: 4, statisticId: 10, value: 2 }, // picked up oak_log
        { categoryId: 6, statisticId: 7, value: 1 }, // killed zombie
        { categoryId: 4, statisticId: 999, value: 1 }, // unknown item: skipped
        { categoryId: 42, statisticId: 1, value: 1 }, // unknown category: skipped
      ],
      registry,
    );
    assert.deepEqual(stats.stats, {
      "minecraft:mined": { "minecraft:stone": 3 },
      "minecraft:crafted": { "minecraft:stick": 4 },
      "minecraft:picked_up": { "minecraft:oak_log": 2 },
      "minecraft:killed": { "minecraft:zombie": 1 },
    });
  });
});
