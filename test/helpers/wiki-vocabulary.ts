/**
 * What the wiki tests hold each view of the repository wiki to: the words that belong to a feature, and the lines each page marks for one.
 * test/wiki.test.ts checks every view of the wiki on disk; test/features.test.ts checks the views that running bodies serve.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WikiFeature } from "../../src/protocol/index.ts";
import { BUILTIN_MODULES } from "../../src/routines/index.ts";
import { WIKI_DIR } from "../../src/wiki/wiki.ts";

/** Every built-in routine's call name, `<module>.<routine>`, from the catalog. */
export const BUILTIN_CALLS: readonly string[] = BUILTIN_MODULES.flatMap((module) => Object.keys(module.routines).map((routine) => `${module.name}.${routine}`));

/** The words that tell an agent about the built-in routines. A view without built-ins shows none of them. */
export const BUILTINS_VOCABULARY: readonly RegExp[] = [
  /built-in routine/i,
  /minebot builtins/,
  // Any module.routine call, with or without flags before the name.
  /minebot call (?:--[\w-]+ \S+ )*[a-z][\w-]*\.\w/,
  /minebot-sdk\/routines\//,
  /--builtins/,
  // A catalog name in code or prose, such as `farm.harvest`. A name after `.` or a word character is not one: `bot.inventory.count` is Mineflayer's.
  new RegExp(`(?<![\\w.])(?:${BUILTIN_CALLS.map((call) => call.replace(".", "\\.")).join("|")})\\b`),
];

/** The words that tell an agent about reflexes. A view without reflexes shows none of them. */
export const REFLEXES_VOCABULARY: readonly RegExp[] = [/reflex/i, /minebot bind reflex/, /--reflexes/];

const VOCABULARY: Partial<Record<WikiFeature, readonly RegExp[]>> = { builtins: BUILTINS_VOCABULARY, reflexes: REFLEXES_VOCABULARY };

/** The vocabulary that `text` shows from features `view` lacks, one entry per line and pattern: `<feature> <pattern>: <line>`. */
export function strayVocabulary(text: string, view: Record<WikiFeature, boolean>): string[] {
  const stray: string[] = [];
  for (const feature of WikiFeature.options) {
    if (view[feature]) continue;
    for (const pattern of VOCABULARY[feature] ?? []) {
      for (const line of text.split("\n")) if (pattern.test(line)) stray.push(`${feature} ${pattern}: ${line.trim()}`);
    }
  }
  return stray;
}

/** The searches that a view's results are checked against: each vocabulary term as an agent would type it, every catalog name, and the topic words the reviewers searched. */
export const WIKI_SEARCH_QUERIES: readonly string[] = [
  "built-in routine",
  "built-in routines",
  "minebot builtins",
  "minebot builtins search",
  "minebot call gatherer.gather",
  "minebot-sdk/routines/",
  "--builtins",
  "reflex",
  "reflexes",
  "minebot bind reflex",
  "--reflexes",
  ...BUILTIN_CALLS,
  "built-in routine enchants",
  "built-in routine trades",
  "enchanting",
  "villagers and trading",
  "gather logs",
  "wooden pickaxe",
  "stuck underground",
  "trigger reflex",
  "eat when food is low",
  "sleep in a bed",
  "smelt iron",
  "grow wheat",
  "crafting table",
  "bucket of water",
  "armor",
  "bind a routine",
  "automatic events",
];

const MARKER = new RegExp(`<!-- (/?)(${WikiFeature.options.join("|")}) -->`);

/** Each feature's marked lines on a repository page, parsed from its file: the trimmed lines inside its `<!-- feature -->` blocks that no line outside them repeats. */
export function markedLines(id: string): Record<WikiFeature, string[]> {
  const lines: { feature: WikiFeature | null; text: string }[] = [];
  let open: WikiFeature | null = null;
  for (const line of readFileSync(path.join(WIKI_DIR, `${id}.md`), "utf8").split("\n")) {
    const text = line.trim();
    const marker = MARKER.exec(text);
    if (!marker) {
      if (text) lines.push({ feature: open, text });
      continue;
    }
    assert.equal(marker[0], text, `${id}: a marker must be alone on its line: ${text}`);
    const feature = marker[2] as WikiFeature;
    assert.equal(open, marker[1] ? feature : null, `${id}: unbalanced ${text}`);
    open = marker[1] ? null : feature;
  }
  assert.equal(open, null, `${id}: <!-- ${open} --> is never closed`);
  const marked = Object.fromEntries(WikiFeature.options.map((feature) => [feature, [] as string[]])) as Record<WikiFeature, string[]>;
  for (const { feature, text } of lines) {
    if (feature && !marked[feature].includes(text) && !lines.some((other) => other.feature !== feature && other.text === text)) marked[feature].push(text);
  }
  return marked;
}
