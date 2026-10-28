// The program reference's run template: what it teaches — imports at the top of the module, above
// `export default` — must be what runs. The template is read out of programApiDoc (its one fenced
// block) and sent verbatim as run code to a body that runs real modules, where it must end status ok
// and change nothing: its built-in call only reads state or stops what is not running.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { programApiDoc, type BodyFeatures, type RunResult } from "../src/protocol/index.ts";
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

const EVERYTHING: BodyFeatures = {
  wiki: "read",
  lessons: true,
  milestones: true,
  reflexes: true,
  routines: true,
  builtins: ["move", "sense", "dig", "place", "inventory", "craft", "items", "furnace", "gatherer", "crafter", "builder", "explorer", "social"],
};
const NOTHING: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };

/** The run template of a feature set: the one fenced block the reference holds. */
function templateOf(features: BodyFeatures): string {
  const blocks = [...programApiDoc(features).matchAll(/```ts\n([\s\S]*?)\n```/g)].map((found) => found[1]!);
  assert.equal(blocks.length, 1, "exactly one fenced run template");
  return blocks[0]!;
}

describe("the program reference's run template", () => {
  it("is one module an agent can copy: imports at the top, then `export default async (ctx, args)`, using Vec3 from minebot-sdk/routine", () => {
    for (const features of [EVERYTHING, NOTHING, { ...EVERYTHING, builtins: ["move"] }, { ...EVERYTHING, builtins: ["dig"] }]) {
      const template = templateOf(features);
      assert.match(template, /^import \{ Vec3 \} from "minebot-sdk\/routine";\n(import \* as \w+ from "minebot-sdk\/routines\/\w+";\n)?\nexport default async \(ctx, args\) => \{$/m);
      assert.match(template, /const here = new Vec3\(ctx\.bot\.entity\.position\.x, ctx\.bot\.entity\.position\.y, ctx\.bot\.entity\.position\.z\);/);
      assert.match(template, /\n\};$/);
    }
  });

  // P2.1: what the reference teaches to import is what resolves for every agent, not the packages that only the body's own workspace has.
  it("imports only minebot-sdk/routine and the offered built-in modules, in every code block of the reference", () => {
    for (const features of [EVERYTHING, NOTHING, { ...EVERYTHING, builtins: ["move"] }, { ...EVERYTHING, builtins: ["inventory", "sense"] }]) {
      const doc = programApiDoc(features);
      const blocks = [...doc.matchAll(/```\w*\n([\s\S]*?)\n```/g)].map((found) => found[1]!);
      assert.ok(blocks.length > 0);
      const allowed = new Set(["minebot-sdk/routine", ...features.builtins.map((module) => `minebot-sdk/routines/${module}`)]);
      for (const specifier of blocks.flatMap((block) => [...block.matchAll(/\bfrom "([^"]+)"/g)].map((found) => found[1]!))) {
        assert.ok(allowed.has(specifier), `a code block imports ${specifier}`);
      }
      assert.doesNotMatch(doc, /from "(?:vec3|mineflayer-pathfinder)"/, "no import from vec3 or mineflayer-pathfinder anywhere in the reference");
    }
  });

  it("shows the goal instance a pathfinder call takes and the import that has goals and Vec3", () => {
    const doc = programApiDoc(EVERYTHING);
    assert.ok(doc.includes('import { goals, Vec3 } from "minebot-sdk/routine"'));
    assert.ok(doc.includes("await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))"));
  });

  it("describes the run check, and does not say that types are not checked or name the comment that turns the check off", () => {
    for (const features of [EVERYTHING, NOTHING]) {
      const doc = programApiDoc(features);
      assert.doesNotMatch(doc, /not checked|types are stripped/);
      assert.doesNotMatch(doc, /ts-nocheck/);
      assert.match(doc, /The type check runs before the run starts\. A run with errors that would make it fail when it runs .* does not start: its status is error and the errors are listed, each with its line and column/);
      assert.match(doc, /Where the body cannot load TypeScript the check is skipped, and the run's log says so with one line, `type check skipped: <reason>`\./);
    }
  });

  it("calls a built-in routine only where the body has routines and offers a module the call cannot change anything with", () => {
    assert.match(templateOf(EVERYTHING), /await inventory\.list\(ctx, \{\}\);/);
    assert.match(templateOf({ ...EVERYTHING, builtins: ["move"] }), /await move\.stop\(ctx, \{\}\);/);
    assert.match(templateOf({ ...EVERYTHING, builtins: ["sense"] }), /await sense\.find\(ctx, \{ blocks: "stone" \}\);/);
    for (const withheld of [NOTHING, { ...EVERYTHING, routines: false }, { ...EVERYTHING, builtins: ["dig", "place"] }]) {
      assert.doesNotMatch(templateOf(withheld), /minebot-sdk\/routines\//);
    }
  });

  it("runs verbatim, status ok, on a body with routines and on one without", async () => {
    for (const options of [{}, { init: { routines: false } }] as FakeBodyOptions[]) {
      await using(options, async (body) => {
        const features = ((await body.request("GET", "/features")).body as BodyFeatures);
        const answer = runOf(await body.request("POST", "/run", { code: templateOf(features) }));
        assert.equal(answer.status, "ok", JSON.stringify(answer));
        const { at } = answer.result as { at: unknown[] };
        assert.equal(at.length, 3, JSON.stringify(answer.result));
      });
    }
  });
});
