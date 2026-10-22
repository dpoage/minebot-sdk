import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MC_VERSION } from "../src/mc/version.ts";
import { formatPage, Wiki, WIKI_DIR, WikiDisabledError, WikiPageNotFoundError } from "../src/wiki/wiki.ts";
import { FULL_VIEW, WikiAccess, wikiView, type WikiView } from "../src/wiki/access.ts";
import { chunk, compress, dataPages, loadMinecraftData } from "../scripts/wiki-reference.ts";

async function fixture(): Promise<{ root: string; lessons: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "minebot-wiki-"));
  const page = (meta: string, body: string) => `---\n${meta}\n---\n\n${body}\n`;
  await mkdir(path.join(root, "quirks"));
  await mkdir(path.join(root, "mechanics"));
  await writeFile(
    path.join(root, "quirks", "drops.md"),
    page(`title: Drops fall out of reach\ntags: [items]\nmc_version: "${MC_VERSION}"\nverified_by: test`, "Walk over the drop."),
  );
  await writeFile(
    path.join(root, "mechanics", "furnace.md"),
    page(`title: Smelting\nmc_version: "1.0"\nverified_by: test`, "A furnace smelts raw iron. Drops of coal help."),
  );
  await writeFile(path.join(root, "mechanics", "mobs.md"), page("title: Mobs\nverified_by: folklore", "Zombies burn."));
  return { root, lessons: path.join(root, "..", `${path.basename(root)}-lessons`) };
}

describe("Wiki", () => {
  it("marks pages verified, stale, or unverified against the pinned version", async () => {
    const { root } = await fixture();
    const wiki = Wiki.load(root);
    assert.deepEqual(
      wiki.list().map((p) => [p.id, p.status]),
      [
        ["mechanics/furnace", "stale"],
        ["mechanics/mobs", "unverified"],
        ["quirks/drops", "verified"],
      ],
    );
  });

  it("ranks a title match above a body match", async () => {
    const { root } = await fixture();
    const hits = Wiki.load(root).search("drops");
    assert.deepEqual(hits.map((h) => h.id), ["quirks/drops", "mechanics/furnace"]);
    assert.equal(hits[1]!.snippet, "A furnace smelts raw iron. Drops of coal help.");
  });

  it("suggests pages when an id does not exist", async () => {
    const { root } = await fixture();
    const wiki = Wiki.load(root);
    assert.throws(() => wiki.read("quirks/drop"), (err: unknown) => err instanceof WikiPageNotFoundError && /did you mean quirks\/drops/.test(err.message));
  });

  it("rejects a page without required frontmatter", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "quirks", "bad.md"), "---\ntags: [x]\n---\nNo title.");
    assert.throws(() => Wiki.load(root), /quirks\/bad/);
  });

  it("writes lessons that later loads and searches find, without overwriting", async () => {
    const { root, lessons } = await fixture();
    const wiki = Wiki.load(root, lessons);
    const first = await wiki.addLesson({ title: "End crystals heal the dragon", tags: ["end"], body: "Destroy the crystals first." }, "ana");
    const second = await wiki.addLesson({ title: "End crystals heal the dragon", body: "Use a bow from the ground." }, "ben");
    assert.deepEqual([first.id, second.id], ["lessons/end-crystals-heal-the-dragon", "lessons/end-crystals-heal-the-dragon-2"]);
    const reloaded = Wiki.load(root, lessons);
    assert.equal(reloaded.search("crystals")[0]!.status, "lesson");
    assert.equal(reloaded.read(second.id).meta.author, "ben");
  });

  it("never overwrites a lesson that another body wrote after this wiki loaded", async () => {
    const { root, lessons } = await fixture();
    const first = Wiki.load(root, lessons);
    const second = Wiki.load(root, lessons);
    const ana = await first.addLesson({ title: "Boats float", body: "Ana's lesson about boats." }, "ana");
    // `second` loaded before `ana` wrote, and sees the lesson when it searches.
    assert.equal(second.search("boats")[0]?.id, ana.id);
    const ben = await second.addLesson({ title: "Boats float", body: "Ben's lesson about boats." }, "ben");
    assert.deepEqual([ana.id, ben.id], ["lessons/boats-float", "lessons/boats-float-2"]);
    assert.match(first.read(ana.id).body, /Ana's lesson/);
    assert.equal(second.list("lessons").length, 2);
  });

  it("does not overwrite a lesson even when two bodies write at once", async () => {
    const { root, lessons } = await fixture();
    const wikis = ["ana", "ben", "cy"].map((author) => ({ author, wiki: Wiki.load(root, lessons) }));
    const written = await Promise.all(wikis.map(({ author, wiki }) => wiki.addLesson({ title: "Same title", body: `A lesson by ${author}.` }, author)));
    assert.equal(new Set(written.map((l) => l.id)).size, 3);
    assert.equal(Wiki.load(root, lessons).list("lessons").length, 3);
  });
});

