// Generates the wiki's reference pages (wiki/reference/*.md) from the game's data.
//   node scripts/wiki-reference.ts [--server-jar .dev-server/server-26.1.jar] [--out wiki/reference]
// Recipes, blocks, foods, mobs, and enchantments come from minecraft-data, the data Mineflayer loads.
// minecraft-data has no smelting, stonecutting, or smithing recipes, no item tags, and only 1.20 mob loot,
// so the script runs the vanilla server's own data generator (java -jar server.jar --server) into a
// temporary directory and reads those from it. Run it again after you change MC_VERSION or upgrade
// minecraft-data.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { IndexedData } from "minecraft-data";
import { MC_VERSION } from "../src/mc/version.ts";

const require = createRequire(import.meta.url);

/** Lines of body per page. With the frontmatter and the intro a page stays well under 400 lines. */
export const PAGE_LINES = 330;

// ---------------------------------------------------------------------------------------------
// Layout: sorted entries become pages

export interface Entry {
  /** The sort key and first-letter bucket: an item, block, or mob name. */
  name: string;
  /** Rendered markdown for the entry. */
  text: string;
}

/**
 * Splits sorted entries into runs of at most `budget` lines. A run ends at a letter boundary when it can,
 * so that a page covers whole letters and a search for a name lands on the page of its first letter.
 * `separator` is what joins two entries on the page; it adds lines of its own.
 */
export function chunk(entries: readonly Entry[], budget = PAGE_LINES, separator = "\n\n"): Entry[][] {
  const gap = separator.split("\n").length - 1;
  const size = (e: Entry) => e.text.split("\n").length + gap;
  const pages: Entry[][] = [];
  let run: Entry[] = [];
  let lines = 0;
  for (const entry of entries) {
    if (run.length > 0 && lines + size(entry) > budget) {
      // Cut at the last letter boundary in the run when that keeps at least a third of a page.
      let cut = run.length;
      for (let i = run.length - 1; i > 0; i--) {
        if (run[i]!.name[0] !== run[i - 1]!.name[0]) {
          cut = i;
          break;
        }
      }
      if (run.slice(0, cut).reduce((n, e) => n + size(e), 0) < budget / 3) cut = run.length;
      pages.push(run.slice(0, cut));
      run = run.slice(cut);
      lines = run.reduce((n, e) => n + size(e), 0);
    }
    run.push(entry);
    lines += size(entry);
  }
  if (run.length > 0) pages.push(run);
  return pages;
}

export interface PageFile {
  /** File name without `.md`, under the reference directory. */
  id: string;
  /** The whole file. */
  text: string;
}

export interface Group {
  /** Id prefix: `recipes`, `blocks`, `drops`. */
  prefix: string;
  /** Title for a page of the group; receives the first and last entry name. */
  title: (first: string, last: string) => string;
  tags: string[];
  verifiedBy: string;
  /** Text before the entries. */
  intro: string;
  /** What joins two entries: a blank line, or a newline for table rows. */
  separator: string;
  entries: Entry[];
}

/** One whole page file. */
export function page(title: string, tags: string[], verifiedBy: string, body: string): string {
  const meta = `---\ntitle: ${JSON.stringify(title)}\ntags: [${tags.join(", ")}]\nmc_version: ${JSON.stringify(MC_VERSION)}\nverified_by: ${JSON.stringify(verifiedBy)}\n---\n`;
  return `${meta}\n${body.trim()}\n`;
}

