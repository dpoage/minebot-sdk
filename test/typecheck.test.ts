import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_ROOT } from "../src/package.ts";
import { typeCheckKit } from "../src/body/typecheck.ts";
import type { KitSchema } from "../src/protocol/index.ts";

const kit = (body: string, uses = '["move"]') => `import { action, defineKit, z } from "minebot-sdk/kit";

export default defineKit(
  { name: "woodcutter", description: "Chops logs.", uses: ${uses} },
  {
    chop: action({
      doc: "Chops.",
      args: z.object({ times: z.number().default(1) }),
      returns: z.object({ chopped: z.number() }),
      run: async (ctx, { times }) => {
${body}
        return { chopped: times };
      },
    }),
  },
);
`;

/** An agent kit the body offers, as its schema describes it. */
const HELPER: KitSchema = {
  name: "helper",
  description: "Counts things.",
  uses: [],
  active: true,
  agent: true,
  actions: {
    count: {
      doc: "Counts.",
      args: { type: "object", properties: { what: { type: "string" } }, required: ["what"], additionalProperties: false },
      returns: { type: "number" },
    },
  },
};

describe("typeCheckKit", () => {
  it("passes a kit whose calls fit the kits it uses", async () => {
    assert.deepEqual(await typeCheckKit(kit("        await ctx.kits.move.to({ position: [0, 64, 0] });"), "woodcutter", []), { status: "passed" });
  });

  it("reports each error with the kit's file, line, and column", async () => {
    const check = await typeCheckKit(kit('        await ctx.kits.move.to({ position: "home" });'), "woodcutter", []);
    assert.ok(check.status === "failed", JSON.stringify(check));
    assert.equal(check.errors.length, 1);
    assert.match(check.errors[0]!, /^woodcutter\.ts\(11,\d+\): error TS2322: /);
  });

  it("types ctx.kits from the schemas of the body's agent kits", async () => {
    const source = kit('        const n: string = await ctx.kits.helper.count({ what: "logs" });', '["helper"]');
    const check = await typeCheckKit(source, "woodcutter", [HELPER]);
    assert.ok(check.status === "failed", JSON.stringify(check));
    assert.match(check.errors.join("\n"), /Type 'number' is not assignable to type 'string'/);
    const fixed = kit('        const n: number = await ctx.kits.helper.count({ what: "logs" });', '["helper"]');
    assert.deepEqual(await typeCheckKit(fixed, "woodcutter", [HELPER]), { status: "passed" });
  });

  it("does not type a kit against an older schema of itself", async () => {
    const stale: KitSchema = { ...HELPER, name: "woodcutter" };
    assert.deepEqual(await typeCheckKit(kit("        await ctx.kits.move.stop();"), "woodcutter", [stale]), { status: "passed" });
  });

  it("passes the source of every built-in kit, the model agents copy", async () => {
    const dir = path.join(PACKAGE_ROOT, "src/kit/kits");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".ts"));
    const checks = await Promise.all(files.map(async (file) => [file, await typeCheckKit(await readFile(path.join(dir, file), "utf8"), file.slice(0, -3), [])] as const));
    assert.deepEqual(checks.filter(([, check]) => check.status !== "passed"), []);
  });

  it("skips, without throwing, when it cannot set up the check", async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = path.join(PACKAGE_ROOT, "no-such-dir", "tmp");
    try {
      const check = await typeCheckKit(kit("        await ctx.kits.move.stop();"), "woodcutter", []);
      assert.ok(check.status === "skipped", JSON.stringify(check));
      assert.match(check.reason, /could not run/);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});
