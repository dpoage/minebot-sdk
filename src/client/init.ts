// `minebot init [dir]`: scaffolds an authoring workspace. A routine is a TypeScript module the body
// saves into its library; a run is a module `minebot run` sends to the body, whose `./` imports name
// library modules; `tsc` checks both against the package, and the harness tests a routine without a server.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../package.ts";

const EXAMPLE_ROUTINE = `// An example routine: copy it, rename it, and change what it does. Save it into a body's library
// with: npx minebot routines save routines/*.ts
import { defineRoutine, z } from "minebot-sdk/routine";
import * as inventory from "minebot-sdk/routines/inventory";

export default defineRoutine(
  {
    description: "Say \`message\` in chat, then report where the player stands and how many \`items\` it carries.",
    args: z.object({
      message: z.string().min(1).default("hello"),
      // An item name or glob for the inventory built-in: "oak_log" or "*_log".
      items: z.string().default("*_log"),
    }),
    returns: z.object({
      said: z.string(),
      position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      count: z.number(),
    }),
  },
  async (ctx, { message, items }) => {
    ctx.bot.chat(message);
    const at = ctx.bot.entity.position.floored();
    // A built-in routine is an import; calling it validates its arguments like any routine.
    const count = await inventory.count(ctx, { items });
    return { said: message, position: { x: at.x, y: at.y, z: at.z }, count };
  },
);
`;

const EXAMPLE_RUN = `// A run: a module the body evaluates each time \`minebot run runs/say-hello.ts\` sends it. \`./hello.ts\`
// is the library routine \`hello\` once you have saved it, so the file name must not be the same as a
// routine's: runs/hello.ts would import itself. What the default export returns is the run's result.
import type { RoutineContext } from "minebot-sdk/routine";
import hello from "./hello.ts";

export default (ctx: RoutineContext) => hello(ctx, { message: "hello from a run" });
`;

const EXAMPLE_TEST = `// A routine test: the harness runs the routine through the same argument and result checks as a body
// against a fake bot on Minecraft's real data, with no server. Run it with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "minebot-sdk/testing";
import hello from "../routines/hello.ts";

test("hello greets in chat and reports the position and the logs carried", async () => {
  const h = createHarness({ position: [4.5, 64, 4.5], inventory: { oak_log: 3, birch_log: 2, stick: 9 } });
  const result = await h.run(hello, { message: "hi" });
  assert.deepEqual(result, { said: "hi", position: { x: 4, y: 64, z: 4 }, count: 5 });
  assert.deepEqual(h.chat, ["hi"]);
});

test("hello rejects an empty message", async () => {
  const h = createHarness();
  await assert.rejects(h.run(hello, { message: "" }), /arguments/);
});
`;

const README = `# Minebot workspace

Routines live in \`routines/\`, runs in \`runs/\`, routine tests in \`test/\`. All TypeScript, checked by \`tsc\`.

- A routine is a module whose default export is \`defineRoutine({ description, args, returns }, async (ctx, args) => result)\`. The body keeps saved routines in its library and runs them by name.
- A run is a module that \`minebot run\` sends to the body. It runs once and is gone. Its \`./x.ts\` imports are library routines, so a run calls what you saved. The result is what its default export returns (or, for a default export that is a function, what it returns when called with \`(ctx, args)\`).
- A run file must not have the same file name as a routine: \`runs/hello.ts\` would import itself, not \`routines/hello.ts\`. Here the run is \`runs/say-hello.ts\`.

1. Install: \`npm install\`
2. Start a body (a separate process: \`npx minebot body\`, with the server flags you need; \`npx minebot --help\`)
3. Save the routines into its library: \`npx minebot routines save routines/*.ts\`. It prints \`saved hello\` with its version and time, and \`type check: passed\` (or the errors tsc found).
4. Bind a name and call it: \`npx minebot bind action hello hello\`, then \`npx minebot call hello\`. It prints \`status: ok\` and a result \`{ said, position, count }\`: \`said\` is "hello" (give another with \`--args '{"message":"hi"}'\`), \`position\` where the player stands, and \`count\` how many logs it carries.
5. Run the run: \`npx minebot run runs/say-hello.ts\`. It prints \`status: ok\` and the same kind of result, with \`said\` "hello from a run".
6. Test routines without a server: \`npm test\` (\`test/\` uses \`minebot-sdk/testing\`)
7. Check types: \`npx tsc\`. Because the tsconfig lists both folders in \`rootDirs\`, an error in a routine's signature shows up where a run calls it.

Saving a routine again replaces it on the running body. \`npx minebot builtins docs\` lists the built-in routines you may import from \`minebot-sdk/routines/<module>\`.
`;

const OwnPackage = z.object({
  version: z.string(),
  devDependencies: z.object({ "@types/node": z.string(), typescript: z.string() }).partial(),
});

async function packageJson(dir: string): Promise<string> {
  const { version, devDependencies: dev } = OwnPackage.parse(JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")));
  const name = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || "minebot-workspace";
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: { check: "tsc", test: "node --test test/" },
      dependencies: { "minebot-sdk": `^${version}` },
      devDependencies: { "@types/node": dev["@types/node"] ?? "latest", typescript: dev.typescript ?? "latest" },
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "es2023",
      module: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // esnext: Node 24 has Promise.withResolvers, which the built-in routines use; the body's own check uses the same lib.
      lib: ["esnext"],
      types: ["node"],
      moduleDetection: "force",
      // Files import each other by their .ts names.
      allowImportingTsExtensions: true,
      // The body only strips types, so the check refuses what stripping cannot run: a type imported as a value, an enum.
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      // A run's \`./hello.ts\` names a library module, which is routines/hello.ts here: the two folders read as one.
      rootDirs: ["routines", "runs"],
    },
    include: ["routines/**/*.ts", "runs/**/*.ts", "test/**/*.ts"],
  },
  null,
  2,
)}\n`;

/** Writes the workspace files into `dir`; never overwrites a file that exists. Returns the paths it wrote, relative to `dir`. */
export async function initWorkspace(dir: string): Promise<string[]> {
  const files: [string, string][] = [
    ["package.json", await packageJson(dir)],
    ["tsconfig.json", TSCONFIG],
    [".gitignore", "node_modules\n.minebot/\n"],
    ["README.md", README],
    ["routines/hello.ts", EXAMPLE_ROUTINE],
    ["runs/say-hello.ts", EXAMPLE_RUN],
    ["test/hello.test.ts", EXAMPLE_TEST],
  ];
  const written: string[] = [];
  for (const [file, content] of files) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, content, { flag: "wx" });
      written.push(file);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
  }
  return written;
}
