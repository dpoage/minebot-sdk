// Lesson provenance (mb-znn.11): a lesson records the modules it names and what they were; a lesson whose named module
// changed since is marked stale on every surface that shows it. The shipped modules are injected here, so a test can
// change a module's identity; the last describe block runs against what this package really ships.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatHits } from "../src/client/render.ts";
import { PACKAGE_ROOT } from "../src/package.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";
import { WikiAccess } from "../src/wiki/access.ts";
import { provenanceFor, shippedModules, type Shipped, type ShippedModule } from "../src/wiki/provenance.ts";
import { formatPage, Wiki } from "../src/wiki/wiki.ts";

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

const MOVE_THEN = "aaaaaaaaaaaa";
const MOVE_NOW = "bbbbbbbbbbbb";
const PATHFINDER_THEN = "2.4.5";
const PATHFINDER_NOW = "2.5.0";

const MOVE_MARK = "[stale: move changed since this lesson was written; check it against builtins docs move before relying on it]";
const PATHFINDER_MARK = "[stale: mineflayer-pathfinder changed since this lesson was written; check it against builtins docs mineflayer-pathfinder before relying on it]";

/** Shipped modules with the given identities: two built-ins, and two packages one of which has the alias `pathfinder`. */
function shipped(identities: { move?: string; dig?: string; mineflayer?: string; pathfinder?: string }): Shipped {
  const module = (name: string, identity: string | undefined, aliases: string[] = []): ShippedModule => ({ name, aliases, identity: () => identity });
  return {
    sdk: "9.9.9",
    modules: [
      module("move", identities.move),
      module("dig", identities.dig),
      module("mineflayer", identities.mineflayer),
      module("mineflayer-pathfinder", identities.pathfinder, ["pathfinder"]),
    ],
  };
}

const THEN = shipped({ move: MOVE_THEN, dig: "cccccccccccc", mineflayer: "4.39.0", pathfinder: PATHFINDER_THEN });
const SAME = THEN;
const MOVE_CHANGED = shipped({ move: MOVE_NOW, dig: "cccccccccccc", mineflayer: "4.39.0", pathfinder: PATHFINDER_THEN });
const PATHFINDER_CHANGED = shipped({ move: MOVE_THEN, dig: "cccccccccccc", mineflayer: "4.39.0", pathfinder: PATHFINDER_NOW });

async function dirs(): Promise<{ root: string; lessons: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "minebot-wiki-lessons-"));
  const root = path.join(base, "wiki");
  await mkdir(root);
  return { root, lessons: path.join(base, "lessons") };
}

/** The lesson file's frontmatter, as YAML. */
async function frontmatter(lessons: string, id: string): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(lessons, `${id.replace(/^lessons\//, "")}.md`), "utf8");
  return parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as Record<string, unknown>;
}

/** Writes a lesson file by hand, as base wrote it (no record) or with whatever record `extra` holds. */
async function writeLesson(lessons: string, slug: string, title: string, tags: string[], extra = ""): Promise<string> {
  await mkdir(lessons, { recursive: true });
  const text = `---\ntitle: ${JSON.stringify(title)}\ntags: ${JSON.stringify(tags)}\nverified_by: unreviewed lesson from Rivet\nauthor: Rivet\ncreated: 2026-10-24T17:36:39.037Z\n${extra}---\n\nBody of ${slug}.\n`;
  await writeFile(path.join(lessons, `${slug}.md`), text);
  return `lessons/${slug}`;
}

