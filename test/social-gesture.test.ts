import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Vec3 } from "minebot-sdk/routine";
import { createHarness } from "minebot-sdk/testing";
import * as social from "../src/routines/social.ts";

const CONTROLS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;
const KINDS = ["look", "nod", "shake", "wave", "crouch", "jump", "present"] as const;
const SWING = (15 * Math.PI) / 180;

/**
 * The harness bot has no `look`, `swingArm`, or physics. This gives the bot the three the gesture reaches for and a record
 * of what it did: forced looks, aims, arm swings, and every control change in order (a jump control also lifts the bot half a block, as the real one does).
 */
async function gestureWorld(options: { carrying?: Record<string, number>; holding?: string; lift?: boolean } = {}) {
  const h = createHarness({
    inventory: options.carrying ?? { bread: 3, apple: 2 },
    ...(options.holding && { equipment: { hand: options.holding } }),
    entities: [
      { name: "player", username: "Steve", at: [3.5, 64, 0.5] },
      { name: "player", username: "Alex", at: [-3.5, 64, 0.5] },
    ],
  });
  const { bot } = h;
  // The harness holds the first stack it is given; the hand starts empty unless the test names what it holds.
  if (!options.holding && bot.heldItem) await bot.equip(bot.heldItem, "off-hand");
  const looks: { yaw: number; pitch: number; forced: boolean | undefined }[] = [];
  const aims: Vec3[] = [];
  const controls: [string, boolean][] = [];
  let swings = 0;
  const setControlState = bot.setControlState.bind(bot);
  Object.assign(bot, {
    async look(yaw: number, pitch: number, forced?: boolean) {
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      looks.push({ yaw, pitch, forced });
    },
    async lookAt(point: Vec3, forced?: boolean) {
      const delta = point.minus(bot.entity.position.offset(0, 1.62, 0));
      aims.push(point);
      await bot.look(Math.atan2(-delta.x, -delta.z), Math.atan2(delta.y, Math.hypot(delta.x, delta.z)), forced);
    },
    swingArm() {
      swings++;
    },
    setControlState(control: Parameters<typeof setControlState>[0], state: boolean) {
      controls.push([control, state]);
      if (control === "jump" && state && options.lift !== false) bot.entity.position.y += 0.6;
      setControlState(control, state);
    },
  });
  return { h, looks, aims, controls, swings: () => swings };
}

/** Sign changes of a series whose swings span at least 15 degrees: the zigzag the observer counts. */
function reversals(series: readonly number[]): number {
  let direction = 0;
  let extreme = series[0] ?? 0;
  let count = 0;
  for (const value of series) {
    if (direction === 0) {
      if (Math.abs(value - extreme) >= SWING) {
        direction = Math.sign(value - extreme);
        extreme = value;
      }
    } else if (direction > 0) {
      if (value > extreme) extreme = value;
      else if (extreme - value >= SWING) [count, direction, extreme] = [count + 1, -1, value];
    } else if (value < extreme) extreme = value;
    else if (value - extreme >= SWING) [count, direction, extreme] = [count + 1, 1, value];
  }
  return count;
}

const argsFor = (kind: (typeof KINDS)[number]) => ({ kind, toward: "Steve", ...(kind === "present" && { item: "bread" }) });

describe("social.gesture: controls and time", () => {
  for (const kind of KINDS) {
    it(`${kind} leaves every control released`, async () => {
      const { h, controls } = await gestureWorld();
      await h.run(social.gesture, argsFor(kind));
      for (const control of CONTROLS) assert.ok(!h.bot.controlState[control], `${control} is still held after ${kind}`);
      assert.equal(controls.filter(([, held]) => held).length, controls.filter(([, held]) => !held).length, `${kind} released as many controls as it pressed`);
    });
  }

  it("lets go of a held control when the run is stopped mid-gesture", async () => {
    const { h, controls } = await gestureWorld();
    const stopped = h.run(social.gesture, { kind: "crouch" });
    h.abort();
    await assert.rejects(stopped);
    assert.deepEqual(controls, [["sneak", true], ["sneak", false]]);
    assert.ok(!h.bot.controlState.sneak);
  });

  it("crouches by holding sneak, and stands afterwards", async () => {
    const { h, controls } = await gestureWorld();
    await h.run(social.gesture, { kind: "crouch" });
    assert.deepEqual(controls, [["sneak", true], ["sneak", false]]);
  });

  it("jumps until the feet have risen half a block, then lets go", async () => {
    const { h, controls } = await gestureWorld();
    const start = h.position.y;
    await h.run(social.gesture, { kind: "jump" });
    assert.deepEqual(controls, [["jump", true], ["jump", false]]);
    assert.ok(h.position.y - start >= 0.5);
  });

  it("throws when the bot does not leave the ground, and still lets go of jump", async () => {
    const { h, controls } = await gestureWorld({ lift: false });
    await assert.rejects(h.run(social.gesture, { kind: "jump" }), /did not leave the ground/);
    assert.deepEqual(controls, [["jump", true], ["jump", false]]);
  });
});