describe("Wiki views", () => {
  const none: WikiView = { builtins: false, milestones: false, reflexes: false, routines: false };
  const all: WikiView = { builtins: true, milestones: true, reflexes: true, routines: true };

  async function featureFixture(): Promise<Wiki> {
    const { root } = await fixture();
    const page = (meta: string, body: string) => `---\n${meta}\n---\n\n${body}\n`;
    await mkdir(path.join(root, "minebot"));
    await writeFile(path.join(root, "minebot", "kits.md"), page("title: Kits are libraries\nrequires: [builtins]\nverified_by: test", "Call kit.gatherer.gather to gather logs."));
    await writeFile(
      path.join(root, "quirks", "logs.md"),
      page(
        "title: Gathering logs\nverified_by: test",
        "Dig the log, then walk over the drop.\n\n<!-- builtins -->\nkit.gatherer.gather digs and collects logs.\n<!-- /builtins -->\n\nCheck the inventory.\n\n<!-- milestones -->\nThe milestones count logs.\n<!-- /milestones -->\n\n<!-- routines -->\nSave your own kit with kits.save.\n<!-- /routines -->",
      ),
    );
    return Wiki.load(root);
  }

  it("hides pages that need a feature the body lacks", async () => {
    const wiki = await featureFixture();
    assert.ok(wiki.list(undefined, all).some((p) => p.id === "minebot/kits"));
    assert.ok(!wiki.list(undefined, none).some((p) => p.id === "minebot/kits"));
    assert.throws(() => wiki.read("minebot/kits", none), WikiPageNotFoundError);
    assert.ok(!wiki.search("gather logs", 5, none).some((h) => h.id === "minebot/kits"));
  });

  it("cuts feature blocks from pages and snippets, and drops the markers where the feature exists", async () => {
    const wiki = await featureFixture();
    const bare = wiki.read("quirks/logs", none).body;
    assert.equal(bare, "Dig the log, then walk over the drop.\n\nCheck the inventory.");
    const full = wiki.read("quirks/logs", all).body;
    assert.doesNotMatch(full, /<!--/);
    assert.match(full, /kit\.gatherer\.gather digs and collects logs\./);
    assert.match(full, /The milestones count logs\./);
    assert.match(full, /Save your own kit with kits\.save\./);
    const kitsOnly = wiki.read("quirks/logs", { builtins: true, milestones: false, reflexes: false, routines: false }).body;
    assert.match(kitsOnly, /kit\.gatherer/);
    assert.doesNotMatch(kitsOnly, /milestone|kits\.save/);
    const milestonesOnly = wiki.read("quirks/logs", { builtins: false, milestones: true, reflexes: false, routines: false }).body;
    assert.match(milestonesOnly, /The milestones count logs\./);
    assert.doesNotMatch(milestonesOnly, /kit\.|kits\.save/);
    // The search index sees the same text, so a query for kit words finds nothing in a body without kits.
    assert.deepEqual(wiki.search("kit.gatherer", 5, none).filter((h) => h.id === "quirks/logs" && /kit/.test(h.snippet)), []);
    assert.ok(wiki.search("collects", 5, all).some((h) => h.id === "quirks/logs"));
    assert.ok(!wiki.search("collects", 5, none).some((h) => h.id === "quirks/logs"));
  });

  it("applies the body's view through WikiAccess as its features change", async () => {
    const wiki = await featureFixture();
    let view = none;
    const access = new WikiAccess(wiki, "read", "ana", () => view);
    assert.ok(!access.list().some((p) => p.id === "minebot/kits"));
    view = all;
    assert.ok(access.list().some((p) => p.id === "minebot/kits"));
  });
});