describe("which modules a lesson names", () => {
  const named = (title: string, tags: string[] = []) => Object.keys(provenanceFor(THEN, title, tags).modules);

  it("takes a tag that is a module's name, whole and in any case", () => {
    assert.deepEqual(named("A lesson", ["Move"]), ["move"]);
    assert.deepEqual(named("A lesson", ["move"]), ["move"]);
    assert.deepEqual(named("A lesson", ["movement"]), []);
    assert.deepEqual(named("A lesson", ["move-to"]), []);
    assert.deepEqual(named("A lesson", ["26.1", "quirk"]), []);
    assert.deepEqual(named("A lesson", ["pathfinder"]), ["mineflayer-pathfinder"]);
    assert.deepEqual(named("A lesson", ["Mineflayer-Pathfinder"]), ["mineflayer-pathfinder"]);
  });

  it("takes a title word that is a module's name, where hyphens, dots and underscores separate words", () => {
    assert.deepEqual(named("pathfinder loops on diagonals"), ["mineflayer-pathfinder"]);
    assert.deepEqual(named("Dig then MOVE"), ["move", "dig"]);
    assert.deepEqual(named("move.to loops forever"), ["move"]);
    assert.deepEqual(named("the move-to call"), ["move"]);
    assert.deepEqual(named("move_to is slow"), ["move"]);
    assert.deepEqual(named("movement is slow"), []);
    assert.deepEqual(named("moves and digging"), []);
    assert.deepEqual(named("remove the block"), []);
  });

  it("matches a name of several words as consecutive words, and not the shorter names inside it", () => {
    assert.deepEqual(named("mineflayer-pathfinder stalls"), ["mineflayer-pathfinder"]);
    assert.deepEqual(named("Mineflayer.Pathfinder stalls"), ["mineflayer-pathfinder"]);
    assert.deepEqual(named("mineflayer stalls"), ["mineflayer"]);
    assert.deepEqual(named("mineflayer then pathfinder"), ["mineflayer", "mineflayer-pathfinder"]);
  });

  it("records only modules that have an identity", () => {
    const noDig = shipped({ move: MOVE_THEN });
    assert.deepEqual(provenanceFor(noDig, "dig and move", []), { sdk: "9.9.9", modules: { move: MOVE_THEN } });
  });
});

describe("a new lesson's record", () => {
  it("carries the sdk version and the identity of each module it names, and nothing else changes in the file", async () => {
    const { root, lessons } = await dirs();
    const wiki = Wiki.load(root, lessons, THEN);
    const made = await wiki.addLesson({ title: "pathfinder loops on diagonals", tags: ["Move", "quirk"], body: "Flatten the path first." }, "ana");
    const meta = await frontmatter(lessons, made.id);
    assert.deepEqual(meta.provenance, { sdk: "9.9.9", modules: { move: MOVE_THEN, "mineflayer-pathfinder": PATHFINDER_THEN } });
    assert.deepEqual({ ...meta, provenance: undefined }, { title: "pathfinder loops on diagonals", tags: ["Move", "quirk"], verified_by: "unreviewed lesson from ana", author: "ana", created: meta.created, provenance: undefined });
  });

  it("carries the sdk version even when it names no module", async () => {
    const { root, lessons } = await dirs();
    const made = await Wiki.load(root, lessons, THEN).addLesson({ title: "End crystals heal the dragon", tags: ["end"], body: "Destroy the crystals first." }, "ana");
    assert.deepEqual((await frontmatter(lessons, made.id)).provenance, { sdk: "9.9.9", modules: {} });
  });

  it("round-trips an identity that YAML would read as a number", async () => {
    const { root, lessons } = await dirs();
    const digits = shipped({ move: "123456789012" });
    const made = await Wiki.load(root, lessons, digits).addLesson({ title: "move.to is slow", body: "Use smaller steps." }, "ana");
    const page = Wiki.load(root, lessons, digits).read(made.id);
    assert.deepEqual(page.meta.provenance, { sdk: "9.9.9", modules: { move: "123456789012" } });
    assert.equal(page.status, "lesson");
  });
});

