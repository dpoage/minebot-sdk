import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { initWorkspace } from "../src/client/init.ts";
import { generateEnv, schemaToType } from "../src/client/types-gen.ts";
import type { BodyFeatures, KitSchema } from "../src/protocol/index.ts";

const EVERYTHING: BodyFeatures = { kits: ["move", "tidy"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true };

function schemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" });
}

const tidy: KitSchema = {
  name: "tidy",
  description: "Keeps the inventory tidy.",
  uses: ["move"],
  active: true,
  agent: true,
  actions: {
    sort: {
      doc: "Sort the inventory.\nReturns the slot count.",
      args: schemaOf(z.object({ by: z.enum(["name", "count"]), limit: z.number().int().default(5), tags: z.array(z.string()).optional() }), "input"),
      returns: schemaOf(z.object({ slots: z.number(), at: z.tuple([z.number(), z.number(), z.number()]), note: z.string().nullable() }), "output"),
    },
    reset: { doc: "Reset.", args: schemaOf(z.object({}), "input") },
  },
};
const move: KitSchema = { name: "move", description: "Walk.", uses: [], active: true, agent: false, actions: { stop: { doc: "Stop.", args: schemaOf(z.object({}), "input") } } };

describe("schemaToType", () => {
  it("prints objects, optional keys, unions, enums, tuples, arrays, and nullables", () => {
    const text = schemaToType(
      schemaOf(
        z.object({
          mode: z.enum(["a", "b"]),
          maybe: z.string().optional(),
          pos: z.union([z.tuple([z.number(), z.number(), z.number()]), z.object({ x: z.number(), y: z.number(), z: z.number() })]),
          list: z.array(z.union([z.string(), z.number()])),
          orNull: z.number().nullable(),
        }),
        "input",
      ),
    );
    assert.match(text, /mode: "a" \| "b";/);
    assert.match(text, /maybe\?: string;/);
    assert.match(text, /pos: \[number, number, number\] \| \{/);
    assert.match(text, /list: \(string \| number\)\[\];/);
    assert.match(text, /orNull: number \| null;/);
  });

  it("types zod defaults as optional input and required output", () => {
    const schema = z.object({ n: z.number().default(1) });
    assert.match(schemaToType(schemaOf(schema, "input")), /n\?: number;/);
    assert.match(schemaToType(schemaOf(schema, "output")), /n: number;/);
  });

  it("types what it cannot express as unknown", () => {
    assert.equal(schemaToType(schemaOf(z.custom<number>(() => true), "output")), "unknown");
  });
});

describe("generateEnv", () => {
  it("is deterministic regardless of kit order", () => {
    assert.equal(generateEnv(EVERYTHING, [tidy, move]), generateEnv(EVERYTHING, [move, tidy]));
  });

  it("registers only kits the package does not ship, with args and returns", () => {
    const env = generateEnv(EVERYTHING, [tidy, move]);
    assert.match(env, /declare module "minebot-sdk\/kit" \{\n {2}interface KitRegistry \{/);
    assert.match(env, /tidy: \{/);
    assert.doesNotMatch(env, /^ {4}move: \{/m);
    assert.match(env, /readonly sort: \(args: \{/);
    assert.match(env, /\) => Promise<\{\n[\s\S]*slots: number;/);
    assert.match(env, /readonly reset: \(args\?: \{\}\) => Promise<unknown>;/);
    assert.match(env, /Returns the slot count\./);
  });

  it("types the program kit global against the active kits", () => {
    const env = generateEnv(EVERYTHING, [tidy, move, { ...move, name: "idle", active: false }]);
    assert.match(env, /const kit: \{ \[K in Extract<keyof KitRegistry, "move" \| "tidy">\]: KitRegistry\[K\] \};/);
  });

  it("declares only the globals the body offers", () => {
    const bare: BodyFeatures = { kits: [], kitsLocked: true, agentKits: false, wiki: "off", lessons: false, milestones: false, triggers: false };
    const env = generateEnv(bare, []);
    assert.doesNotMatch(env, /KitRegistry|const kit\b|const kits\b|const wiki\b|const triggers\b|addLesson|milestones/);
    assert.match(env, /const bot:/);
    assert.match(env, /const notes:/);

    const noSwitching = generateEnv({ ...EVERYTHING, kitsLocked: true }, [tidy, move]);
    assert.doesNotMatch(noSwitching, /use\(\.\.\.names/);
    const noAgents = generateEnv({ ...EVERYTHING, agentKits: false }, [tidy, move]);
    assert.doesNotMatch(noAgents, /save\(source/);
    const readOnlyWiki = generateEnv({ ...EVERYTHING, wiki: "read", lessons: false }, [tidy, move]);
    assert.match(readOnlyWiki, /const wiki:/);
    assert.doesNotMatch(readOnlyWiki, /addLesson/);
  });
});

describe("initWorkspace", () => {
  it("scaffolds the workspace and never overwrites an existing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "minebot-init-"));
    try {
      const written = await initWorkspace(dir);
      for (const file of [".gitignore", "README.md", "kits/hello.ts", "package.json", "programs/hello.ts", "tsconfig.json"]) assert.ok(written.includes(file), file);
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      assert.ok(pkg.dependencies["minebot-sdk"]);
      assert.ok(pkg.devDependencies.typescript);
      assert.deepEqual(await initWorkspace(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("schemaToType quoting", () => {
  it("does not read brackets inside string literals as nesting", () => {
    assert.equal(schemaToType(schemaOf(z.array(z.enum(["a>b", "c"])), "input")), '("a>b" | "c")[]');
  });
});
