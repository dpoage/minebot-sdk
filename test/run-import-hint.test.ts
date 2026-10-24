// A run's misplaced import: the incident's shape — a static `import` written inside `export default`'s
// function body — is explained where the loader explains a top-level `return` (explainImport, beside
// explainReturn). Only the run's own parse error: a library module's parse error, a SyntaxError the
// run throws, and an `export` inside a function (the parser blames it with the same message) are left
// as the parser said them. Every hint is a drop-in: written where the declaration is, the run parses
// and binds every name the static form bound — under tab indentation (the parser's code frame draws a
// tab as spaces, so the caret column is a display column), through trailing commas, string and
// unicode names, comments in the clause, and with import attributes carried into the dynamic form —
// and what no drop-in exists for (an `assert` clause, which a dynamic import cannot carry) stays bare.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, removeScratch, startFakeBody, type FakeBodyOptions } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const runOf = (answer: { status: number; body: unknown }): RunResult => {
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body as RunResult;
};

async function using<T>(options: FakeBodyOptions, test: (body: FakeBody) => Promise<T>): Promise<T> {
  const body = await startFakeBody(options);
  try {
    return await test(body);
  } finally {
    await body.close();
  }
}

const run = (body: FakeBody, code: string) => body.request("POST", "/run", { code });

/** The run whose default function holds the import `statement` (line 2 of the source). */
const inside = (statement: string) => `export default async (ctx) => {\n  ${statement}\n  return 1;\n};\n`;

/**
 * Each import the tests place inside a function: the whole source, the offending statement in it, the
 * dynamic form the hint must show exactly, and the local names the static form bound. A drop-in must
 * still bind them: the substituted run returns them, and a name the hint dropped is a ReferenceError.
 */
const CASES: readonly (readonly [code: string, statement: string, dynamic: string, names: readonly string[]])[] = [
  [inside('import * as move from "minebot-sdk/routines/move";'), 'import * as move from "minebot-sdk/routines/move";', "const move = await import(\"minebot-sdk/routines/move\")", ["move"]],
  [inside('import { goals } from "mineflayer-pathfinder";'), 'import { goals } from "mineflayer-pathfinder";', "const { goals } = await import(\"mineflayer-pathfinder\")", ["goals"]],
  [inside('import os from "node:os";'), 'import os from "node:os";', "const { default: os } = await import(\"node:os\")", ["os"]],
  [inside('import def, { x as y } from "vec3";'), 'import def, { x as y } from "vec3";', "const { default: def, x: y } = await import(\"vec3\")", ["def", "y"]],
  [inside('import def, * as ns from "vec3";'), 'import def, * as ns from "vec3";', "const { default: def, ...ns } = await import(\"vec3\")", ["def", "ns"]],
  [inside('import "node:os";'), 'import "node:os";', "await import(\"node:os\")", []],
  // a named list with a trailing comma, over one or many lines, hints as the list without the comma
  [inside('import { a, b, } from "vec3";'), 'import { a, b, } from "vec3";', "const { a, b } = await import(\"vec3\")", ["a", "b"]],
  ["export default async (ctx) => {\n  import {\n    a,\n    b as c,\n  } from \"vec3\";\n  return 1;\n};\n", "import {\n    a,\n    b as c,\n  } from \"vec3\";", "const { a, b: c } = await import(\"vec3\")", ["a", "c"]],
  ["export default async (ctx) => {\r\n  import {\r\n    a,\r\n    b as c,\r\n  } from \"vec3\";\r\n  return 1;\r\n};\r\n", "import {\r\n    a,\r\n    b as c,\r\n  } from \"vec3\";", "const { a, b: c } = await import(\"vec3\")", ["a", "c"]],
  // a default binding never drops its named list: trailing comma, string name, unicode name, a comment in the clause, many lines
  [inside('import def, { Vec3, } from "vec3";'), 'import def, { Vec3, } from "vec3";', "const { default: def, Vec3 } = await import(\"vec3\")", ["def", "Vec3"]],
  [inside('import def, { "a-b" as c } from "vec3";'), 'import def, { "a-b" as c } from "vec3";', "const { default: def, \"a-b\": c } = await import(\"vec3\")", ["def", "c"]],
  [inside("import def, { café } from \"vec3\";"), "import def, { café } from \"vec3\";", "const { default: def, café } = await import(\"vec3\")", ["def", "café"]],
  [inside('import def, /* keep */ { a } from "vec3";'), 'import def, /* keep */ { a } from "vec3";', "const { default: def, a } = await import(\"vec3\")", ["def", "a"]],
  ["export default async (ctx) => {\n  import def, {\n    a,\n    b,\n  } from \"vec3\";\n  return 1;\n};\n", "import def, {\n    a,\n    b,\n  } from \"vec3\";", "const { default: def, a, b } = await import(\"vec3\")", ["def", "a", "b"]],
  // tab indentation: the caret column is a display column, mapped onto the source's own
  ["export default async (ctx) => {\n\tconst a = 1;\n\timport * as move from \"minebot-sdk/routines/move\";\n\treturn a;\n};\n", "import * as move from \"minebot-sdk/routines/move\";", "const move = await import(\"minebot-sdk/routines/move\")", ["a", "move"]],
  ["export default async (ctx) => {\n\tconst a = 1; import * as move from \"minebot-sdk/routines/move\";\n\treturn a;\n};\n", "import * as move from \"minebot-sdk/routines/move\";", "const move = await import(\"minebot-sdk/routines/move\")", ["a", "move"]],
  ["export default async (ctx) => {\nconst a = 1;\timport * as m from \"vec3\";\nreturn a;\n};\n", "import * as m from \"vec3\";", "const m = await import(\"vec3\")", ["a", "m"]],
  // import attributes ride into the dynamic form
  [inside('import data from "minecraft-data/package.json" with { type: "json" };'), 'import data from "minecraft-data/package.json" with { type: "json" };', "const { default: data } = await import(\"minecraft-data/package.json\", { with: { type: \"json\" } })", ["data"]],
];

