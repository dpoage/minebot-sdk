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

export function parsePage(id: string, text: string, lesson: boolean): WikiPage {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`wiki page ${id}: missing --- frontmatter`);
  const parsed = PageMeta.safeParse(parseYaml(match[1]!));
  if (!parsed.success) throw new Error(`wiki page ${id}: ${z.prettifyError(parsed.error)}`);
  return { id, meta: parsed.data, status: statusOf(parsed.data, lesson), body: match[2]!.trim() };
}

/** Feature-cut blocks, derived from the feature enum so a new gate needs no second edit. */
const CUT_BLOCK = new RegExp(`<!-- (${WikiFeature.options.join("|")}) -->\\n?([\\s\\S]*?)<!-- /\\1 -->\\n?`, "g");

/** The page as a body with `view` sees it, or null when the page needs a feature the body lacks. */
export function visible(page: WikiPage, view: WikiView): WikiPage | null {
  if (page.meta.requires.some((feature) => !view[feature])) return null;
  const body = page.body
    .replace(CUT_BLOCK, (_, feature: WikiFeature, inner: string) => (view[feature] ? inner : ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ...page, body };
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
