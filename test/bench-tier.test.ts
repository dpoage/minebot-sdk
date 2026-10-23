// bench/tier/remove.ts over a temporary copy of the tree: it runs as the body service runs it, as a child process, and
// changes the copy only. What a body served from the stripped copy shows is held against what the repository's wiki shows
// that body.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WikiFeature } from "../src/protocol/index.ts";
import { FULL_VIEW, type WikiView } from "../src/wiki/access.ts";
import { formatPage, Wiki, WIKI_DIR } from "../src/wiki/wiki.ts";
import { strayVocabulary } from "./helpers/wiki-vocabulary.ts";

const ROOT = path.join(import.meta.dirname, "..");
const trees: string[] = [];
after(() => {
  for (const tree of trees) {
    chmodSync(path.join(tree, "src", "routines"), 0o755);
    rmSync(tree, { recursive: true, force: true });
  }
});

/** A copy of what the body image holds (the sources, the wiki, the removal script), sharing the repository's installed packages. */
function copyOfTree(): string {
  const tree = mkdtempSync(path.join(tmpdir(), "minebot-tier-"));
  trees.push(tree);
  for (const entry of ["src", "wiki", "bench/tier", "package.json"]) cpSync(path.join(ROOT, entry), path.join(tree, entry), { recursive: true });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"));
  return tree;
}

/** Runs the removal over `tree` with the body's flags, as the body service's command does. */
function remove(tree: string, ...flags: string[]): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", path.join(tree, "bench/tier/remove.ts"), "body", ...flags], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr };
}

const modulesLeft = (tree: string) => readdirSync(path.join(tree, "src/routines")).filter((file) => file !== "index.ts").map((file) => file.slice(0, -".ts".length));

/** Every file under `dir`, by relative path, with its content. */
function filesOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files[path.relative(dir, path.join(entry.parentPath, entry.name))] = readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

/** What `gatherer` and `crafter` offer together with them, written out here and not derived from the catalog. */
const GATHERER_CLOSURE = ["move", "sense", "dig", "inventory", "items", "gatherer"];
const KITS_CLOSURE = ["move", "sense", "dig", "place", "inventory", "craft", "items", "furnace", "gatherer", "crafter"];

