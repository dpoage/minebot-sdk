// Runs each wiki page's check module against a live body and reports which pages still hold.
//   node --conditions=minebot-sdk:source scripts/wiki-check.ts --bot <name>
// A check module is sent to the body as it is, as `minebot run` sends a file: its default export, `async (ctx) => value`,
// returns while its page is true and throws when it is not.
// Rerun after changing MC_VERSION or upgrading Mineflayer; update `mc_version` on pages that pass.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BodyClient } from "../src/client/client.ts";
import { MC_VERSION } from "../src/mc/version.ts";
import { Wiki, WIKI_DIR } from "../src/wiki/wiki.ts";

const { values: args } = parseArgs({
  options: {
    bot: { type: "string", default: process.env.MINEBOT_BOT ?? "bot" },
    "wiki-dir": { type: "string", default: WIKI_DIR },
  },
});

const wiki = Wiki.load(args["wiki-dir"]);
const client = await BodyClient.connect(args.bot);
const checked = wiki.pages.filter((p) => p.meta.check);
let failed = 0;
for (const page of checked) {
  const code = await readFile(path.join(args["wiki-dir"], "checks", page.meta.check!), "utf8");
  const run = await client.run(code, undefined, 120_000);
  const ok = run.status === "ok";
  if (!ok) failed++;
  const stale = page.meta.mc_version !== MC_VERSION ? ` (page says ${page.meta.mc_version ?? "unverified"})` : "";
  console.log(`${ok ? "PASS" : "FAIL"} ${page.id}${stale}`);
  if (!ok) console.log(`     ${(run.error ?? run.status).split("\n")[0]}`);
}
const unchecked = wiki.pages.length - checked.length;
console.log(`\n${checked.length - failed}/${checked.length} checks pass on ${MC_VERSION}; ${unchecked} pages have no check module.`);
process.exit(failed === 0 ? 0 : 1);
