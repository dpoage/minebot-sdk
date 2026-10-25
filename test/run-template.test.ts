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
  it("is one module an agent can copy: imports at the top, then `export default async (ctx, args)`, using Vec3", () => {
    for (const features of [EVERYTHING, NOTHING, { ...EVERYTHING, builtins: ["move"] }, { ...EVERYTHING, builtins: ["dig"] }]) {
      const template = templateOf(features);
      assert.match(template, /^import \{ Vec3 \} from "vec3";\n(import \* as \w+ from "minebot-sdk\/routines\/\w+";\n)?\nexport default async \(ctx, args\) => \{$/m);
      assert.match(template, /const here = new Vec3\(ctx\.bot\.entity\.position\.x, ctx\.bot\.entity\.position\.y, ctx\.bot\.entity\.position\.z\);/);
      assert.match(template, /\n\};$/);
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
