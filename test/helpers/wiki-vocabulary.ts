/**
 * What the wiki tests hold each view of the repository wiki to: the words that belong to a feature, and the lines each page marks for one.
 * test/wiki.test.ts checks every view of the wiki on disk; test/features.test.ts checks the views that running bodies serve.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WikiFeature } from "../../src/protocol/index.ts";
import { BUILTIN_MODULES } from "../../src/routines/index.ts";
import type { WikiView } from "../../src/wiki/access.ts";
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

/** What names one built-in module: a call of one of its routines, such as `farm.harvest`, or an import of it, `minebot-sdk/routines/farm`. A bare module name is neither. */
export function moduleVocabulary(module: string): readonly RegExp[] {
  const routines = Object.keys(BUILTIN_MODULES.find((candidate) => candidate.name === module)!.routines);
  return [new RegExp(`(?<![\\w.])${module}\\.(?:${routines.join("|")})\\b`), new RegExp(`minebot-sdk/routines/${module}\\b`)];
}

/**
 * The vocabulary that `text` shows from features `view` lacks, one entry per line and pattern: `<feature> <pattern>: <line>`.
 * A view that offers some built-in modules (`view.modules`) also lacks the calls and imports of the others: `module <name> <pattern>: <line>`.
 */
export function strayVocabulary(text: string, view: WikiView): string[] {
  const stray: string[] = [];
  const lines = text.split("\n");
  for (const feature of WikiFeature.options) {
    if (view[feature]) continue;
    for (const pattern of VOCABULARY[feature] ?? []) {
      for (const line of lines) if (pattern.test(line)) stray.push(`${feature} ${pattern}: ${line.trim()}`);
    }
  }
  for (const { name } of BUILTIN_MODULES) {
    if (view.modules === undefined || view.modules.includes(name)) continue;
    for (const pattern of moduleVocabulary(name)) {
      for (const line of lines) if (pattern.test(line)) stray.push(`module ${name} ${pattern}: ${line.trim()}`);
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

const MARKER = new RegExp(`<!-- (/?)(${WikiFeature.options.join("|")}|builtins:[a-z]+(?:,[a-z]+)*) -->`);

/** The lines of a repository page's file between markers: the block that holds each one, as its feature and the modules it needs (none outside a per-module block). */
function blockLines(id: string): { feature: WikiFeature | null; modules: string[]; text: string }[] {
  const lines: { feature: WikiFeature | null; modules: string[]; text: string }[] = [];
  let open: string | null = null;
  for (const line of readFileSync(path.join(WIKI_DIR, `${id}.md`), "utf8").split("\n")) {
    const text = line.trim();
    const marker = MARKER.exec(text);
    if (!marker) {
      if (text) {
        const [feature, modules] = open === null ? [null, undefined] : open.split(":");
        lines.push({ feature: feature as WikiFeature | null, modules: modules?.split(",") ?? [], text });
      }
      continue;
    }
    assert.equal(marker[0], text, `${id}: a marker must be alone on its line: ${text}`);
    const gate = marker[2]!;
    assert.equal(open, marker[1] ? gate : null, `${id}: unbalanced ${text}`);
    open = marker[1] ? null : gate;
    for (const module of gate.split(":")[1]?.split(",") ?? []) assert.ok(BUILTIN_MODULES.some((candidate) => candidate.name === module), `${id}: ${text} names no built-in module`);
  }
  assert.equal(open, null, `${id}: <!-- ${open} --> is never closed`);
  return lines;
}

/** The lines of block `line` sits in, as the key that tells blocks apart: its feature and modules. */
const gateOf = (line: { feature: WikiFeature | null; modules: string[] }) => `${line.feature}:${line.modules.join(",")}`;

/**
 * Each feature's marked lines on a repository page, parsed from its file: the trimmed lines inside its `<!-- feature -->` blocks, per-module blocks of `builtins` included,
 * that no line outside their own block repeats.
 */
export function markedLines(id: string): Record<WikiFeature, string[]> {
  const lines = blockLines(id);
  const marked = Object.fromEntries(WikiFeature.options.map((feature) => [feature, [] as string[]])) as Record<WikiFeature, string[]>;
  for (const line of lines) {
    if (line.feature && !marked[line.feature].includes(line.text) && !lines.some((other) => gateOf(other) !== gateOf(line) && other.text === line.text)) marked[line.feature].push(line.text);
  }
  return marked;
}

/** The modules each marked line of a repository page needs, by line: the page's per-module blocks, and none for a line outside them. A body that lacks one of them does not show the line. */
export function markedModules(id: string): Map<string, string[]> {
  return new Map(blockLines(id).filter((line) => line.modules.length > 0).map((line) => [line.text, line.modules]));
}