describe("a stale lesson", () => {
  async function lessonNaming(title: string, tags: string[] = []): Promise<{ root: string; lessons: string; id: string }> {
    const { root, lessons } = await dirs();
    const made = await Wiki.load(root, lessons, THEN).addLesson({ title, tags, body: "A thing I learned about it, with enough words." }, "ana");
    return { root, lessons, id: made.id };
  }

  it("is marked when a module it names changed, on search, list, read, the page text, and the access a program gets", async () => {
    const { root, lessons, id } = await lessonNaming("move.to loops on diagonals");
    const wiki = Wiki.load(root, lessons, MOVE_CHANGED);
    const hit = wiki.search("diagonals")[0]!;
    assert.deepEqual([hit.id, hit.status, hit.stale], [id, "stale-lesson", MOVE_MARK]);
    assert.deepEqual(wiki.list("lessons"), [{ id, title: "move.to loops on diagonals", tags: [], status: "stale-lesson", stale: MOVE_MARK }]);
    const page = wiki.read(id);
    assert.deepEqual([page.status, page.stale], ["stale-lesson", MOVE_MARK]);
    assert.equal(formatPage(page), `# move.to loops on diagonals\n[${id} | stale-lesson | unreviewed lesson from ana]\n${MOVE_MARK}\n\nA thing I learned about it, with enough words.`);
    // What ctx.wiki.* returns inside a run is the access's answer.
    const access = new WikiAccess(wiki, "write", "ana");
    assert.deepEqual([access.search("diagonals")[0]!.status, access.search("diagonals")[0]!.stale], ["stale-lesson", MOVE_MARK]);
    assert.equal(access.list("lessons")[0]!.stale, MOVE_MARK);
    assert.equal(access.readFormatted(id).text, formatPage(page));
    assert.match(access.readFormatted(id).text, new RegExp(MOVE_MARK.replace(/[[\]]/g, "\\$&")));
    // The renderer the MCP wiki_search tool shares.
    assert.equal(formatHits([hit]), `${id} [stale-lesson] move.to loops on diagonals ${MOVE_MARK}\n  ${hit.snippet}`);
  });

  it("is marked the same way when a package it names changed", async () => {
    const { root, lessons, id } = await lessonNaming("pathfinder loops on diagonals");
    const hit = Wiki.load(root, lessons, PATHFINDER_CHANGED).search("pathfinder")[0]!;
    assert.deepEqual([hit.id, hit.status, hit.stale], [id, "stale-lesson", PATHFINDER_MARK]);
  });

  it("carries one mark for each module that changed", async () => {
    const { root, lessons, id } = await lessonNaming("move.to and pathfinder disagree");
    const both = shipped({ move: MOVE_NOW, pathfinder: PATHFINDER_NOW });
    assert.equal(Wiki.load(root, lessons, both).read(id).stale, `${MOVE_MARK} ${PATHFINDER_MARK}`);
    const onlyOne = shipped({ move: MOVE_THEN, pathfinder: PATHFINDER_NOW });
    assert.equal(Wiki.load(root, lessons, onlyOne).read(id).stale, PATHFINDER_MARK);
  });

  it("is not marked while every module it names is as it was, or when only a module it does not name changed", async () => {
    const { root, lessons, id } = await lessonNaming("move.to loops on diagonals");
    for (const now of [SAME, PATHFINDER_CHANGED]) {
      const wiki = Wiki.load(root, lessons, now);
      assert.deepEqual(wiki.list("lessons"), [{ id, title: "move.to loops on diagonals", tags: [], status: "lesson" }]);
      assert.equal("stale" in wiki.search("diagonals")[0]!, false);
      assert.equal(wiki.read(id).stale, undefined);
      assert.equal(formatPage(wiki.read(id)), `# move.to loops on diagonals\n[${id} | lesson | unreviewed lesson from ana]\n\nA thing I learned about it, with enough words.`);
    }
  });

  it("is not marked when the module's identity cannot be read now: there is nothing to compare", async () => {
    const { root, lessons, id } = await lessonNaming("move.to loops on diagonals");
    assert.equal(Wiki.load(root, lessons, shipped({})).read(id).status, "lesson");
  });

  it("is judged again when a body's wiki is loaded against a newer package, and reads the same file", async () => {
    const { root, lessons, id } = await lessonNaming("move.to loops on diagonals");
    const before = await readFile(path.join(lessons, `${id.replace(/^lessons\//, "")}.md`), "utf8");
    assert.equal(Wiki.load(root, lessons, SAME).read(id).status, "lesson");
    assert.equal(Wiki.load(root, lessons, MOVE_CHANGED).read(id).status, "stale-lesson");
    assert.equal(await readFile(path.join(lessons, `${id.replace(/^lessons\//, "")}.md`), "utf8"), before, "judging a lesson never rewrites it");
  });

  it("stays in the file untouched: a direct read of the lesson file shows no mark", async () => {
    const { lessons, id } = await lessonNaming("move.to loops on diagonals");
    assert.doesNotMatch(await readFile(path.join(lessons, `${id.replace(/^lessons\//, "")}.md`), "utf8"), /stale/);
  });
});

