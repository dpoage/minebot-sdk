import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Vec3 } from "vec3";
import { BUILTIN_KITS } from "../src/kit/index.ts";
import { faceIndex, isSource } from "../src/kit/kits/bucket.ts";
import { attackCooldownMs, bestWeapon, weaponScore } from "../src/kit/kits/combat.ts";
import { breedingFoods, closestPair, cropOf, isBaby, isRipe, seedItem } from "../src/kit/kits/farm.ts";
import { isHostile } from "../src/mc/hostile.ts";

describe("combat", () => {
  it("ranks swords above axes, and each by damage", () => {
    assert.equal(bestWeapon(["stone_axe", "wooden_sword"]), "wooden_sword");
    assert.equal(bestWeapon(["diamond_axe", "stone_sword", "iron_sword"]), "iron_sword");
    assert.equal(bestWeapon(["wooden_axe", "iron_axe", "stick"]), "iron_axe");
    assert.equal(bestWeapon(["diamond_pickaxe", "stick", "bow"]), null);
    assert.equal(weaponScore("netherite_sword"), 108);
    assert.equal(weaponScore("minecraft:iron_sword"), 106);
    assert.equal(weaponScore("iron_pickaxe"), null);
    assert.equal(weaponScore("sword"), null);
  });

  it("paces hits by the held weapon", () => {
    assert.equal(attackCooldownMs("iron_sword"), 625);
    assert.equal(attackCooldownMs("diamond_axe"), 1000);
    assert.equal(attackCooldownMs("stone_axe"), 1250);
    assert.equal(attackCooldownMs(null), 500);
    assert.equal(attackCooldownMs("stick"), 500);
  });

  it("treats the registry's hostile category as targets, whatever the entity type", () => {
    for (const name of ["zombie", "slime", "phantom", "magma_cube", "ghast", "shulker"]) assert.equal(isHostile({ kind: "Hostile mobs", name }), true, name);
    for (const name of ["enderman", "zombified_piglin", "strider", "end_crystal"]) assert.equal(isHostile({ kind: "Hostile mobs", name }), false, name);
    assert.equal(isHostile({ kind: "Passive mobs", name: "cow" }), false);
    assert.equal(isHostile({}), false);
  });
});

describe("farm", () => {
  it("maps seeds and crop names to the seed item and the block they grow into", () => {
    assert.equal(seedItem("wheat_seeds"), "wheat_seeds");
    assert.equal(seedItem("wheat"), "wheat_seeds");
    assert.equal(seedItem("minecraft:carrots"), "carrot");
    assert.equal(seedItem("potato"), "potato");
    assert.equal(seedItem("beetroot"), "beetroot_seeds");
    assert.equal(seedItem("stick"), null);
    assert.equal(cropOf("wheat_seeds"), "wheat");
    assert.equal(cropOf("carrot"), "carrots");
    assert.equal(cropOf("pitcher_pod"), "pitcher_crop");
  });

  it("knows when a crop is ripe", () => {
    assert.equal(isRipe("wheat", 7), true);
    assert.equal(isRipe("wheat", 6), false);
    assert.equal(isRipe("beetroots", 3), true);
    assert.equal(isRipe("beetroots", 2), false);
    assert.equal(isRipe("grass", 7), false);
  });

  it("lists breeding foods and spots babies", () => {
    assert.deepEqual(breedingFoods("cow"), ["wheat"]);
    assert.ok(breedingFoods("pig").includes("carrot"));
    assert.deepEqual(breedingFoods("zombie"), []);
    assert.equal(isBaby({ metadata: [null, null, null, null, null, null, null, null, null, 10, null, null, null, null, null, null, true] }), true);
    assert.equal(isBaby({ metadata: [null, null, null, null, null, null, null, null, null, 10] }), false);
    assert.equal(isBaby({}), false);
  });

  it("pairs the two animals closest to each other", () => {
    const at = (id: number, x: number) => ({ id, position: new Vec3(x, 0, 0) });
    const pair = closestPair([at(1, 0), at(2, 10), at(3, 11), at(4, 30)]);
    assert.deepEqual(pair?.map((a) => a.id), [2, 3]);
    assert.equal(closestPair([at(1, 0)]), null);
    assert.equal(closestPair([]), null);
  });
});

describe("bucket", () => {
  it("numbers block faces the way raycasts report them", () => {
    assert.equal(faceIndex(new Vec3(0, -1, 0)), 0);
    assert.equal(faceIndex(new Vec3(0, 1, 0)), 1);
    assert.equal(faceIndex(new Vec3(0, 0, -1)), 2);
    assert.equal(faceIndex(new Vec3(0, 0, 1)), 3);
    assert.equal(faceIndex(new Vec3(-1, 0, 0)), 4);
    assert.equal(faceIndex(new Vec3(1, 0, 0)), 5);
  });

  it("takes only full-depth fluid of the right kind", () => {
    const block = (name: string, level?: string) => ({ name, getProperties: (): Record<string, string> => (level === undefined ? {} : { level }) });
    assert.equal(isSource(block("water", "0"), "water"), true);
    assert.equal(isSource(block("water", "3"), "water"), false);
    assert.equal(isSource(block("water", "8"), "water"), false);
    assert.equal(isSource(block("lava", "0"), "water"), false);
    assert.equal(isSource(block("lava", "0"), "lava"), true);
  });
});

describe("combat, farm, and bucket kits", () => {
  it("ship as primitives with the documented actions", () => {
    const actions = (kit: string) => Object.keys(BUILTIN_KITS.find((k) => k.name === kit)!.actions);
    assert.deepEqual(actions("combat"), ["attack", "fight", "retreat"]);
    assert.deepEqual(actions("farm"), ["till", "plant", "harvest", "breed"]);
    assert.deepEqual(actions("bucket"), ["fill", "empty"]);
    for (const name of ["combat", "farm", "bucket"]) assert.deepEqual(BUILTIN_KITS.find((k) => k.name === name)!.uses, []);
  });
});