describe("a run with a static import inside a function", () => {
  it("names the line, says to move the import above `export default`, and shows the dynamic form for every import shape, keeping the parser's message", async () => {
    await using({}, async (body) => {
      for (const [code, , dynamic] of CASES) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error", code);
        assert.match(answer.error ?? "", /line \d+/, code);
        assert.match(answer.error ?? "", /above `export default`/, code);
        assert.ok((answer.error ?? "").includes(dynamic), `${code}: ${answer.error}`);
        assert.match(answer.error ?? "", /cannot be used outside of module code\)$/, code);
      }
    });
  });

  it("writes a hint that is a drop-in: where the declaration is, the run parses and binds the names the static form bound", async () => {
    await using({}, async (body) => {
      for (const [code, statement, dynamic, names] of CASES) {
        const answer = runOf(await run(body, code));
        assert.equal(/write `([^`]+)` instead/.exec(answer.error ?? "")?.[1], dynamic, code);
        const substituted = code.replace(statement, dynamic).replace(/return [^;\n]*;/, `return [${names.join(", ")}];`);
        const done = runOf(await run(body, substituted));
        assert.equal(done.status, "ok", `${code}\n-> ${dynamic}: ${JSON.stringify(done)}`);
      }
    });
  });

  it("finds the declaration wherever it sits: deeper in a block, on a one-line run, and spread over lines", async () => {
    await using({}, async (body) => {
      const cases = [
        [
          "export default async (ctx) => {\n  if (true) {\n    import * as move from \"minebot-sdk/routines/move\";\n  }\n};\n",
          /line 3[\s\S]*const move = await import\("minebot-sdk\/routines\/move"\)/,
        ],
        [
          "export default async (ctx) => { import * as move from \"minebot-sdk/routines/move\"; };\n",
          /line 1[\s\S]*const move = await import\("minebot-sdk\/routines\/move"\)/,
        ],
        [
          "export default async (ctx) => {\n  import {\n    a, b as c\n  } from \"vec3\";\n  return 1;\n};\n",
          /line 2[\s\S]*const \{ a, b: c \} = await import\("vec3"\)/,
        ],
      ] as const;
      for (const [code, expected] of cases) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error", code);
        assert.match(answer.error ?? "", expected, code);
        assert.match(answer.error ?? "", /above `export default`/, code);
      }
    });
  });

  it("carries import attributes into the dynamic form, so the hinted line loads what the declaration named", async () => {
    await using({}, async (body) => {
      const done = runOf(await run(body, "export default async (ctx) => {\n  const { default: data } = await import(\"minecraft-data/package.json\", { with: { type: \"json\" } });\n  return data.name;\n};\n"));
      assert.equal(done.status, "ok");
      assert.equal(done.result, "minecraft-data");
    });
  });

  it("tells a type-only import that it runs no code", async () => {
    await using({}, async (body) => {
      const answer = runOf(await run(body, inside("import type { T } from \"vec3\";")));
      assert.equal(answer.status, "error");
      assert.match(answer.error ?? "", /line 2 has `import type` inside a function; a type-only import runs no code, so delete it or move it above `export default`/);
    });
  });

  it("leaves an `export` inside a function, an `assert` attribute clause, a different syntax error, a thrown SyntaxError, and a library module's parse error as the parser said them", async () => {
    await using({}, async (body) => {
      body.writeRoutines({ badlib: "const f = () => {\n  import * as x from 'vec3';\n};\nexport default f;\n" });
      const cases = {
        "an export statement inside a function": ["export default () => {\n  export const x = 1;\n  return x;\n};\n", /SyntaxError: 'import', and 'export' cannot be used outside of module code/],
        "an import whose `assert` attribute clause a dynamic import cannot carry": [
          "export default async (ctx) => {\n  import data from \"minecraft-data/package.json\" assert { type: \"json\" };\n  return data;\n};\n",
          /SyntaxError: 'import', and 'export' cannot be used outside of module code/,
        ],
        "a different syntax error": ["export default (;", /SyntaxError: Expression expected/],
        "a SyntaxError the run throws, with the parser's message": [
          "throw new SyntaxError(\"'import', and 'export' cannot be used outside of module code\");\n",
          /^SyntaxError: 'import', and 'export' cannot be used outside of module code/,
        ],
        "a library module's own misplaced import": ["import f from './badlib.ts';\nexport default f;\n", /badlib\.ts:2[\s\S]*SyntaxError: 'import', and 'export' cannot be used outside of module code/],
      } as const;
      for (const [name, [code, error]] of Object.entries(cases)) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error", name);
        assert.match(answer.error ?? "", error, name);
        assert.doesNotMatch(answer.error ?? "", /above `export default`|await import\(/, name);
      }
    });
  });
});
