// Enforces a benchmark body's tier by absence: before the body starts, it deletes what the body's flags withhold, from the
// container's own layer, so no code that runs in the body can read it. The body service's command runs this first and the
// body only when it succeeds (see compose() in gen-tasks.ts):
//   sh -c 'node --conditions=minebot-sdk:source /opt/minebot/bench/tier/remove.ts "$@" && exec minebot "$@"' tier body <flags>
// It takes the body's argv, parses it with the body's own options and rules (src/client/body-flags.ts), and:
//  - deletes the source file of every built-in module outside the offer closure (the catalog then lists only the rest);
//  - deletes the wiki when the body's wiki is off;
//  - otherwise rewrites every wiki page to the view of the body's features: the same text `wiki read` serves, with the page's
//    own front matter, and deletes the pages that view hides.
// Running it again on the stripped tree changes nothing. Any error exits non-zero, so the body never starts.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BODY_FLAG_OPTIONS, builtinOffer, parseBodyFlags } from "../../src/client/body-flags.ts";
import { closureOf } from "../../src/host/routines/builtins.ts";
import { PACKAGE_ROOT } from "../../src/package.ts";
import type { BodyFeatures } from "../../src/protocol/index.ts";
import { BUILTIN_MODULES } from "../../src/routines/index.ts";
import { wikiView } from "../../src/wiki/access.ts";
import { pageFileFor } from "../../src/wiki/page.ts";

const WIKI_DIR = path.join(PACKAGE_ROOT, "wiki");

const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { bot: { type: "string" }, ...BODY_FLAG_OPTIONS } });
if (positionals.length !== 1 || positionals[0] !== "body") throw new Error(`expected the command "body", got ${JSON.stringify(positionals)}`);
const flags = parseBodyFlags(values.bot ?? "bot", values);

// The offer: no `--builtins` offers every module, otherwise the closure of the names over what they use.
const offer = flags.builtins === undefined ? BUILTIN_MODULES : closureOf(builtinOffer(flags.builtins)!);
const offered = new Set(offer.map((module) => module.name));
const withheld = BUILTIN_MODULES.filter((module) => !offered.has(module.name));
for (const module of withheld) await rm(module.file, { force: true });

if (flags.wiki === "off") {
  await rm(WIKI_DIR, { recursive: true, force: true });
} else {
  // The body's features, as src/body/main.ts and src/host/world.ts derive them from these flags; `--routines ""` is a body without a library.
  const features: BodyFeatures = {
    wiki: flags.wiki,
    lessons: flags.wiki === "write",
    milestones: !flags.noMilestones,
    reflexes: !flags.noReflexes,
    routines: !flags.noRoutines && flags.routines !== "",
    builtins: offer.map((module) => module.name),
  };
  const view = wikiView(features);
  const entries = await readdir(WIKI_DIR, { withFileTypes: true, recursive: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  for (const entry of entries) {
    // The pages are the markdown files other than the README (src/wiki/page.ts, readPages).
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const file = path.join(entry.parentPath, entry.name);
    const id = path.relative(WIKI_DIR, file).slice(0, -".md".length).split(path.sep).join("/");
    const text = await readFile(file, "utf8");
    const shown = pageFileFor(id, text, view);
    if (shown === null) await rm(file, { force: true });
    else if (shown !== text) await writeFile(file, shown);
  }
}

console.error(`[tier] withheld modules removed: ${withheld.map((module) => module.name).join(", ") || "none"}; wiki ${flags.wiki}`);
