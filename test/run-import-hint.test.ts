// A run's misplaced import: the incident's shape — a static `import` written inside `export default`'s
// function body — is explained where the loader explains a top-level `return` (explainImport, beside
// explainReturn). The message names the parser's line, says to move the import above `export default`,
// and shows `const <name> = await import("<specifier>")` as an example for inside an async function —
// an example, not a drop-in: a callback that is not async cannot hold `await`. Only the run's own
// parse error: a library module's parse error, a SyntaxError the run throws, and an `export` inside a
// function (the parser blames it with the same message) are left as the parser said them.
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
  it("names the parser's line, says to move the import above `export default`, and shows the dynamic form as an example for inside an async function", async () => {
    await using({}, async (body) => {
      const cases = [
        // the incident's shape: a namespace import, under space or tab indentation
        [inside('import * as move from "minebot-sdk/routines/move";'), /line 2[\s\S]*const move = await import\("minebot-sdk\/routines\/move"\)/],
        ["export default async (ctx) => {\n\tconst a = 1;\n\timport * as move from \"minebot-sdk/routines/move\";\n\treturn a;\n};\n", /line 3[\s\S]*const move = await import\("minebot-sdk\/routines\/move"\)/],
        // every other import shape names the module the same way, under the literal name `mod`
        [inside('import os from "node:os";'), /line 2[\s\S]*const mod = await import\("node:os"\)/],
        [inside('import { goals } from "mineflayer-pathfinder";'), /line 2[\s\S]*const mod = await import\("mineflayer-pathfinder"\)/],
        [inside('import "node:os";'), /line 2[\s\S]*const mod = await import\("node:os"\)/],
        // a named list that runs over lines still gives up its specifier
        ["export default async (ctx) => {\n  import {\n    a,\n    b as c,\n  } from \"vec3\";\n  return 1;\n};\n", /line 2[\s\S]*const mod = await import\("vec3"\)/],
      ] as const;
      for (const [code, example] of cases) {
        const answer = runOf(await run(body, code));
        assert.equal(answer.status, "error", code);
        assert.match(answer.error ?? "", /above `export default`[\s\S]*line \d+ has one inside a function; inside an async function[\s\S]*loads it at run time \('import', and 'export' cannot be used outside of module code\)$/, code);
        assert.match(answer.error ?? "", example, code);
      }
    });
  });

  it("explains an import inside a callback that is not async, where `await` would not parse: the dynamic form is an example, not a drop-in", async () => {
    await using({}, async (body) => {
      const answer = runOf(await run(body, "export default async (ctx) => {\n  ctx.bot.once(\"chat\", (u, m) => {\n    import { Vec3 } from \"vec3\";\n    return m;\n  });\n  return 1;\n};\n"));
      assert.equal(answer.status, "error");
      assert.match(answer.error ?? "", /line 3 has one inside a function; inside an async function, `const mod = await import\("vec3"\)` loads it at run time/);
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
