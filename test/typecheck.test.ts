import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_ROOT } from "../src/package.ts";
import { typeCheckKit } from "../src/host/typecheck.ts";
import type { KitSchema } from "../src/protocol/index.ts";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { promisify } from "node:util";
import { typeCheckRoutine } from "../src/host/typecheck.ts";
import type { KitTypeCheck } from "../src/protocol/index.ts";

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

describe("typeCheckRoutine", () => {
  const roots: string[] = [];
  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** A routine library holding `files`, in a directory of its own below a root the test can put more in. */
  async function library(files: Record<string, string>): Promise<{ dir: string; root: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "minebot-routine-check-test-"));
    roots.push(root);
    const dir = path.join(root, "routines");
    await mkdir(dir);
    for (const [name, source] of Object.entries(files)) await writeFile(path.join(dir, `${name}.ts`), source);
    return { dir, root };
  }

  const failing = (check: KitTypeCheck): string[] => {
    assert.ok(check.status === "failed", JSON.stringify(check));
    return check.errors;
  };

  it("passes a module that imports vec3, zod, a type of mineflayer, a built-in, the package, and a sibling module", async () => {
    const { dir } = await library({
      walk: `import os from "node:os";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { z as kitZ } from "minebot-sdk/kit";
import { double } from "./helper.ts";

const Args = z.object({ n: z.number() });
const origin = new Vec3(0, 64, 0);

export default async function (bot: Bot, args: z.infer<typeof Args>): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return double(Args.parse(args).n + origin.y + os.cpus().length + kitZ.number().parse(1)) + bot.health;
}
`,
      helper: "export const double = (n: number): number => n * 2;\n",
    });
    assert.deepEqual(await typeCheckRoutine(dir, "walk"), { status: "passed" });
  });

  it("reports only the errors in the routine's own file, though the module it imports has errors too", async () => {
    const { dir } = await library({
      walk: 'import { double } from "./helper.ts";\nexport default (): string => double(2);\nconst n: number = "x";\n',
      helper: 'export const double = (n: number): number => n * "2";\n',
    });
    const errors = failing(await typeCheckRoutine(dir, "walk"));
    assert.equal(errors.length, 2, errors.join("\n"));
    assert.match(errors[0]!, /^walk\.ts\(2,\d+\): error TS2322: /);
    assert.match(errors[1]!, /^walk\.ts\(3,\d+\): error TS2322: /);
    assert.ok(errors.every((error) => !error.includes("helper.ts(")), errors.join("\n"));
    // The helper's own check is where its error shows.
    assert.match(failing(await typeCheckRoutine(dir, "helper")).join("\n"), /^helper\.ts\(1,\d+\): error TS2363/);
    const { dir: only } = await library({ walk: 'import { double } from "./helper.ts";\nexport default () => double(2);\n', helper: 'export const double = (n: number): number => n * "2";\n' });
    assert.deepEqual(await typeCheckRoutine(only, "walk"), { status: "passed" });
  });

  it("fails a module the runtime cannot load as it stands: a type imported as a value, or syntax that is not only types", async () => {
    const cases: Record<string, RegExp> = {
      value: /^value\.ts\(1,\d+\): error TS1484: 'Bot' is a type and must be imported using a type-only import/,
      enumeration: /^enumeration\.ts\(1,\d+\): error TS1294: /,
      member: /^member\.ts\(1,\d+\): error TS1294: /,
      space: /^space\.ts\(1,\d+\): error TS1294: /,
    };
    const { dir } = await library({
      value: 'import { Bot } from "mineflayer";\nexport default (bot: Bot) => bot.health;\n',
      enumeration: "enum Dir { N, S }\nexport default Dir.N;\n",
      member: "export default class { constructor(private n: number) {} }\n",
      space: "namespace Geo { export const north = 1; }\nexport default Geo.north;\n",
    });
    for (const [name, pattern] of Object.entries(cases)) {
      const errors = failing(await typeCheckRoutine(dir, name));
      assert.match(errors[0]!, pattern, `${name}: ${errors.join("\n")}`);
    }
  });

  it("fails an import that leaves the library, as loading it would", async () => {
    const { dir } = await library({
      walk: 'import { x } from "../elsewhere.ts";\nimport { y } from "./sub/y.ts";\nexport default [x, y];\n',
    });
    const errors = failing(await typeCheckRoutine(dir, "walk"));
    assert.equal(errors.filter((error) => /TS2307/.test(error)).length, 2, errors.join("\n"));
  });

  it("resolves packages as the body does, whatever node_modules sits above the library", async () => {
    const { dir, root } = await library({ walk: 'import { Vec3 } from "vec3";\nexport default new Vec3(0, 1, 2).y;\n' });
    await mkdir(path.join(root, "node_modules/vec3"), { recursive: true });
    await writeFile(path.join(root, "node_modules/vec3/package.json"), '{ "name": "vec3", "version": "0.0.0", "types": "index.d.ts" }');
    await writeFile(path.join(root, "node_modules/vec3/index.d.ts"), "export declare const Imposter: number;\n");
    assert.deepEqual(await typeCheckRoutine(dir, "walk"), { status: "passed" });
  });

  it("reports the routine's errors, and only those, whether the temp directory and the working directory are real paths or symlinks", async () => {
    const { dir, root } = await library({
      enumeration: "enum Dir { N, S }\nexport default Dir.N;\n",
      value: 'import { Bot } from "mineflayer";\nexport default (bot: Bot) => bot.health;\n',
      plain: 'import { double } from "./helper.ts";\nconst f: (n: number) => string = (s: string) => s;\nexport default [f, double(1)];\n',
      helper: 'export const double = (n: number): number => n * "2";\n',
    });
    const expected: Record<string, RegExp> = {
      enumeration: /^enumeration\.ts\(1,\d+\): error TS1294: /,
      value: /^value\.ts\(1,\d+\): error TS1484: /,
      // A diagnostic over several lines, its continuation lines kept with it.
      plain: /^plain\.ts\(2,\d+\): error TS2322: .*\n\s+Types of parameters/,
    };
    const real = await realpath(root);
    const tmp = path.join(real, "tmp");
    const cwd = path.join(real, "cwd");
    for (const place of [tmp, cwd]) {
      await mkdir(place);
      await symlink(place, `${place}-link`);
    }
    const script = `import { typeCheckRoutine } from ${JSON.stringify(new URL("../src/host/typecheck.ts", import.meta.url).href)};
const checks = {};
for (const name of ${JSON.stringify(Object.keys(expected))}) checks[name] = await typeCheckRoutine(${JSON.stringify(dir)}, name);
console.log(JSON.stringify(checks));`;
    // os.tmpdir() is TMPDIR as given; a shell cd'd through a link exports PWD as the link.
    const environments = [tmp, `${tmp}-link`].flatMap((tempDir) => [cwd, `${cwd}-link`].map((workDir) => ({ tempDir, workDir })));
    const results = await Promise.all(
      environments.map(async ({ tempDir, workDir }) => {
        const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=minebot-sdk:source", "--input-type=module", "--eval", script], {
          cwd: workDir,
          env: { ...process.env, TMPDIR: tempDir, PWD: workDir },
        });
        return { where: `TMPDIR=${tempDir} cwd=${workDir}`, checks: JSON.parse(stdout) as Record<string, KitTypeCheck> };
      }),
    );
    for (const { where, checks } of results) {
      for (const [name, pattern] of Object.entries(expected)) {
        const check = checks[name]!;
        assert.ok(check.status === "failed", `${where} ${name}: ${JSON.stringify(check)}`);
        assert.equal(check.errors.length, 1, `${where} ${name}: ${check.errors.join("\n")}`);
        assert.match(check.errors[0]!, pattern, `${where} ${name}`);
      }
    }
    assert.deepEqual(await readdir(tmp), [], "the checks leave no temp project behind");
  });

  it("skips, with the reason, when there is no such routine", async () => {
    const { dir } = await library({ walk: "export default 1;\n" });
    for (const name of ["nope", "../walk", "Walk"]) {
      const check = await typeCheckRoutine(dir, name);
      assert.ok(check.status === "skipped", JSON.stringify(check));
      assert.match(check.reason, /no routine/);
    }
  });

  it("skips, with the reason, when typescript cannot be resolved", async () => {
    const { dir } = await library({ walk: "export default 1;\n" });
    const hide = new URL("./fixtures/routines/hide-typescript.cjs", import.meta.url).pathname;
    const script = `import { typeCheckRoutine } from ${JSON.stringify(new URL("../src/host/typecheck.ts", import.meta.url).href)};
console.log(JSON.stringify(await typeCheckRoutine(${JSON.stringify(dir)}, "walk")));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=minebot-sdk:source", "--require", hide, "--input-type=module", "--eval", script]);
    const check = JSON.parse(stdout) as KitTypeCheck;
    assert.ok(check.status === "skipped", stdout);
    assert.match(check.reason, /typescript is not installed/);
  });

  it("skips, without throwing, when it is aborted", async () => {
    const { dir } = await library({ walk: "export default 1;\n" });
    const check = await typeCheckRoutine(dir, "walk", AbortSignal.abort());
    assert.ok(check.status === "skipped", JSON.stringify(check));
    assert.match(check.reason, /aborted/);
  });
});
