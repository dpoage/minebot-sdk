// Wiki pages: the file format, the visibility rules, and the search index fields.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MC_VERSION } from "../mc/version.ts";
import { PageMeta, type PageStatus, WikiFeature, type WikiPage } from "../protocol/index.ts";
import type { WikiView } from "./access.ts";

export type { WikiView };

function statusOf(meta: PageMeta, lesson: boolean): PageStatus {
  if (lesson) return "lesson";
  if (!meta.mc_version) return "unverified";
  return meta.mc_version === MC_VERSION ? "verified" : "stale";
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parsePage(id: string, text: string, lesson: boolean): WikiPage {
  const match = FRONT_MATTER.exec(text);
  if (!match) throw new Error(`wiki page ${id}: missing --- frontmatter`);
  const parsed = PageMeta.safeParse(parseYaml(match[1]!));
  if (!parsed.success) throw new Error(`wiki page ${id}: ${z.prettifyError(parsed.error)}`);
  return { id, meta: parsed.data, status: statusOf(parsed.data, lesson), body: match[2]!.trim() };
}

/**
 * Feature-cut blocks, derived from the feature enum so a new gate needs no second edit. A `builtins` block may name the
 * built-in modules it needs, `<!-- builtins:gatherer -->` or `<!-- builtins:dig,move -->`; its closing marker repeats them.
 */
const CUT_BLOCK = new RegExp(`<!-- (${WikiFeature.options.join("|")}|builtins:[a-z]+(?:,[a-z]+)*) -->\\n?([\\s\\S]*?)<!-- /\\1 -->\\n?`, "g");

/** Whether a body with `view` sees a block marked `gate` (`builtins`, or `builtins:<module>,...`): the feature is on, and every module the gate names is offered. */
function shows(gate: string, view: WikiView): boolean {
  const [feature, modules] = gate.split(":") as [WikiFeature, string | undefined];
  if (!view[feature]) return false;
  return modules === undefined || view.modules === undefined || modules.split(",").every((module) => view.modules!.includes(module));
}

/** The page as a body with `view` sees it, or null when the page needs a feature the body lacks. */
export function visible(page: WikiPage, view: WikiView): WikiPage | null {
  if (page.meta.requires.some((feature) => !view[feature])) return null;
  const body = page.body
    .replace(CUT_BLOCK, (_, gate: string, inner: string) => (shows(gate, view) ? inner : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ...page, body };
}

/**
 * The text of the page file `text` as a body with `view` sees it: the page's own front matter, then the body that `visible` leaves.
 * Null when the page needs a feature the body lacks. Reading the result under the same view gives the page that `visible` gives.
 */
export function pageFileFor(id: string, text: string, view: WikiView): string | null {
  const page = visible(parsePage(id, text, false), view);
  return page && `---\n${FRONT_MATTER.exec(text)![1]}\n---\n\n${page.body}\n`;
}

/** Lowercase word tokens; `oak_log` also yields `oak` and `log`. */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return words.flatMap((w) => (w.includes("_") ? [w, ...w.split("_").filter(Boolean)] : [w]));
}

/** Reads every page under `dir`; none when the directory does not exist. */
export function readPages(dir: string, prefix: string, lesson: boolean): WikiPage[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const pages: WikiPage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, file).slice(0, -".md".length).split(path.sep).join("/");
    pages.push(parsePage(prefix ? `${prefix}/${rel}` : rel, readFileSync(file, "utf8"), lesson));
  }
  return pages;
}