/** Lays a group out as pages named by the letters they cover (`recipes-a`, `recipes-b-c`; `-1`, `-2` when one letter needs several). */
export function layout(group: Group): PageFile[] {
  const sorted = [...group.entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const runs = chunk(sorted, PAGE_LINES, group.separator);
  const labels = runs.map((run) => run[0]!.name[0]!);
  const total = new Map<string, number>();
  for (const label of labels) total.set(label, (total.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return runs.map((run, i) => {
    const label = labels[i]!;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    const id = `${group.prefix}-${label}${total.get(label)! > 1 ? `-${n}` : ""}`;
    const title = group.title(run[0]!.name, run[run.length - 1]!.name);
    const body = `${group.intro}\n\n${run.map((e) => e.text).join(group.separator)}`;
    return { id, text: page(title, group.tags, group.verifiedBy, body) };
  });
}

// ---------------------------------------------------------------------------------------------
// minecraft-data

const strip = (id: string) => id.replace(/^(#?)minecraft:/, "$1");

/** `a`, `a or b`, `a, b, or c`. */
const alt = (names: string[]) => (names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`);

/** Several names that share an ending or a start become one pattern: `*_planks`. Otherwise they stay a list. */
export function compress(names: string[]): string {
  const unique = [...new Set(names)].sort();
  if (unique.length <= 2) return unique.join("|");
  const parts = unique.map((n) => n.split("_"));
  const first = parts[0]!;
  let tail = 0;
  while (parts.every((p) => p.length > tail + 1 && p[p.length - 1 - tail] === first[first.length - 1 - tail])) tail++;
  if (tail > 0) return `*_${first.slice(first.length - tail).join("_")}`;
  let head = 0;
  while (parts.every((p) => p.length > head + 1 && p[head] === first[head])) head++;
  if (head > 0) return `${first.slice(0, head).join("_")}_*`;
  return unique.join("|");
}

interface RecipeGroup {
  shaped: boolean;
  rows: number;
  cols: number;
  count: number;
  /** One entry per variant: the item id in each slot, in reading order. */
  variants: (number | null)[][];
}

/** The crafting recipes of one result, with variants that differ only in a slot's item (the wood type) merged. */
function craftingLines(reg: IndexedData, id: number): string[] {
  const groups = new Map<string, RecipeGroup>();
  for (const r of reg.recipes[id] ?? []) {
    const shaped = "inShape" in r;
    const rows = shaped ? r.inShape.length : 0;
    const cols = shaped ? (r.inShape[0]?.length ?? 0) : 0;
    const cells: (number | null)[] = shaped ? r.inShape.flat().map((c) => (typeof c === "number" ? c : null)) : r.ingredients.map((c) => (typeof c === "number" ? c : null));
    const result = r.result;
    const count = Array.isArray(result) ? (result[1] ?? 1) : typeof result === "object" && result !== null ? (result.count ?? 1) : 1;
    // Slots that hold the same item stay tied together; another tie pattern is another recipe.
    const ties = cells.map((c) => (c === null ? "-" : String(cells.indexOf(c))));
    const key = `${shaped ? `${rows}x${cols}` : "list"}:${count}:${ties.join(",")}`;
    const group: RecipeGroup = groups.get(key) ?? { shaped, rows, cols, count, variants: [] };
    group.variants.push(cells);
    groups.set(key, group);
  }
  const lines: string[] = [];
  for (const group of groups.values()) {
    const cells = group.variants[0]!.map((_, i) => {
      const set = new Set(group.variants.map((v) => v[i]));
      return set.has(null) ? "-" : compress([...set].map((n) => reg.items[n as number]?.name ?? `item_${n}`));
    });
    const need = new Map<string, number>();
    for (const c of cells) if (c !== "-") need.set(c, (need.get(c) ?? 0) + 1);
    const needs = [...need].map(([n, k]) => (k > 1 ? `${n} x${k}` : n)).join(", ");
    const result = group.count > 1 ? ` -> x${group.count}` : "";
    if (group.shaped) {
      const grid = group.rows <= 2 && group.cols <= 2 ? "2x2 inventory grid" : "3x3, crafting table";
      const rows = Array.from({ length: group.rows }, (_, r) => cells.slice(r * group.cols, (r + 1) * group.cols).join(" "));
      lines.push(`- crafting (${grid})${result}: ${needs}. Rows, top to bottom: ${rows.join(" / ")}`);
    } else {
      lines.push(`- crafting, shapeless (${cells.length <= 4 ? "2x2 inventory grid" : "3x3, crafting table"})${result}: ${needs}`);
    }
  }
  return lines;
}

/** Pickaxe tiers from weakest to strongest. A golden pickaxe mines what a wooden one does, and a copper pickaxe what a stone one does. */
const TIERS = ["wooden", "golden", "stone", "copper", "iron", "diamond", "netherite"];
/** What speeds up a block that needs no tool, by minecraft-data material word. */
const FASTER: Record<string, string> = { "mineable/pickaxe": "pickaxe", "mineable/axe": "axe", "mineable/shovel": "shovel", "mineable/hoe": "hoe", coweb: "sword or shears", wool: "shears", leaves: "shears", sword_instantly_mines: "sword" };

/** What mining a block takes. `needed` is true when a lower tool tier drops nothing. */
function toolFor(reg: IndexedData, block: IndexedData["blocksArray"][number]): { text: string; needed: boolean } {
  if (!block.diggable) return { text: "cannot be broken", needed: false };
  if (block.harvestTools) {
    const tools = Object.keys(block.harvestTools).map((id) => reg.items[Number(id)]!.name);
    const kind = tools[0]!.replace(/^[a-z]+_/, "");
    const tiers = tools.map((t) => t.replace(`_${kind}`, ""));
    const lowest = TIERS.find((t) => tiers.includes(t))!;
    return { text: lowest === "wooden" ? `any ${kind}` : `${kind}, ${lowest} or better`, needed: true };
  }
  const faster = (block.material ?? "").split(";").map((m) => FASTER[m]).find(Boolean);
  return { text: faster ? `none needed; ${faster} is faster` : "none needed", needed: false };
}

// ---------------------------------------------------------------------------------------------
// The server's data generator

/** A number or a range in the data packs: `3`, or `{ min, max }`, or `{ value }`. */
type NumberProvider = number | { min?: number; max?: number; value?: number };

interface ServerRecipe {
  type: string;
  ingredient?: string | string[];
  base?: string | string[];
  addition?: string | string[];
  template?: string | string[];
  cookingtime?: number;
  result?: { id: string; count?: number };
}

interface LootCondition {
  condition: string;
  chance?: NumberProvider;
  unenchanted_chance?: NumberProvider;
  terms?: LootCondition[];
}

interface LootEntry {
  type: string;
  name?: string;
  value?: string;
  children?: LootEntry[];
  conditions?: LootCondition[];
  functions?: { function: string; count?: NumberProvider }[];
}

interface LootTable {
  pools?: { rolls?: NumberProvider; entries?: LootEntry[]; conditions?: LootCondition[] }[];
}

interface ServerData {
  readJson<T>(file: string): T;
  list(dir: string): string[];
  exists(file: string): boolean;
}

function generateServerData(jar: string, scratch: string): ServerData {
  if (!existsSync(jar)) throw new Error(`server jar not found: ${jar}. Run \`node scripts/dev-server.ts\` once to download it, or pass --server-jar.`);
  // The bundler unpacks libraries/, versions/, and logs/ into the working directory: keep them in scratch.
  execFileSync("java", ["-DbundlerMainClass=net.minecraft.data.Main", "-jar", path.resolve(jar), "--server", "--output", scratch], { cwd: scratch, stdio: "ignore" });
  const dir = path.join(scratch, "data", "minecraft");
  return {
    // The generator wrote these files a moment ago in the shape the interfaces above describe.
    readJson: <T>(file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T,
    list: (d) => readdirSync(path.join(dir, d), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
    exists: (file) => existsSync(path.join(dir, file)),
  };
}

/** An item tag, expanded to the items it holds. */
function tagMembers(server: ServerData, tag: string, seen = new Set<string>()): string[] {
  if (seen.has(tag)) return [];
  seen.add(tag);
  const { values } = server.readJson<{ values: string[] }>(`tags/item/${tag}.json`);
  return values.flatMap((v) => (v.startsWith("#") ? tagMembers(server, strip(v).slice(1), seen) : [strip(v)]));
}

/** An ingredient field as text; tags it names go into `tags`. */
function ingredientOf(raw: string | string[] | undefined, tags: Set<string>): string {
  const list = (Array.isArray(raw) ? raw : [raw ?? ""]).map(strip);
  for (const v of list) if (v.startsWith("#")) tags.add(v.slice(1));
  return alt(list);
}

const STATION: Record<string, string> = { smelting: "furnace", blasting: "blast furnace", smoking: "smoker", campfire_cooking: "campfire" };

/** Cooking, stonecutting, and smithing recipes as lines, by result item. */
function serverRecipes(server: ServerData, tags: Set<string>): Map<string, string[]> {
  const byResult = new Map<string, Map<string, string[]>>();
  const add = (result: string, kind: string, ingredient: string) => {
    const kinds = byResult.get(result) ?? new Map<string, string[]>();
    kinds.set(kind, [...(kinds.get(kind) ?? []), ingredient]);
    byResult.set(result, kinds);
  };
  for (const file of server.list("recipe").sort()) {
    const r = server.readJson<ServerRecipe>(`recipe/${file}`);
    const type = strip(r.type);
    const result = strip(r.result?.id ?? "");
    const station = STATION[type];
    if (station) {
      add(result, `${station}, ${(r.cookingtime ?? 0) / 20} s per item`, ingredientOf(r.ingredient, tags));
    } else if (type === "stonecutting") {
      add(result, `stonecutter${(r.result?.count ?? 1) > 1 ? `, x${r.result?.count}` : ""}`, ingredientOf(r.ingredient, tags));
    } else if (type === "smithing_transform") {
      add(result, "smithing table", `${ingredientOf(r.base, tags)} + ${ingredientOf(r.addition, tags)} + ${ingredientOf(r.template, tags)}`);
    }
  }
  const lines = new Map<string, string[]>();
  for (const [result, kinds] of byResult) {
    lines.set(result, [...kinds].map(([kind, ingredients]) => `- ${kind}: ${[...new Set(ingredients)].join("; ")}`));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Mob loot

interface Drop {
  item: string;
  min: number;
  max: number;
  notes: Set<string>;
}

/** One loot pool. Each roll picks one option by weight, and an option gives one drop or, for a nested table, several. */
interface Pool {
  rolls: [number, number];
  options: Drop[][];
  notes: string[];
}

function range(value: NumberProvider | undefined): [number, number] {
  if (typeof value === "number") return [value, value];
  if (value?.min !== undefined && value.max !== undefined) return [value.min, value.max];
  if (value?.value !== undefined) return [value.value, value.value];
  return [1, 1];
}

const percent = (chance: NumberProvider | undefined) => `${Math.round(range(chance)[0] * 10000) / 100}%`;

/** Plain-words notes for loot conditions. */
function conditionNotes(conditions: LootCondition[] | undefined): string[] {
  const notes: string[] = [];
  for (const c of conditions ?? []) {
    switch (strip(c.condition)) {
      case "killed_by_player":
        notes.push("only when a player kills it");
        break;
      case "random_chance":
        notes.push(`${percent(c.chance)} chance`);
        break;
      case "random_chance_with_enchanted_bonus":
        notes.push(`${percent(c.unenchanted_chance)} chance, better with looting`);
        break;
      case "any_of":
        notes.push(...conditionNotes(c.terms));
        break;
      case "entity_properties":
        notes.push("depends on the mob's state");
        break;
      case "damage_source_properties":
        notes.push("depends on the damage source");
        break;
      default:
        notes.push("conditional");
    }
  }
  return [...new Set(notes)];
}

const withNotes = (options: Drop[][], notes: string[]): Drop[][] => options.map((option) => option.map((d) => ({ ...d, notes: new Set([...notes, ...d.notes]) })));

/** The options one loot entry gives. Alternatives give one option per child; a group gives all its children as one option. */
function entryOptions(server: ServerData, entry: LootEntry, depth: number): Drop[][] {
  const notes = conditionNotes(entry.conditions);
  const type = strip(entry.type);
  if (type === "item") {
    let min = 1;
    let max = 1;
    const extra: string[] = [];
    for (const fn of entry.functions ?? []) {
      const name = strip(fn.function);
      if (name === "set_count") {
        // A range that dips below zero, such as -1 to 1, drops nothing in its negative half.
        const [low, high] = range(fn.count);
        [min, max] = [Math.max(0, low), Math.max(0, high)];
      } else if (name === "furnace_smelt") {
        extra.push("cooked when it dies burning");
      } else if (name === "enchanted_count_increase") {
        extra.push("more with looting");
      }
    }
    return [[{ item: strip(entry.name ?? ""), min, max, notes: new Set([...notes, ...extra]) }]];
  }
  if (type === "loot_table") {
    const file = `loot_table/${strip(entry.value ?? "")}.json`;
    if (depth > 4 || !server.exists(file)) return [];
    const drops = lootPools(server, server.readJson<LootTable>(file), depth + 1).flatMap((p) => withNotes(p.options, p.notes).flat());
    return drops.length > 0 ? withNotes([drops], notes) : [];
  }
  if (type === "alternatives") return withNotes((entry.children ?? []).flatMap((child) => entryOptions(server, child, depth)), notes);
  if (type === "group" || type === "sequence") {
    const drops = (entry.children ?? []).flatMap((child) => entryOptions(server, child, depth).flat());
    return drops.length > 0 ? withNotes([drops], notes) : [];
  }
  return [];
}

function lootPools(server: ServerData, table: LootTable, depth = 0): Pool[] {
  return (table.pools ?? [])
    .map((pool) => ({ rolls: range(pool.rolls), options: (pool.entries ?? []).flatMap((entry) => entryOptions(server, entry, depth)), notes: conditionNotes(pool.conditions) }))
    .filter((pool) => pool.options.length > 0);
}

/** What a mob drops, as pools. */
function mobPools(server: ServerData, mob: string): Pool[] {
  const file = `loot_table/entities/${mob}.json`;
  return server.exists(file) ? lootPools(server, server.readJson<LootTable>(file)) : [];
}

const countText = (d: Drop) => (d.min === d.max ? `${d.max}` : `${d.min}-${d.max}`);
const detail = (d: Drop, extra: string[]) => {
  const notes = [...d.notes, ...extra];
  return `(${countText(d)}${notes.length ? `; ${notes.join("; ")}` : ""})`;
};
const dropText = (d: Drop) => `${d.item} ${detail(d, [])}`;

/** The choices of a pool as text. Single drops with the same count and notes whose names share an ending (sixteen wools) become one pattern. */
function choiceTexts(options: Drop[][]): string[] {
  const singles = new Map<string, Drop[]>();
  const rest: string[] = [];
  for (const option of options) {
    if (option.length !== 1) {
      rest.push(option.map(dropText).join(" + "));
      continue;
    }
    const d = option[0]!;
    const key = `${d.min}|${d.max}|${[...d.notes].sort().join(";")}`;
    singles.set(key, [...(singles.get(key) ?? []), d]);
  }
  const grouped = [...singles.values()].map((same) => {
    const pattern = compress(same.map((d) => d.item));
    return same.length >= 3 && pattern.startsWith("*_") ? dropText({ ...same[0]!, item: pattern }) : same.map(dropText).join(", ");
  });
  return [...grouped, ...rest];
}

/** One pool as a clause: `one of a (1), b (1) [conditions]`, with the rolls in front when a pool rolls more than once. */
function poolText(pool: Pool): string {
  const [low, high] = pool.rolls;
  const rolls = low === 1 && high === 1 ? "" : `rolls ${low === high ? low : `${low}-${high}`}: `;
  const choices = choiceTexts(pool.options).join(", ");
  const notes = pool.notes.length > 0 ? ` [${pool.notes.join("; ")}]` : "";
  return `${rolls}${pool.options.length > 1 ? "one of " : ""}${choices}${notes}`;
}

const dropsLine = (pools: Pool[]) => (pools.length === 0 ? "nothing" : pools.map(poolText).join("; "));

// ---------------------------------------------------------------------------------------------
// Pages

export interface Sources {
  /** The minecraft-data package version. */
  mcData: string;
}

/** The items a block drops, by name. */
function blockDrops(reg: IndexedData, block: IndexedData["blocksArray"][number]): string[] {
  return (block.drops ?? []).map((d) => {
    const id = typeof d === "number" ? d : typeof d.drop === "number" ? d.drop : d.drop.id;
    return reg.items[id]?.name ?? `item_${id}`;
  });
}

function mobsOf(reg: IndexedData, category: string) {
  return reg.entitiesArray.filter((e) => e.category === category && e.type !== "projectile" && e.type !== "other").sort((a, b) => (a.name < b.name ? -1 : 1));
}

function recipePages(reg: IndexedData, server: ServerData, tags: Set<string>, src: Sources): PageFile[] {
  const cooked = serverRecipes(server, tags);
  const names = new Set<string>(cooked.keys());
  for (const key of Object.keys(reg.recipes)) names.add(reg.items[Number(key)]!.name);
  const entries: Entry[] = [];
  for (const name of names) {
    const item = reg.itemsByName[name];
    const lines = [...(item ? craftingLines(reg, item.id) : []), ...(cooked.get(name) ?? [])];
    if (lines.length > 0) entries.push({ name, text: `## ${name}\n${lines.join("\n")}` });
  }
  return layout({
    prefix: "recipes",
    title: (first, last) => `Recipe ingredients for ${first} to ${last}`,
    tags: ["recipe", "recipes", "ingredients", "reference"],
    verifiedBy: `generated from minecraft-data ${src.mcData} (crafting) and the vanilla ${MC_VERSION} server data (furnaces, stonecutter, smithing)`,
    intro: `How to make each item, sorted by result. A line is one way to get the item. \`a|b\` means one of them; \`*_planks\` means any item with that ending; \`-\` is an empty slot; \`x3\` is a count. Mineflayer lists one recipe per wood or color variant, and these pages merge them. Furnace fuel is in \`mechanics/smelting\`; a tag such as \`#logs_that_burn\` is expanded in \`reference/item-tags\`.`,
    separator: "\n\n",
    entries,
  });
}

function blockPages(reg: IndexedData, src: Sources): PageFile[] {
  const entries = reg.blocksArray
    .filter((b) => b.name !== "air" && !b.name.endsWith("_air"))
    .map((b) => {
      const drops = blockDrops(reg, b);
      return { name: b.name, text: `| ${b.name} | ${b.hardness ?? "-"} | ${toolFor(reg, b).text} | ${drops.length ? drops.join(", ") : "nothing"} |` };
    });
  return layout({
    prefix: "blocks",
    title: (first, last) => `Blocks ${first} to ${last}: hardness and drops`,
    tags: ["block", "blocks", "harvest", "hardness", "reference"],
    verifiedBy: `generated from minecraft-data ${src.mcData}`,
    intro: `Which tool each block needs and what it drops when you mine it, sorted by block name. Hardness sets the mining time; higher is slower. \`any pickaxe\` means a wooden pickaxe is enough. \`pickaxe, stone or better\` means the block drops nothing with a weaker pickaxe. A copper pickaxe counts as stone, and a golden one as wooden. A block that needs no tool drops by hand; the tool named there is only faster. Drops are the base drops: chances, fortune, and silk touch are not listed. See \`mechanics/tool-tiers\`.\n\n| Block | Hardness | Tool | Drops |\n| - | - | - | - |`,
    separator: "\n",
    entries,
  });
}

function dropPages(reg: IndexedData, server: ServerData, src: Sources): PageFile[] {
  const sources = new Map<string, { blocks: Set<string>; mobs: Set<string> }>();
  const of = (item: string) => {
    const s = sources.get(item) ?? { blocks: new Set<string>(), mobs: new Set<string>() };
    sources.set(item, s);
    return s;
  };
  for (const b of reg.blocksArray) {
    const tool = toolFor(reg, b);
    for (const item of blockDrops(reg, b)) {
      if (item !== b.name) of(item).blocks.add(tool.needed ? `${b.name} (${tool.text})` : b.name);
    }
  }
  for (const mob of [...mobsOf(reg, "Hostile mobs"), ...mobsOf(reg, "Passive mobs")]) {
    for (const pool of mobPools(server, mob.name)) {
      const shared = [...pool.notes, ...(pool.options.length > 1 ? [`one of ${pool.options.length} choices`] : []), ...(pool.rolls[0] === 1 && pool.rolls[1] === 1 ? [] : [`rolls ${pool.rolls[0] === pool.rolls[1] ? pool.rolls[0] : pool.rolls.join("-")}`])];
      for (const d of pool.options.flat()) of(d.item).mobs.add(`${mob.name} ${detail(d, shared)}`);
    }
  }
  const entries = [...sources].map(([item, s]) => {
    const lines = [`## ${item}`];
    if (s.blocks.size) lines.push(`- Blocks: ${[...s.blocks].sort().join(", ")}`);
    if (s.mobs.size) lines.push(`- Mobs: ${[...s.mobs].sort().join(", ")}`);
    return { name: item, text: lines.join("\n") };
  });
  return layout({
    prefix: "drops",
    title: (first, last) => `What drops each item: ${first} to ${last}`,
    tags: ["drops", "drop", "loot", "reference"],
    verifiedBy: `generated from minecraft-data ${src.mcData} (blocks) and the vanilla ${MC_VERSION} server data (mob loot)`,
    intro: `Which blocks and mobs drop each item, sorted by item. Blocks that drop only themselves are left out. A block shows its tool when a weaker tool drops nothing. A mob shows the count it drops, and what limits that. \`one of 3 choices\` means the mob rolls once and gets one of three drops, so each is rarer than the count alone suggests. For the tool of every block, see the \`reference/blocks-*\` pages.`,
    separator: "\n\n",
    entries,
  });
}

function mobPages(reg: IndexedData, server: ServerData, src: Sources): PageFile[] {
  return (["hostile", "passive"] as const).map((kind) => {
    const other = kind === "hostile" ? "passive" : "hostile";
    const entries = mobsOf(reg, kind === "hostile" ? "Hostile mobs" : "Passive mobs").map((m) => {
      const drops = mobPools(server, m.name);
      return `## ${m.name}\n- Size: ${Math.round((m.width ?? 0) * 100) / 100} wide, ${Math.round((m.height ?? 0) * 100) / 100} tall\n- Drops: ${dropsLine(drops)}`;
    });
    const body = `Mobs that minecraft-data classes as ${kind}, with their size and drops. The class is minecraft-data's; it does not say whether a mob attacks unprovoked. A drop line lists one clause per loot pool, separated by \`;\`. \`one of a, b\` means each roll gives one of them, chosen by weight; \`[...]\` is what limits the whole clause. The other class is in \`reference/mobs-${other}\`. To look up a drop, see the \`reference/drops-*\` pages.\n\n${entries.join("\n\n")}`;
    const extra = kind === "hostile" ? ["monster", "creeper", "zombie", "skeleton"] : ["animal", "cow", "pig", "sheep", "chicken"];
    return {
      id: `mobs-${kind}`,
      text: page(`${kind === "hostile" ? "Hostile" : "Passive"} mobs: size and drops`, ["mob", "mobs", kind, "entity", "size", "reference", ...extra], `generated from minecraft-data ${src.mcData} (mob list) and the vanilla ${MC_VERSION} server data (drops)`, body),
    };
  });
}

function foodPage(reg: IndexedData, src: Sources): PageFile {
  const rows = [...reg.foodsArray]
    .sort((a, b) => b.effectiveQuality - a.effectiveQuality || (a.name < b.name ? -1 : 1))
    .map((f) => `| ${f.name} | ${f.foodPoints} | ${f.saturation} |`);
  const body = `Every food item, best first. Food points are what \`bot.food\` gains: 2 points fill one drumstick. Saturation is the hidden buffer that delays hunger. The list is sorted by food points plus saturation. Some foods add effects (golden apples, suspicious stew, rotten flesh, raw chicken); the data does not list them. See \`mechanics/food-sources\` for where to get them.\n\n| Food | Food points | Saturation |\n| - | - | - |\n${rows.join("\n")}`;
  return {
    id: "foods",
    text: page("Food points and saturation of every food", ["food", "foods", "saturation", "reference"], `generated from minecraft-data ${src.mcData}`, body),
  };
}

function enchantmentPage(reg: IndexedData, src: Sources): PageFile {
  const rows = [...reg.enchantmentsArray]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => {
      const flags = [e.curse ? "curse" : "", e.treasureOnly ? "treasure" : "", e.tradeable ? "" : "not tradeable", e.discoverable ? "" : "not in the enchanting table"].filter(Boolean).join(", ");
      return `| ${e.name} | ${e.maxLevel} | ${e.category} | ${e.exclude.length ? e.exclude.join(", ") : "-"} | ${flags || "-"} |`;
    });
  const body = `Every enchantment with its top level, the gear it goes on, and the enchantments it cannot share an item with. A \`treasure\` enchantment never shows in the enchanting table. See \`mechanics/enchanting-basics\`.\n\n| Enchantment | Max level | Goes on | Excludes | Notes |\n| - | - | - | - | - |\n${rows.join("\n")}`;
  return {
    id: "enchantments",
    text: page("Enchantments: max level, gear, and conflicts", ["enchantment", "enchantments", "sharpness", "protection", "mending", "unbreaking", "reference"], `generated from minecraft-data ${src.mcData}`, body),
  };
}

function tagPage(server: ServerData, tags: Set<string>): PageFile {
  const entries = [...tags].sort().map((tag) => `## ${tag}\n${tagMembers(server, tag).sort().join(", ")}`);
  const body = `Item tags that recipes name with a \`#\`. A recipe that takes a tag accepts any item in it.\n\n${entries.join("\n\n")}`;
  return {
    id: "item-tags",
    text: page("Item tags: logs, planks, and the other groups that recipes accept", ["tag", "tags", "logs", "planks", "reference"], `generated from the vanilla ${MC_VERSION} server data`, body),
  };
}

/** The pages that need minecraft-data only, so a test can regenerate them without Java. */
export function dataPages(reg: IndexedData, src: Sources): PageFile[] {
  return [...blockPages(reg, src), foodPage(reg, src), enchantmentPage(reg, src)];
}

/** Builds every reference page. `server` supplies what minecraft-data lacks. */
export function build(reg: IndexedData, server: ServerData, src: Sources): PageFile[] {
  const tags = new Set<string>();
  const recipes = recipePages(reg, server, tags, src);
  return [...recipes, ...dropPages(reg, server, src), ...mobPages(reg, server, src), ...dataPages(reg, src), tagPage(server, tags)];
}

/** The registry minecraft-data has for MC_VERSION, and the version of the package. */
export function loadMinecraftData(): { reg: IndexedData; version: string } {
  const reg = (require("minecraft-data") as (version: string) => IndexedData)(MC_VERSION);
  const { version } = require("minecraft-data/package.json") as { version: string };
  return { reg, version };
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      "server-jar": { type: "string", default: path.resolve(import.meta.dirname, `../.dev-server/server-${MC_VERSION}.jar`) },
      out: { type: "string", default: path.resolve(import.meta.dirname, "../wiki/reference") },
    },
  });
  const { reg, version: mcData } = loadMinecraftData();
  const scratch = mkdtempSync(path.join(tmpdir(), "minebot-reference-"));
  try {
    const files = build(reg, generateServerData(args["server-jar"], scratch), { mcData });
    await mkdir(args.out, { recursive: true });
    for (const name of await readdir(args.out)) if (name.endsWith(".md")) await rm(path.join(args.out, name));
    for (const file of files) await writeFile(path.join(args.out, `${file.id}.md`), file.text);
    console.log(`wrote ${files.length} pages to ${args.out}; longest ${Math.max(...files.map((f) => f.text.split("\n").length))} lines`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
