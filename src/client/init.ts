// `minebot init [dir]`: scaffolds an authoring workspace. Kits are plain TypeScript files the body
// loads from a directory; programs are TypeScript files `minebot run` sends to it; `tsc` checks both
// against the package and the declarations `minebot types` generates for the body.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../package.ts";

/** The generated declaration file's name; the tsconfig includes it and the README tells you how to produce it. */
export const ENV_FILE = "minebot-env.d.ts";

const EXAMPLE_KIT = `// An example kit: copy it, rename it, and change what the actions do. The body loads every .ts
// file in kits/ (run it with --agent-kits ./kits) and reloads a file when you save it.
import { action, defineKit, z } from "minebot-sdk/kit";

// A block position, as the actions below return it.
const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });

export default defineKit(
  {
    name: "hello",
    description: "Example kit: report where the player stands, and greet in chat while walking a few blocks.",
    // Kits this kit calls through ctx.kits; they activate together with it.
    uses: ["move"],
  },
  {
    here: action({
      doc: "Report where the player stands and its health.",
      args: z.object({}),
      returns: z.object({ position: Point, health: z.number() }),
      run: (ctx) => {
        const at = ctx.bot.entity.position.floored();
        return { position: { x: at.x, y: at.y, z: at.z }, health: ctx.bot.health };
      },
    }),
    greet: action({
      doc: "Say \`message\` in chat, then walk \`steps\` blocks east (+x) with the move kit. Returns what was said and where the player stands.",
      args: z.object({
        message: z.string().default("hello"),
        steps: z.number().int().min(0).max(20).default(0),
      }),
      returns: z.object({ said: z.string(), position: Point }),
      run: async (ctx, { message, steps }) => {
        ctx.bot.chat(message);
        const start = ctx.bot.entity.position.floored();
        const end = await ctx.kits.move.to({ position: [start.x + steps, start.y, start.z] });
        return { said: message, position: { x: end.x, y: end.y, z: end.z } };
      },
    }),
  },
);
`;

const EXAMPLE_PROGRAM = `// A program: the body of an async function that runs inside the body, with the globals the
// generated ${ENV_FILE} declares. Run it with: npx minebot run programs/hello.ts
const here = await kit.hello.here();
log("standing at", here.position, "with", here.health, "health");

const greeted = await kit.hello.greet({ message: "hello from a program", steps: 2 });
log("said", greeted.said, "and now stands at", greeted.position);
`;

const EXAMPLE_TEST = `// A kit test: the harness runs the kit's actions through the real kit framework against a fake
// bot on Minecraft's real data, with no server. Run it with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { createKitHarness } from "minebot-sdk/testing";
import hello from "../kits/hello.ts";

test("here reports where the player stands", async () => {
  const h = createKitHarness({ kits: [hello], position: [4.5, 64, 4.5], health: 18 });
  const here = await h.call<{ position: { x: number; y: number; z: number }; health: number }>("hello.here");
  assert.deepEqual(here, { position: { x: 4, y: 64, z: 4 }, health: 18 });
});

test("greet talks in chat, then walks east with the move kit", async () => {
  const h = createKitHarness({ kits: [hello] });
  const greeted = await h.call<{ said: string; position: { x: number } }>("hello.greet", { message: "hi", steps: 5 });
  assert.equal(greeted.said, "hi");
  assert.deepEqual(h.chat, ["hi"]);
  assert.ok(greeted.position.x >= 4, "walked east");
});

test("greet rejects steps beyond its schema", async () => {
  const h = createKitHarness({ kits: [hello] });
  await assert.rejects(h.call("hello.greet", { steps: 99 }), /kit\\.hello\\.greet arguments/);
});
`;

function readme(): string {
  return `# Minebot workspace

Kits live in \`kits/\`, programs in \`programs/\`, kit tests in \`test/\`. All TypeScript, checked by \`tsc\`.

1. Install: \`npm install\`
2. Run a body that loads your kits: \`npx minebot body --agent-kits ./kits\` (add the server flags you need; \`npx minebot --help\`)
3. Generate types for that body: \`npx minebot types --out ${ENV_FILE}\`
4. Check: \`npx tsc\`
5. Run a program: \`npx minebot run programs/hello.ts\`
6. Test kits without a server: \`npm test\` (\`test/\` uses \`minebot-sdk/testing\`)

Saving a kit file reloads it on the running body. Regenerate \`${ENV_FILE}\` after the body's kits change.
Kit files import from \`"minebot-sdk/kit"\` only; \`npx minebot kits source move\` shows a built-in kit written the same way.
`;
}

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
      // No DOM: its globals (`status`, `name`, ...) would collide with the program globals.
      lib: ["es2023"],
      types: ["node"],
      // Every file is a module, so a program may use top-level await.
      moduleDetection: "force",
      // Tests import a kit by its file name.
      allowImportingTsExtensions: true,
    },
    include: ["kits/**/*.ts", "programs/**/*.ts", "test/**/*.ts", ENV_FILE],
  },
  null,
  2,
)}\n`;

/** Writes the workspace files into `dir`; never overwrites a file that exists. Returns the paths it wrote, relative to `dir`. */
export async function initWorkspace(dir: string): Promise<string[]> {
  const files: [string, string][] = [
    ["package.json", await packageJson(dir)],
    ["tsconfig.json", TSCONFIG],
    [".gitignore", "node_modules\nkits/.history/\n.minebot/\n"],
    ["README.md", readme()],
    ["kits/hello.ts", EXAMPLE_KIT],
    ["programs/hello.ts", EXAMPLE_PROGRAM],
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
