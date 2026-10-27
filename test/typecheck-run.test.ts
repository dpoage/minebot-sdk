// The check of a run (typeCheckRun): which of the compiler's diagnostics refuse a run, where they point,
// and how a run's default function is typed. The refusal set is the one the replay of Rivet's history chose:
// a name that is not defined, a value that is not callable, a call with the wrong number of arguments, a
// key the object's type does not have, and a member the type does not have where it is called.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkedText } from "../src/host/typecheck-run.ts";
import { closeRunCheck, typeCheckRun } from "../src/host/typecheck.ts";
import type { TypeCheck } from "../src/protocol/index.ts";

describe("checkedText", () => {
  const types = (source: string) => checkedText(source).slice(source.length);

  it("types the default export without moving a character of the source", () => {
    for (const source of [
      "export default async (ctx, args) => 1;\n",
      "const a = 1;\n\texport  default (ctx) => a;\n",
      "export default function (ctx) {}\n",
      "export default/* c */(ctx) => 1;",
    ]) {
      const text = checkedText(source);
      assert.equal(text.slice(0, source.length).length, source.length);
      assert.match(text.slice(0, source.length), /const \$r:\$R=/);
      assert.equal(text.slice(0, source.length).replace(/const \$r:\$R= */, "").replace(/\s/g, ""), source.replace(/export\s+default/, "").replace(/\s/g, ""));
      assert.match(types(source), /RoutineContext as \$RC/);
    }
  });

  it("keeps the line and column of everything after the default export", () => {
    const source = "const a = 1;\nexport default async (ctx) => {\n  return ctx.bot.foo(a);\n};\n";
    const lines = checkedText(source).split("\n");
    assert.equal(lines[2], "  return ctx.bot.foo(a);");
    assert.equal(lines[1]!.length, "export default async (ctx) => {".length);
  });

  it("leaves alone a source whose `export default` is in a comment, a string, or a template", () => {
    for (const source of [
      "// export default async (ctx) => 1\nexport const x = 1;\n",
      "/* export default 1 */ const s = 'export default 1';\n",
      "const t = `a ${'}'} export default 2 ${1}`;\nconst r = /export default \"/;\n",
    ]) assert.equal(checkedText(source), source);
  });

  it("finds the export default after a regular expression holding a quote", () => {
    const source = 'const r = /"/g;\nexport default (ctx) => r;\n';
    assert.match(checkedText(source), /^const r = \/"\/g;\nconst \$r:\$R= +\(ctx\) => r;/);
  });

  it("declares the name of a default function again, and leaves a class or a type declaration alone", () => {
    assert.match(types("export default async function main(ctx) { return main; }\n"), /declare const main: any;/);
    assert.doesNotMatch(types("export default function (ctx) {}\n"), /declare const/);
    for (const source of ["export default class Run {}\n", "export default interface Run {}\n"]) assert.equal(checkedText(source), source);
  });
});

describe("typeCheckRun", () => {
  const roots: string[] = [];
  after(async () => {
    // The warm checker's compiler child would otherwise keep this process alive.
    await closeRunCheck();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** An empty directory for a library, so runs have no sibling modules. */
  async function emptyLibrary(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "minebot-run-check-test-"));
    roots.push(dir);
    return dir;
  }

  const refused = async (source: string): Promise<string[]> => {
    const check: TypeCheck = await typeCheckRun(await emptyLibrary(), source);
    assert.ok(check.status === "failed", JSON.stringify(check));
    return check.errors;
  };

  const passes = async (source: string) => assert.deepEqual(await typeCheckRun(await emptyLibrary(), source), { status: "passed" }, source);

  it("refuses a call of a member the bot does not have, at the member's line and column, whatever form the default export takes", { timeout: 120_000 }, async () => {
    const body = "  ctx.bot.selectItem(null);\n";
    const forms = [
      `export default async (ctx) => {\n${body}};\n`,
      `export default async function (ctx, args) {\n${body}}\n`,
      `export default async function main(ctx) {\n${body}}\n`,
      `export default function* (ctx) {\n${body}}\n`,
      `const note = 'export default x';\n// export default y\nexport default async (ctx, args) => {\n${body}};\n`,
    ];
    for (const source of forms) {
      const line = source.split("\n").findIndex((l) => l.includes("selectItem")) + 1;
      const column = source.split("\n")[line - 1]!.indexOf("selectItem") + 1;
      const errors = await refused(source);
      assert.equal(errors.length, 1, source);
      assert.match(errors[0]!, new RegExp(`^line ${line}:${column} Property 'selectItem' does not exist on type`), source);
    }
  });

  it("refuses the other classes of the set: an undefined name, a call of a non-function, the wrong number of arguments, a key the type lacks", { timeout: 120_000 }, async () => {
    const errors = await refused(
      [
        "import { Vec3 } from 'vec3';",
        "export default async (ctx) => {",
        "  dig(ctx.bot);", // 2304
        "  const n: number = 3;",
        "  n();", // 2349
        "  new Vec3(1, 2);", // 2554
        "  ctx.log(ctx.bot.entity.position.offset(1, 2));", // 2554
        "  ctx.store({ extra: 1 } as never);",
        "  const pos: { x: number } = { x: 1, y: 2 };", // 2353
        "};",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      errors.map((e) => e.slice(0, e.indexOf(" ", e.indexOf(" ") + 1))),
      ["line 3:3", "line 5:3", "line 6:3", "line 7:35", "line 9:38"],
    );
    assert.match(errors[0]!, /Cannot find name 'dig'/);
  });

  it("names the real member under a refused call of a bot member, replacing TypeScript's own 'Did you mean'", { timeout: 120_000 }, async () => {
    const errors = await refused(
      [
        "export default async (ctx) => {",
        "  ctx.bot.selectItem(null);",
        "  ctx.bot.inventory.findItem('stone');",
        "  ctx.bot.inventory.items.filter((i) => i);",
        "};",
        "",
      ].join("\n"),
    );
    assert.equal(errors.length, 3, errors.join("\n"));
    assert.match(errors[0]!, /^line 2:11 Property 'selectItem' does not exist on type 'Bot'/m);
    assert.equal(errors[0]!.split("\n")[1], '  bot.selectItem does not exist: use bot.equip(item, "hand")');
    assert.doesNotMatch(errors[0]!, /Did you mean/);
    assert.equal(errors[1]!.split("\n")[1], "  bot.inventory.findItem does not exist: use bot.inventory.items().find(...)");
    assert.equal(errors[2]!.split("\n")[1], "  bot.inventory.items.filter does not exist (bot.inventory.items is a method): use bot.inventory.items().filter(...)");
  });

  it("names no member when the receiver is not the bot, or the member is not called", { timeout: 120_000 }, async () => {
    const errors = await refused("export default async (ctx) => {\n  const b = ctx.bot;\n  b.selectItem(null);\n};\n");
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.equal(errors[0]!.includes("\n"), false, errors[0]!);
  });

  it("does not refuse an unknown name that is only probed with typeof, and refuses any other use of it", { timeout: 120_000 }, async () => {
    // `typeof triggers` answers "undefined" instead of throwing, so the probe is not the failure the check predicts.
    await passes("export default (ctx) => [typeof triggers, 'triggers' in ctx];\n");
    const called = await refused("export default (ctx) => {\n  triggers();\n};\n");
    assert.match(called[0]!, /^line 2:3 Cannot find name 'triggers'/);
    // `typeof` protects a bare name only: a member access of it still throws at run time.
    const member = await refused("export default (ctx) => typeof triggers.chat;\n");
    assert.match(member[0]!, /^line 1:\d+ Cannot find name 'triggers'/);
  });

  it("lists the errors in the order of the source", { timeout: 120_000 }, async () => {
    const errors = await refused("export default async (ctx) => {\n  b();\n  a();\n};\nc();\n");
    assert.deepEqual(errors.map((e) => e.split(" ")[1]), ["2:3", "3:3", "5:1"]);
  });

  it("runs a source whose only errors are outside the set: a missing member that is not called, a type mismatch, an unresolved module, an implicit any", { timeout: 120_000 }, async () => {
    await passes("export default async (ctx) => {\n  const p = ctx.bot.pathfinderless;\n  const n: number = 'x';\n  return [p, n];\n};\n");
    await passes("import { x } from 'no-such-package';\nexport default (ctx) => x;\n");
    await passes("export default async (ctx, args) => {\n  const f = (a) => a;\n  return f(args.n);\n};\n");
    await passes("export default async (ctx) => (ctx.bot as any).selectItem(null);\n");
    await passes("export default async (ctx) => ctx.bot.selectItem?.(null);\n");
  });

  it("runs a source with a grammar error, which Node's parser answers with its own hints", { timeout: 120_000 }, async () => {
    await passes("export default async (ctx) => {\n  continue;\n};\n");
    await passes("export default (;\n");
    await passes("export default async (ctx) => {\n  return ctx.bot.nope(;\n};\n");
  });

  it("gives the default function the run's context and args, with every real member of the context", { timeout: 120_000 }, async () => {
    await passes("export default async (ctx, args) => {\n  ctx.log(args.anything.at.all);\n  await ctx.sleep(1);\n  const p = ctx.bot.entity.position.floored();\n  return [ctx.notes.list(), ctx.store('x').keys(), p.x, ctx.bot.inventory.items().length, ctx.signal.aborted];\n};\n");
    await passes("export default { a: [1, 2] };\n");
    await passes("export default 42;\n");
    await passes("export default async function main(ctx) {\n  if (ctx.signal.aborted) return main;\n  return main(ctx);\n}\nconst again = main(1, 2, 3);\n");
  });

  it("does not check a source whose first line is // @ts-nocheck", { timeout: 120_000 }, async () => {
    await passes("// @ts-nocheck\nexport default async (ctx) => ctx.bot.selectItem(null);\n");
  });

  it("resolves the library's own modules and the built-in routine modules", { timeout: 120_000 }, async () => {
    await passes("import * as inventory from 'minebot-sdk/routines/inventory';\nimport { goals, Vec3 } from 'minebot-sdk/routine';\nexport default async (ctx) => [inventory, goals, new Vec3(1, 2, 3)];\n");
    const errors = await refused("import * as inventory from 'minebot-sdk/routines/inventory';\nexport default async (ctx) => inventory.noSuchRoutine(ctx);\n");
    assert.match(errors[0]!, /^line 2:\d+ Property 'noSuchRoutine' does not exist/);
  });

  it("skips, saying why, and never refuses, when the check is over its budget, and when it is aborted", { timeout: 120_000 }, async () => {
    const dir = await emptyLibrary();
    // A source the check would refuse: both skip paths answer `skipped`, never `failed`.
    const source = "export default async (ctx) => ctx.bot.selectItem(null);\n";
    assert.deepEqual(await typeCheckRun(dir, source, { budgetMs: 1 }), { status: "skipped", reason: "the type check took longer than 0.001 s" });
    assert.deepEqual(await typeCheckRun(dir, source, { signal: AbortSignal.abort() }), { status: "skipped", reason: "the type check was aborted" });
  });
});
