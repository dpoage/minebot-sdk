// A run's misplaced import: the incident's shape — a static `import` written inside `export default`'s
// function body — is explained where the loader explains a top-level `return` (explainImport, beside
// explainReturn). Only the run's own parse error: a library module's parse error, a SyntaxError the
// run throws, and an `export` inside a function (the parser blames it with the same message) are left
// as the parser said them.
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

describe("a run with a static import inside a function", () => {
  it("names the line, says to move the import above `export default`, and shows the dynamic form for every import shape, keeping the parser's message", async () => {
    await using({}, async (body) => {
      const shapes = [
        ['import * as move from "minebot-sdk/routines/move";', "const move = await import(\"minebot-sdk/routines/move\")"],
        ['import { goals } from "mineflayer-pathfinder";', "const { goals } = await import(\"mineflayer-pathfinder\")"],
        ['import os from "node:os";', "const { default: os } = await import(\"node:os\")"],
        ['import def, { x as y } from "vec3";', "const { default: def, x: y } = await import(\"vec3\")"],
        ['import "node:os";', "await import(\"node:os\")"],
      ] as const;
      for (const [statement, dynamic] of shapes) {
        const answer = runOf(await run(body, inside(statement)));
        assert.equal(answer.status, "error", statement);
        assert.match(answer.error ?? "", /line 2/, statement);
        assert.match(answer.error ?? "", /above `export default`/, statement);
        assert.ok((answer.error ?? "").includes(dynamic), `${statement}: ${answer.error}`);
        assert.match(answer.error ?? "", /cannot be used outside of module code\)$/, statement);
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

  it("tells a type-only import that it runs no code", async () => {
    await using({}, async (body) => {
      const answer = runOf(await run(body, inside("import type { T } from \"vec3\";")));
      assert.equal(answer.status, "error");
      assert.match(answer.error ?? "", /line 2 has `import type` inside a function; a type-only import runs no code, so delete it or move it above `export default`/);
    });
  });

  it("leaves an `export` inside a function, a different syntax error, a thrown SyntaxError, and a library module's parse error as the parser said them", async () => {
    await using({}, async (body) => {
      body.writeRoutines({ badlib: "const f = () => {\n  import * as x from 'vec3';\n};\nexport default f;\n" });
      const cases = {
        "an export statement inside a function": ["export default () => {\n  export const x = 1;\n  return x;\n};\n", /SyntaxError: 'import', and 'export' cannot be used outside of module code/],
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