describe("WikiAccess", () => {
  it("enforces the body's access mode", async () => {
    const { root, lessons } = await fixture();
    const wiki = Wiki.load(root, lessons);
    assert.throws(() => new WikiAccess(wiki, "off", "ana").search("drops"), WikiDisabledError);
    const readOnly = new WikiAccess(wiki, "read", "ana");
    assert.equal(readOnly.search("drops").length, 2);
    await assert.rejects(readOnly.addLesson({ title: "A lesson", body: "Something learned." }), /read-only/);
  });
});

describe("repository wiki", () => {
  it("loads, links only to pages that exist, and names check programs that exist", async () => {
    const wiki = Wiki.load(WIKI_DIR);
    const ids = new Set(wiki.pages.map((p) => p.id));
    for (const page of wiki.pages) {
      for (const [, linked] of page.body.matchAll(/`((?:mechanics|flows|quirks|minebot)\/[a-z0-9-]+)`/g)) {
        assert.ok(ids.has(linked!), `${page.id} links to missing page ${linked}`);
      }
      if (page.meta.check) {
        assert.ok(existsSync(path.join(WIKI_DIR, "checks", page.meta.check)), `${page.id}: missing check ${page.meta.check}`);
      }
    }
  });

  it("hides a page that requires routines, and cuts routines blocks, for a body without routines; wikiView follows the capability", async () => {
    const { root } = await fixture();
    const page = (meta: string, body: string) => `---\n${meta}\n---\n\n${body}\n`;
    await mkdir(path.join(root, "minebot"));
    await writeFile(path.join(root, "minebot", "routines.md"), page("title: Routines are modules\nrequires: [routines]\nverified_by: test", "Save a routine, then bind it."));
    await writeFile(path.join(root, "quirks", "logs.md"), page("title: Gathering logs\nverified_by: test", "Dig the log.\n\n<!-- routines -->\nSave a routine that digs.\n<!-- /routines -->"));
    const wiki = Wiki.load(root);
    const none: WikiView = { builtins: false, milestones: false, reflexes: false, routines: false };
    const all: WikiView = { ...none, routines: true };
    assert.ok(wiki.list(undefined, all).some((p) => p.id === "minebot/routines"));
    assert.ok(!wiki.list(undefined, none).some((p) => p.id === "minebot/routines"));
    assert.throws(() => wiki.read("minebot/routines", none), WikiPageNotFoundError);
    assert.equal(wiki.read("quirks/logs", none).body, "Dig the log.");
    assert.equal(wiki.read("quirks/logs", all).body, "Dig the log.\n\nSave a routine that digs.");
    const features = { wiki: "read" as const, lessons: false, milestones: false, reflexes: false, builtins: [] };
    assert.equal(wikiView({ ...features, routines: true }).routines, true);
    assert.equal(wikiView({ ...features, routines: false }).routines, false);
    assert.equal(FULL_VIEW.routines, true);
  });

  it("says nothing about kits or goals to a body that has neither", () => {
    const wiki = Wiki.load(WIKI_DIR);
    const view: WikiView = { builtins: false, milestones: false, reflexes: false, routines: false };
    const mentions = /\bkits?\b|\bkit\.|\blessons?\b|minebot goals|body's goals|milestone/i;
    const pages = wiki.list(undefined, view);
    assert.ok(pages.length > 10, "the repository wiki keeps its pages for a body without kits");
    for (const { id } of pages) {
      const page = wiki.read(id, view);
      for (const [where, text] of [
        ["title", page.meta.title],
        ["tags", page.meta.tags.join(" ")],
        ["verified_by", page.meta.verified_by],
        ["text", formatPage(page)],
      ] as const) {
        assert.doesNotMatch(text, mentions, `${id} ${where} mentions kits or goals`);
      }
    }
    for (const query of ["gather logs", "kit", "kits", "goals", "milestone progress", "wooden pickaxe", "stuck underground"]) {
      for (const hit of wiki.search(query, 20, view)) {
        assert.doesNotMatch(`${hit.title} ${hit.tags.join(" ")} ${hit.snippet}`, mentions, `search "${query}" shows ${hit.id}: ${hit.snippet}`);
      }
    }
  });

  it("keeps the kit shortcuts for a body that has kits", () => {
    const wiki = Wiki.load(WIKI_DIR);
    const view: WikiView = { builtins: true, milestones: false, reflexes: false, routines: false };
    assert.match(wiki.read("flows/first-day", view).body, /kit\.gatherer\.gather\(\{ blocks: "\*_log", count: 4 \}\)/);
    assert.ok(wiki.list(undefined, view).some((p) => p.id === "minebot/kits"));
    assert.doesNotMatch(wiki.read("flows/first-day", view).body, /<!--/);
  });

  it("shows the triggers page only to a body with reflexes, and keeps kits out of it when the body has none", () => {
    const wiki = Wiki.load(WIKI_DIR);
    const without: WikiView = { builtins: false, milestones: false, reflexes: false, routines: false };
    const triggersOnly: WikiView = { ...without, reflexes: true };
    assert.ok(!wiki.list(undefined, without).some((p) => p.id === "minebot/triggers"));
    assert.throws(() => wiki.read("minebot/triggers", without), WikiPageNotFoundError);
    assert.ok(wiki.search("trigger reflex", 20, without).every((h) => h.id !== "minebot/triggers"));
    const page = wiki.read("minebot/triggers", triggersOnly);
    assert.doesNotMatch(formatPage(page), /\bkits?\b|\bkit\./i);
    assert.match(wiki.read("minebot/triggers", { ...triggersOnly, builtins: true }).body, /kit\.survival\.eat/);
  });
});

