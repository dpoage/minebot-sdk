// Compile-time checks of the kit typing contract: `npm run typecheck` fails when `ctx.kits` stops
// being typed from `uses`, when zero-argument calls stop type-checking, or when a mistake that
// should be an error stops being one. The test body only proves the file loads.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { action, defineKit, type KitApi, z } from "minebot-sdk/kit";

const probe = defineKit(
  { name: "probe", description: "Calls other kits so the type checker sees every shape.", uses: ["inventory", "move", "dig", "survival", "explorer", "combat"] },
  {
    calls: action({
      doc: "Never run: its body exists to be type-checked.",
      args: z.object({}),
      returns: z.number(),
      run: async (ctx) => {
        // Actions whose schemas require no key take no argument at all.
        const held: Record<string, number> = await ctx.kits.inventory.list();
        await ctx.kits.move.stop();
        await ctx.kits.survival.eat();
        await ctx.kits.explorer.surface();
        await ctx.kits.combat.fight();
        await ctx.kits.combat.fight({ radius: 8 });
        // Results are typed from `returns`, with no cast.
        const count: number = await ctx.kits.inventory.count({ items: "stick" });
        const where: { x: number; y: number; z: number } = await ctx.kits.move.to({ position: [0, 64, 0] });
        const block: string | null = (await ctx.kits.dig.dig({ at: where })).block;

        // @ts-expect-error: a required argument is still required
        await ctx.kits.move.to();
        // @ts-expect-error: and so is the argument object
        await ctx.kits.inventory.count();
        // @ts-expect-error: a position is not a string
        await ctx.kits.move.to({ position: "x" });
        // @ts-expect-error: `sense` is not in this kit's uses
        await ctx.kits.sense.find({ blocks: "oak_log" });
        // @ts-expect-error: `move` has no such action
        await ctx.kits.move.teleport({});
        // @ts-expect-error: the result is a number, not a string
        const wrong: string = await ctx.kits.inventory.count({ items: "stick" });
        return count + Object.keys(held).length + (block === null ? 0 : 1) + wrong.length;
      },
    }),
    // @ts-expect-error: `run` must return what `returns` declares
    mismatch: action({ doc: "d", args: z.object({}), returns: z.string(), run: () => 5 }),
  },
);

/** The probe kit as callers see it. */
type ProbeApi = KitApi<typeof probe>;

describe("kit typing", () => {
  it("declares the kit the probe describes", () => {
    const names: (keyof ProbeApi)[] = ["calls", "mismatch"];
    assert.deepEqual(Object.keys(probe.actions), names);
    assert.deepEqual(probe.uses, ["inventory", "move", "dig", "survival", "explorer", "combat"]);
  });
});