describe("a lesson without a usable record", () => {
  it("is not marked when it has no record, even when it names modules that changed", async () => {
    const { root, lessons } = await dirs();
    const id = await writeLesson(lessons, "move-to-loops", "move.to loops on diagonals", ["move", "pathfinder"]);
    const wiki = Wiki.load(root, lessons, MOVE_CHANGED);
    assert.deepEqual(wiki.list("lessons"), [{ id, title: "move.to loops on diagonals", tags: ["move", "pathfinder"], status: "lesson" }]);
    assert.equal(formatPage(wiki.read(id)), `# move.to loops on diagonals\n[${id} | lesson | unreviewed lesson from Rivet]\n\nBody of move-to-loops.`);
  });

  const MALFORMED: Record<string, string> = {
    "sdk is a number": "provenance:\n  sdk: 1\n  modules:\n    move: aaaaaaaaaaaa\n",
    "the record is a string": "provenance: written in 0.1.0\n",
    "the record is null": "provenance: null\n",
    "the identities are a number": "provenance:\n  sdk: 0.1.0\n  modules: 5\n",
    "an identity is not hex": "provenance:\n  sdk: 0.1.0\n  modules:\n    move: zzzzzzzzzzzz\n",
    "an identity is a number": "provenance:\n  sdk: 0.1.0\n  modules:\n    move: 12\n",
    "the record is a list": "provenance:\n  - move\n",
  };
  for (const [what, record] of Object.entries(MALFORMED)) {
    it(`loads as an unmarked legacy lesson when ${what}, and load, search, list and read do not throw`, async () => {
      const { root, lessons } = await dirs();
      const id = await writeLesson(lessons, "odd", "move.to loops on diagonals", ["move"], record);
      const wiki = Wiki.load(root, lessons, MOVE_CHANGED);
      assert.equal(wiki.lessonCount, 1);
      assert.deepEqual(wiki.list("lessons").map((p) => [p.id, p.status]), [[id, "lesson"]]);
      assert.deepEqual(wiki.search("diagonals").map((p) => [p.id, p.status, "stale" in p]), [[id, "lesson", false]]);
      assert.equal(wiki.read(id).stale, undefined);
      assert.equal(wiki.read(id).meta.provenance, undefined);
    });
  }

  it("keeps a good record next to a malformed one: the good lesson is still judged", async () => {
    const { root, lessons } = await dirs();
    await writeLesson(lessons, "bad", "move.to is slow", ["move"], "provenance: nope\n");
    const good = await writeLesson(lessons, "good", "move.to loops", ["move"], `provenance:\n  sdk: 9.9.9\n  modules:\n    move: ${MOVE_THEN}\n`);
    const statuses = Wiki.load(root, lessons, MOVE_CHANGED).list("lessons").map((p) => [p.id, p.status]);
    assert.deepEqual(statuses, [["lessons/bad", "lesson"], [good, "stale-lesson"]]);
  });
});

describe("the lessons base wrote", () => {
  /** The base tree's rendering of each fixture lesson: the id, status, and the sha256 and length of the text it rendered. */
  const RenderSnapshot = z.array(z.object({ id: z.string(), status: z.string(), sha256: z.string(), chars: z.number() }));
  const fixtures = path.join(import.meta.dirname, "fixtures", "lessons");
  const snapshot = RenderSnapshot.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "lessons-render.json"), "utf8")));

  it("parses and renders every one of the 21 files byte-identically to base output, unmarked", async () => {
    assert.equal((await readdir(fixtures)).filter((f) => f.endsWith(".md")).length, 21);
    const { root } = await dirs();
    const wiki = Wiki.load(root, fixtures);
    assert.equal(wiki.lessonCount, 21);
    const rendered = wiki.pages
      .filter((p) => p.id.startsWith("lessons/"))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => {
        const text = formatPage(p);
        assert.equal(p.meta.provenance, undefined, "a base lesson has no record");
        assert.equal("stale" in p, false);
        return { id: p.id, status: p.status, sha256: createHash("sha256").update(text).digest("hex"), chars: text.length };
      });
    assert.deepEqual(rendered, snapshot);
  });
});