describe("wiki reference pages", () => {
  const dir = path.join(WIKI_DIR, "reference");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  it("are small, current, and marked as generated", () => {
    const wiki = Wiki.load(WIKI_DIR);
    assert.ok(files.length >= 20, "recipes, blocks, drops, mobs, foods, enchantments, and tags are all there");
    for (const file of files) {
      const lines = readFileSync(path.join(dir, file), "utf8").split("\n").length;
      assert.ok(lines < 400, `${file} has ${lines} lines`);
      const page = wiki.read(`reference/${file.slice(0, -".md".length)}`);
      assert.equal(page.status, "verified", `${file} is not for ${MC_VERSION}; run npm run wiki:reference`);
      assert.match(page.meta.verified_by, /^generated from /);
    }
  });

  it("match minecraft-data for the pages that need nothing else", () => {
    const { reg, version } = loadMinecraftData();
    const pages = dataPages(reg, { mcData: version });
    assert.ok(pages.length >= 5);
    for (const generated of pages) {
      assert.equal(readFileSync(path.join(dir, `${generated.id}.md`), "utf8"), generated.text, `reference/${generated.id} is stale; run npm run wiki:reference`);
    }
  });

  it("splits entries into runs that fit the budget, keep their order, and end at a letter", () => {
    const entry = (name: string) => ({ name, text: "## x\n- a\n- b" }); // 3 lines, and 1 blank line between entries
    const letters = "abcdefg".split("").flatMap((l) => Array.from({ length: 10 }, (_, i) => entry(`${l}${i}`)));
    const pages = chunk(letters, 50);
    assert.deepEqual(pages.flat(), letters);
    for (const [i, run] of pages.entries()) {
      assert.ok(run.length * 4 <= 50, `run ${i} has ${run.length} entries`);
      if (i > 0) assert.notEqual(run[0]!.name[0], pages[i - 1]!.at(-1)!.name[0], "a run starts at a new letter when the letter fits");
    }
    // One letter larger than a page splits where it must.
    const big = Array.from({ length: 30 }, (_, i) => entry(`c${String(i).padStart(2, "0")}`));
    const split = chunk(big, 50);
    assert.deepEqual(split.flat(), big);
    assert.ok(split.length > 1 && split.every((run) => run.length * 4 <= 50));
  });

  it("merges recipe variants into patterns", () => {
    assert.equal(compress(["oak_planks", "birch_planks", "acacia_planks"]), "*_planks");
    assert.equal(compress(["white_wool", "white_bed", "white_dye"]), "white_*");
    assert.equal(compress(["b", "a"]), "a|b");
    assert.equal(compress(["x_y", "a_b", "c_d"]), "a_b|c_d|x_y");
  });

  it("answer the questions agents ask", () => {
    const wiki = Wiki.load(WIKI_DIR);
    const first = (query: string) => wiki.search(query, 1)[0]!.id;
    assert.equal(first("creeper"), "mechanics/creeper-fuse");
    assert.equal(first("bed monsters nearby"), "quirks/bed-monsters-nearby");
    assert.equal(first("nether portal"), "flows/build-nether-portal");
    assert.equal(first("farmland"), "mechanics/farmland-hydration");
    assert.match(wiki.read(first("iron pickaxe recipe")).body, /^## iron_pickaxe$/m);
    assert.match(wiki.read(first("what drops diamond")).body, /^## diamond$/m);
  });

  it("do not outrank the curated pages on the topic words they share", () => {
    const wiki = Wiki.load(WIKI_DIR);
    const first = (query: string) => wiki.search(query, 1)[0]!.id;
    assert.equal(first("smelting"), "mechanics/smelting");
    assert.equal(first("tool"), "mechanics/tool-tiers");
    assert.equal(first("tool tier"), "mechanics/tool-tiers");
    assert.equal(first("crafting recipe"), "mechanics/crafting-basics");
    assert.equal(first("food"), "mechanics/food-sources");
    assert.equal(first("enchanting"), "mechanics/enchanting-basics");
    for (const file of files.filter((f) => f !== "foods.md" && f !== "enchantments.md")) {
      const { meta } = wiki.read(`reference/${file.slice(0, -".md".length)}`);
      const generic = meta.tags.filter((t) => ["craft", "crafting", "smelt", "smelting", "furnace", "tool", "tier", "mining"].includes(t));
      assert.deepEqual(generic, [], `${file} carries topic words that belong to the curated pages`);
      assert.doesNotMatch(meta.title.replace(/^(Blocks|Recipe ingredients for|What drops each item:) .*? to \S+/, "$1"), /crafting|smelting|\btool\b/i, `${file} title`);
    }
  });

  it("states what a loot pool gives as one choice, and a tool tier once", () => {
    const mobs = readFileSync(path.join(dir, "mobs-hostile.md"), "utf8");
    assert.match(mobs, /one of iron_ingot \(1\), carrot \(1\), potato \(1[^)]*\) \[only when a player kills it; 2\.5% chance/);
    assert.match(mobs, /rolls 1-3: one of glowstone_dust/);
    assert.doesNotMatch(readFileSync(path.join(dir, "mobs-passive.md"), "utf8"), /white_wool \(/, "sixteen wools are one pattern");
    const blocks = files.filter((f) => f.startsWith("blocks-")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    assert.doesNotMatch(blocks, /copper or better/);
    assert.match(blocks, /\| iron_ore \| [\d.]+ \| pickaxe, stone or better \| raw_iron \|/);
    assert.match(blocks, /\| coal_ore \| [\d.]+ \| any pickaxe \| coal \|/);
  });
});
