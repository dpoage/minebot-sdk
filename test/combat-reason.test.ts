// combat.attack gives up for one of four reasons, checked in this order: the target is gone, it is still
// in reach when the time runs out, it outran the player, or the way to it is blocked. An attack that kills
// does not carry a reason. The bot is stubbed (decision logic only) and the clock is fake, so a 20 s attack
// budget costs no real time.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { RoutineContext } from "../src/routine/context.ts";
import { attack } from "../src/routines/combat.ts";

/** A clock `ctx.sleep` advances: `Date.now` moves with the ticks, so an attack's budget runs instantly. */
interface Clock {
  advance(ms: number): void;
  restore(): void;
}

function fakeClock(): Clock {
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = real;
    },
  };
}

interface Sandbox {
  ctx: RoutineContext;
  target: Entity;
  /** Where the bot's feet are, shared with `bot.entity.position`: move it to simulate a failed chase. */
  player: Vec3;
  clock: Clock;
  /** Hits landed on the target so far. */
  readonly hits: number;
  /** Runs after every `ctx.sleep`, one tick at a time: drive the chase from here. */
  chase(fn: (tick: number) => void): void;
  /** Takes the target out of the world without a death. */
  vanish(): void;
  /** The server reports the target's death. */
  die(): void;
}

/** A fake bot with one sheep at `at`, on the stub context `combat.attack` needs. */
function sandbox(at: Vec3): Sandbox {
  const clock = fakeClock();
  const player = new Vec3(0, 64, 0);
  const target = { id: 2, name: "sheep", kind: "Animal", isValid: true, height: 1.3, position: at.clone() } as unknown as Entity;
  const entities: Record<number, Entity> = { [target.id]: target };
  const events = new EventEmitter();
  let hits = 0;
  let tick = 0;
  let chase: (tick: number) => void = () => {};
  const bot = Object.assign(events, {
    entity: { position: player, height: 1.8 },
    entities,
    health: 20,
    inventory: { items: () => [] as never[] },
    equip: async () => {},
    lookAt: async () => {},
    attack: () => {
      hits++;
    },
    clearControlStates: () => {},
    pathfinder: { setGoal: () => {} },
  });
  const ctx = {
    bot: bot as unknown as Bot,
    log: () => {},
    sleep: async (ms: number) => {
      clock.advance(ms);
      tick++;
      chase(tick);
    },
    signal: new AbortController().signal,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      events.on(event, handler);
    },
  } as unknown as RoutineContext;
  return {
    ctx,
    target,
    player,
    clock,
    get hits() {
      return hits;
    },
    chase: (fn) => {
      chase = fn;
    },
    vanish: () => {
      delete entities[target.id];
    },
    die: () => {
      events.emit("entityDead", target);
      delete entities[target.id];
    },
  };
}

describe("combat.attack give-up reasons", () => {
  it("says the target is gone when it leaves the world without dying", async () => {
    const s = sandbox(new Vec3(0, 64, 2));
    try {
      s.chase((tick) => {
        if (tick === 2) s.vanish();
      });
      const result = await attack(s.ctx, { target: "sheep", timeoutMs: 200 });
      assert.equal(result.killed, false);
      assert.equal(result.reason, "the target is gone (last seen 2.2 blocks away); find it again with sense.look or pick another");
    } finally {
      s.clock.restore();
    }
  });

  it("says it is still in reach when the time runs out there", async () => {
    const s = sandbox(new Vec3(0, 64, 2));
    try {
      const result = await attack(s.ctx, { target: "sheep", timeoutMs: 200 });
      assert.equal(result.killed, false);
      assert.equal(result.reason, "still in reach after the time ran out (hits landed: 1); call again to keep hitting");
      assert.equal(s.hits, 1);
    } finally {
      s.clock.restore();
    }
  });

  it("says it outran the player when the target covers six blocks in five seconds", async () => {
    const s = sandbox(new Vec3(0, 64, 8));
    try {
      s.chase(() => {
        s.target.position.z += 2.5;
      });
      const result = await attack(s.ctx, { target: "sheep", timeoutMs: 200 });
      assert.equal(result.killed, false);
      assert.equal(result.reason, "it outran you (closest 8.1 blocks, now 18); it moves faster than you follow; corner it or wait until it stops");
    } finally {
      s.clock.restore();
    }
  });

  it("says the way is blocked when the target stays put out of reach, even while the player runs", async () => {
    const s = sandbox(new Vec3(0, 64, 8));
    try {
      s.chase(() => {
        s.player.x += 2.5;
      });
      const result = await attack(s.ctx, { target: "sheep", timeoutMs: 200 });
      assert.equal(result.killed, false);
      assert.match(result.reason ?? "", /^could not get within reach \(closest 8\.1 blocks, now 12\.8\); the way is blocked: a wall, a fence or a drop; walk around it or pick another target$/);
    } finally {
      s.clock.restore();
    }
  });

  it("carries no reason when the target dies", async () => {
    const s = sandbox(new Vec3(0, 64, 2));
    try {
      s.chase((tick) => {
        if (tick === 1) s.die();
      });
      const result = await attack(s.ctx, { target: "sheep", timeoutMs: 200 });
      assert.deepEqual(result, { target: "sheep", killed: true, damageTaken: 0, weapon: null });
      assert.ok(!("reason" in result));
    } finally {
      s.clock.restore();
    }
  });
});