describe("the CLI and MCP surfaces", () => {
  let server: Server;
  let url: string;
  let id: string;
  const features: BodyFeatures = { wiki: "write", lessons: true, milestones: false, reflexes: true, routines: true, builtins: ["move"] };

  // A body that answers the wiki routes with a real wiki whose `move` has changed since the lesson was written.
  before(async () => {
    const { root, lessons } = await dirs();
    id = (await Wiki.load(root, lessons, THEN).addLesson({ title: "move.to loops on diagonals", body: "Flatten the path first, with enough words." }, "ana")).id;
    await Wiki.load(root, lessons, THEN).addLesson({ title: "Boats float", body: "Boats float on water, with enough words." }, "ana");
    const access = new WikiAccess(Wiki.load(root, lessons, MOVE_CHANGED), "write", "ana");
    server = createServer((req, res) => {
      const requested = new URL(req.url!, "http://body");
      res.setHeader("content-type", "application/json");
      const answer = (value: unknown) => res.end(JSON.stringify(value));
      switch (requested.pathname) {
        case "/features": return answer(features);
        case "/wiki/search": return answer({ hits: access.search(requested.searchParams.get("q")!, 5) });
        case "/wiki/list": return answer({ pages: access.list(requested.searchParams.get("section") ?? undefined), mode: access.mode });
        case "/wiki/page": return answer(access.readFormatted(requested.searchParams.get("id")!));
        default: return answer({ error: `no answer for ${req.url}` });
      }
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const cli = async (...args: string[]) => (await exec(process.execPath, [...CLI, ...args], { env: { ...process.env, MINEBOT_URL: url, MINEBOT_TOKEN: "" } })).stdout;

  it("minebot wiki search, list and read mark the lesson and leave the other alone", async () => {
    assert.match(await cli("wiki", "search", "diagonals"), new RegExp(`^${id}  \\[stale-lesson\\]  move\\.to loops on diagonals  ${MOVE_MARK.replace(/[[\].]/g, "\\$&")}\\n    Flatten the path first`));
    assert.equal(await cli("wiki", "list", "lessons"), `lessons/boats-float  [lesson]  Boats float\n${id}  [stale-lesson]  move.to loops on diagonals  ${MOVE_MARK}\n\n2 pages; wiki is write on this body\n`);
    assert.equal(await cli("wiki", "read", id), `# move.to loops on diagonals\n[${id} | stale-lesson | unreviewed lesson from ana]\n${MOVE_MARK}\n\nFlatten the path first, with enough words.\n`);
    assert.doesNotMatch(await cli("wiki", "search", "boats"), /stale/);
  });

  it("the wiki_search, wiki_list and wiki_read tools mark the lesson and leave the other alone", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp", "--tools", "full"], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const said = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).content;
      const textOf = (text: string) => [{ type: "text", text }];
      assert.deepEqual(await said("wiki_search", { query: "diagonals" }), textOf(`${id} [stale-lesson] move.to loops on diagonals ${MOVE_MARK}\n  Flatten the path first, with enough words.`));
      assert.deepEqual(await said("wiki_list", { section: "lessons" }), textOf(`lessons/boats-float [lesson] Boats float\n${id} [stale-lesson] move.to loops on diagonals ${MOVE_MARK}`));
      assert.deepEqual(await said("wiki_read", { id }), textOf(`# move.to loops on diagonals\n[${id} | stale-lesson | unreviewed lesson from ana]\n${MOVE_MARK}\n\nFlatten the path first, with enough words.`));
      assert.doesNotMatch(JSON.stringify(await said("wiki_search", { query: "boats" })), /stale/);
    } finally {
      await client.close();
    }
  });
});

describe("the modules this package ships", () => {
  const Manifest = z.object({ version: z.string(), dependencies: z.record(z.string(), z.string()) });
  const Installed = z.object({ version: z.string() });
  const manifest = Manifest.parse(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")));
  const installed = Installed.parse(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "node_modules", "mineflayer-pathfinder", "package.json"), "utf8"))).version;
  const sourceIdentity = (name: string) => createHash("sha256").update(readFileSync(path.join(PACKAGE_ROOT, "src", "routines", `${name}.ts`))).digest("hex").slice(0, 12);

  it("identifies a built-in module by 12 hex digits of the sha256 of src/routines/<name>.ts, and the package by its version", () => {
    const record = provenanceFor(shippedModules(), "move.to loops", ["dig"]);
    assert.deepEqual(record, { sdk: manifest.version, modules: { move: sourceIdentity("move"), dig: sourceIdentity("dig") } });
  });

  it("identifies a package by its installed version, and knows `pathfinder` as mineflayer-pathfinder", () => {
    assert.deepEqual(provenanceFor(shippedModules(), "pathfinder loops", []).modules, { "mineflayer-pathfinder": installed });
    assert.deepEqual(provenanceFor(shippedModules(), "A lesson", ["mineflayer-pathfinder"]).modules, { "mineflayer-pathfinder": installed });
  });

  it("names every module of the catalog and every dependency of the package", async () => {
    const files = (await readdir(path.join(PACKAGE_ROOT, "src", "routines"))).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3));
    assert.deepEqual(shippedModules().modules.map((m) => m.name).sort(), [...files, ...Object.keys(manifest.dependencies)].sort());
  });

  it("writes a lesson that is unmarked now and marked once the module's source changes", async () => {
    const { root, lessons } = await dirs();
    const real = shippedModules();
    const made = await Wiki.load(root, lessons, real).addLesson({ title: "move.to loops on diagonals", body: "Flatten the path first, with enough words." }, "ana");
    assert.equal(Wiki.load(root, lessons).read(made.id).status, "lesson");
    // The file as a later package would ship it: a lesson recorded against another identity.
    const file = path.join(lessons, `${made.id.replace(/^lessons\//, "")}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace(sourceIdentity("move"), "ffffffffffff"));
    const page = Wiki.load(root, lessons).read(made.id);
    assert.equal(page.status, "stale-lesson");
    assert.equal(page.stale, MOVE_MARK);
  });
});