describe("tier removal", () => {
  it("keeps the modules of the offer and what they use, and deletes every other module file", () => {
    const tree = copyOfTree();
    const all = modulesLeft(tree);
    assert.equal(all.length, 18);
    const run = remove(tree, "--bot=agent", "--builtins=gatherer", "--wiki=off", "--no-milestones");
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(modulesLeft(tree).sort(), [...GATHERER_CLOSURE].sort());
    const kits = copyOfTree();
    assert.equal(remove(kits, "--builtins=gatherer,crafter", "--wiki=off").status, 0);
    assert.deepEqual(modulesLeft(kits).sort(), [...KITS_CLOSURE].sort());
  });

  it("deletes every module file for --builtins=none, and none for a body that sets no --builtins", () => {
    const raw = copyOfTree();
    assert.equal(remove(raw, "--builtins=none", "--wiki=off").status, 0);
    assert.deepEqual(modulesLeft(raw), []);
    const full = copyOfTree();
    assert.equal(remove(full, "--wiki=off").status, 0);
    assert.equal(modulesLeft(full).length, 18);
  });

  it("takes the last of a repeated flag, as the body does", () => {
    const tree = copyOfTree();
    assert.equal(remove(tree, "--builtins=none", "--builtins=gatherer", "--wiki=read", "--wiki=off").status, 0);
    assert.deepEqual(modulesLeft(tree).sort(), [...GATHERER_CLOSURE].sort());
    assert.deepEqual(readdirSync(tree).sort(), ["bench", "node_modules", "package.json", "src"], "the wiki is gone");
  });

  it("deletes the wiki directory when the wiki is off", () => {
    const tree = copyOfTree();
    assert.equal(remove(tree, "--builtins=none", "--wiki=off").status, 0);
    assert.deepEqual(readdirSync(tree).sort(), ["bench", "node_modules", "package.json", "src"]);
  });

  /** The wiki a body with `view` serves from the repository, and the stripped copy read with every feature on: they must be the same pages. */
  function assertServes(tree: string, view: WikiView): void {
    const repo = Wiki.load(WIKI_DIR);
    const stripped = Wiki.load(path.join(tree, "wiki"));
    const ids = repo.list(undefined, view).map((page) => page.id);
    assert.ok(ids.length > 50);
    assert.deepEqual(stripped.list(undefined, FULL_VIEW).map((page) => page.id), ids);
    for (const id of ids) {
      assert.deepEqual(stripped.read(id, FULL_VIEW), repo.read(id, view), id);
      assert.equal(formatPage(stripped.read(id, view)), formatPage(repo.read(id, view)), `${id} read under the body's own view`);
    }
  }

  /** What the stripped copy's page files say, whole (front matter and markers included), to a body with `view`: each line that names a module that the view withholds, or a feature that it lacks. The README is not a page. */
  const strayOnDisk = (tree: string, view: WikiView) =>
    Object.entries(filesOf(path.join(tree, "wiki")))
      .filter(([file]) => file.endsWith(".md") && file !== "README.md")
      .flatMap(([file, text]) => strayVocabulary(text, view).map((found) => `${file} ${found}`));

  it("rewrites every page to the body's view when builtins are none, and deletes the pages that view hides", () => {
    const tree = copyOfTree();
    const before = filesOf(path.join(tree, "wiki"));
    assert.equal(remove(tree, "--bot=agent", "--builtins=none", "--wiki=read", "--no-milestones").status, 0);
    const view: WikiView = { builtins: false, milestones: false, reflexes: true, routines: true, modules: [] };
    assertServes(tree, view);
    const after = filesOf(path.join(tree, "wiki"));
    assert.ok(!("minebot/kits.md" in after) && "minebot/kits.md" in before, "the page that requires built-ins is deleted");
    assert.deepEqual(strayOnDisk(tree, view), []);
    for (const [file, text] of Object.entries(after)) {
      if (file.endsWith(".md") && file !== "README.md") assert.doesNotMatch(text, new RegExp(`<!-- /?(?:${WikiFeature.options.join("|")})[:\\s]`), `${file} keeps a cut marker`);
    }
    assert.equal(after["README.md"], before["README.md"], "the README is not a page");
    assert.deepEqual(Object.keys(after).filter((file) => file.startsWith("checks/")), Object.keys(before).filter((file) => file.startsWith("checks/")), "the check modules stay");
  });

  it("rewrites the pages of a body that offers some modules to the lines of those modules", () => {
    const tree = copyOfTree();
    assert.equal(remove(tree, "--builtins=gatherer,crafter", "--wiki=read", "--no-milestones", "--no-reflexes").status, 0);
    const view: WikiView = { builtins: true, milestones: false, reflexes: false, routines: true, modules: KITS_CLOSURE };
    assertServes(tree, view);
    assert.deepEqual(strayOnDisk(tree, view), []);
    const kits = readFileSync(path.join(tree, "wiki/minebot/kits.md"), "utf8");
    assert.match(kits, /minebot call gatherer\.gather/);
    assert.doesNotMatch(kits, /minebot-sdk\/routines\/(?!gatherer|crafter)|(?<![\w.])(?:survival|combat|farm)\.\w/);
  });

  it("serves a body that offers everything the pages as they are in the repository", () => {
    const tree = copyOfTree();
    assert.equal(remove(tree).status, 0);
    assert.equal(modulesLeft(tree).length, 18);
    assertServes(tree, FULL_VIEW);
  });

  it("changes nothing when it runs again, for each kind of tier", () => {
    for (const flags of [["--builtins=none", "--wiki=off"], ["--builtins=none", "--wiki=read", "--no-milestones"], ["--builtins=gatherer,crafter", "--wiki=read"], []]) {
      const tree = copyOfTree();
      assert.equal(remove(tree, ...flags).status, 0, flags.join(" "));
      const once = { src: filesOf(path.join(tree, "src/routines")), wiki: readdirSync(tree).includes("wiki") ? filesOf(path.join(tree, "wiki")) : null };
      const again = remove(tree, ...flags);
      assert.equal(again.status, 0, `${flags.join(" ")}: ${again.stderr}`);
      assert.deepEqual({ src: filesOf(path.join(tree, "src/routines")), wiki: readdirSync(tree).includes("wiki") ? filesOf(path.join(tree, "wiki")) : null }, once, flags.join(" "));
    }
  });

  it("exits non-zero, so the body does not start, when its flags are wrong or the removal fails", () => {
    for (const flags of [["--builtins=nosuch", "--wiki=off"], ["--builtins=none,gatherer"], ["--wiki=sometimes"], ["--no-such-flag"], ["--builtins=gatherer", "--no-milestones", "--milestones=m.json"]]) {
      const tree = copyOfTree();
      assert.notEqual(remove(tree, ...flags).status, 0, flags.join(" "));
      assert.equal(modulesLeft(tree).length, 18, `${flags.join(" ")} removed nothing`);
    }
    const notBody = copyOfTree();
    const run = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", path.join(notBody, "bench/tier/remove.ts"), "status", "--wiki=off"], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    // A page that cannot be read as a page.
    const broken = copyOfTree();
    writeFileSync(path.join(broken, "wiki/quirks/broken.md"), "no front matter\n");
    assert.notEqual(remove(broken, "--builtins=none", "--wiki=read").status, 0);
    // A module file that cannot be deleted (a read-only directory binds a non-root user only).
    if (process.getuid?.() !== 0) {
      const locked = copyOfTree();
      chmodSync(path.join(locked, "src/routines"), 0o555);
      assert.notEqual(remove(locked, "--builtins=none", "--wiki=off").status, 0);
      assert.equal(modulesLeft(locked).length, 18);
    }
  });
});