describe("social.gesture: what an onlooker sees", () => {
  it("turns to face the player's head before the gesture, and holds that gaze for look", async () => {
    const { h, aims, looks } = await gestureWorld();
    assert.deepEqual(await h.run(social.gesture, { kind: "look", toward: "Steve" }), { kind: "look", toward: "Steve" });
    assert.ok(aims.length >= 2, "the gaze is kept on a player who moves");
    for (const aim of aims) assert.ok(Math.abs(aim.x - 3.5) < 1e-9 && aim.y > 65 && aim.y < 66, `aimed at ${aim}`);
    assert.ok(looks.every((l) => l.forced === true));
    // Steve stands 3 blocks east: a quarter turn the other way.
    assert.ok(Math.abs(h.bot.entity.yaw + Math.PI / 2) < 1e-9, `faces ${h.bot.entity.yaw}`);
  });

  it("turns to the player first, then nods: pitch reverses at least twice after the turn", async () => {
    const { h, looks } = await gestureWorld();
    await h.run(social.gesture, { kind: "nod", toward: "Alex" });
    // Alex stands 4 blocks west of the bot: mineflayer's yaw for west is a quarter turn.
    assert.ok(Math.abs((looks[0]?.yaw ?? Number.NaN) - Math.PI / 2) < 1e-9, `turned to ${looks[0]?.yaw}`);
    const pitch = looks.map((l) => l.pitch);
    assert.ok(reversals(pitch) >= 2, `pitch ${pitch.map((p) => Math.round((p * 180) / Math.PI))}`);
    const yaws = looks.map((l) => l.yaw);
    assert.equal(reversals(yaws), 0, "a nod does not turn the head sideways");
  });

  it("shakes: yaw reverses at least twice and ends where it faced", async () => {
    const { h, looks } = await gestureWorld();
    await h.run(social.gesture, { kind: "shake", toward: "Steve" });
    const yaws = looks.map((l) => l.yaw);
    assert.ok(reversals(yaws) >= 2, `yaw ${yaws.map((p) => Math.round((p * 180) / Math.PI))}`);
    assert.equal(reversals(looks.map((l) => l.pitch)), 0);
    assert.equal(yaws.at(-1), yaws[0]);
  });

  it("waves the arm at least twice", async () => {
    const { h, swings } = await gestureWorld();
    await h.run(social.gesture, { kind: "wave", toward: "Steve" });
    assert.ok(swings() >= 2);
  });

  it("without toward, gestures where the bot already faces: no turn to anyone", async () => {
    const { h, aims, looks } = await gestureWorld();
    assert.deepEqual(await h.run(social.gesture, { kind: "shake" }), { kind: "shake" });
    assert.equal(aims.length, 0);
    assert.ok(reversals(looks.map((l) => l.yaw)) >= 2);
  });

  it("presents the item by equipping it from outside the main hand, and reports it", async () => {
    const { h } = await gestureWorld();
    const held = () => h.bot.heldItem?.name ?? null;
    assert.equal(held(), null);
    assert.deepEqual(await h.run(social.gesture, { kind: "present", toward: "Steve", item: "minecraft:bread" }), { kind: "present", toward: "Steve", item: "bread" });
    assert.equal(held(), "bread");
  });

  it("presents what is already in hand when no item is given", async () => {
    const { h } = await gestureWorld({ carrying: { apple: 2, bread: 1 }, holding: "apple" });
    assert.deepEqual(await h.run(social.gesture, { kind: "present" }), { kind: "present", item: "apple" });
    assert.equal(h.bot.heldItem?.name, "apple");
  });
});

describe("social.gesture: errors say the cause and the fix", () => {
  /** A refused call moves nothing: no turn, no look, no control. */
  async function refused(args: Record<string, unknown>, message: RegExp, options: Parameters<typeof gestureWorld>[0] = {}): Promise<string> {
    const world = await gestureWorld(options);
    const error = await world.h.run(social.gesture, args as never).then(
      () => assert.fail("the call was not refused"),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    assert.match(error, message);
    assert.deepEqual([world.aims.length, world.looks.length, world.controls.length, world.swings()], [0, 0, 0, 0], "the body moved before the refusal");
    return error;
  }

  it("a player who is not in view: names them, says why, lists who is", async () => {
    const error = await refused({ kind: "wave", toward: "Herobrine" }, /"Herobrine".*is not online.*players in view: Steve, Alex/);
    assert.doesNotMatch(error, /TypeError|undefined/);
  });

  it("a player who is online but out of view: says to walk closer", async () => {
    const world = await gestureWorld();
    world.h.bot.players.Farmer = { username: "Farmer", entity: null, ping: 0 } as never;
    await assert.rejects(world.h.run(social.gesture, { kind: "nod", toward: "Farmer" }), /"Farmer".*online but not in view.*move\.to.*players in view: Steve, Alex/);
  });

  it("with nobody in view: says so", async () => {
    const h = createHarness();
    await assert.rejects(h.run(social.gesture, { kind: "wave", toward: "Steve" }), /"Steve".*no other players are in view/);
  });

  it("toward the bot itself", async () => {
    await refused({ kind: "wave", toward: "harness" }, /"harness" is this bot itself: name another player/);
  });

  it("look without toward names toward", async () => {
    await refused({ kind: "look" }, /"look" needs `toward`.*username/);
  });

  it("present with no item and an empty hand says to pass item", async () => {
    await refused({ kind: "present", toward: "Steve" }, /main hand is empty.*Pass `item`/);
  });

  it("an item that is not in the inventory names it and what is carried", async () => {
    await refused({ kind: "present", item: "diamond" }, /cannot present "diamond".*it holds apple, bread/);
    await refused({ kind: "present", item: "diamond" }, /the inventory is empty/, { carrying: {} });
  });

  it("item with another kind is refused rather than ignored", async () => {
    await refused({ kind: "wave", item: "bread" }, /`item` only goes with kind "present".*"wave"/);
  });

  it("an unknown kind lists the kinds", async () => {
    const h = createHarness();
    await assert.rejects(h.run(social.gesture, { kind: "dance" } as never), (error: Error) => KINDS.every((kind) => error.message.includes(kind)));
  });
});
