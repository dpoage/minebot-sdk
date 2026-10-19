// The wiki: curated pages plus agents' lessons, with one search index per view. The access
// policy (who may call what, and which features shape the view) lives in access.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { LessonInput, type LessonInput as LessonInputType, type PageMeta, type PageSummary, type SearchHit, type WikiPage } from "../protocol/index.ts";
import { countTokens, rankFields, type RankField } from "../rank.ts";
import { readPages, tokens, visible, type WikiView } from "./page.ts";

/** Default location of the curated pages. */
export const WIKI_DIR = path.resolve(import.meta.dirname, "../../wiki");

const LESSONS = "lessons";
const FULL_VIEW: WikiView = { kits: true, milestones: true, agentKits: true, triggers: true };

export class WikiPageNotFoundError extends Error {}
export class WikiDisabledError extends Error {}

interface Indexed {
  page: WikiPage;
  fields: RankField[];
}

function count(text: string): Map<string, number> {
  return countTokens(tokens(text));
}

function index(page: WikiPage): Indexed {
  const headings = page.body
    .split("\n")
    .filter((l) => l.startsWith("#"))
    .join(" ");
  return {
    page,
    fields: [
      { weight: 4, counts: count(`${page.meta.title} ${page.id}`) },
      { weight: 3, counts: count(page.meta.tags.join(" ")) },
      { weight: 2, counts: count(headings) },
      { weight: 1, counts: count(page.body) },
    ],
  };
}

function summary(page: WikiPage): PageSummary {
  return { id: page.id, title: page.meta.title, tags: page.meta.tags, status: page.status };
}

/** The line of the page that matches the most query terms (the first one on a tie), or its first line when none matches. */
function snippet(page: WikiPage, terms: string[]): string {
  const lines = page.body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let best = lines[0] ?? "";
  let bestScore = 0;
  for (const l of lines) {
    const words = new Set(tokens(l));
    const score = terms.filter((t) => words.has(t)).length;
    if (score > bestScore) {
      best = l;
      bestScore = score;
    }
  }
  return best.length > 160 ? `${best.slice(0, 157)}...` : best;
}

const viewKey = (view: WikiView) => Object.entries(view).map(([feature, on]) => `${feature}=${on}`).join(",");

export class Wiki {
  readonly root: string;
  readonly lessonsDir: string | undefined;
  readonly #curated: WikiPage[];
  #lessons: WikiPage[] = [];
  /** Modification time of the lessons directory when the lessons were read; other bodies add lessons to it too. */
  #lessonsStamp = -1;
  /** Search indexes by view, rebuilt when the lessons change. */
  readonly #indexes = new Map<string, Indexed[]>();

  private constructor(root: string, lessonsDir: string | undefined) {
    this.root = root;
    this.lessonsDir = lessonsDir;
    this.#curated = readPages(root, "", false).filter((p) => !p.id.startsWith("checks/"));
  }

  /** Loads curated pages from `root` and lessons from `lessonsDir`. Throws on a malformed page. */
  static load(root = WIKI_DIR, lessonsDir?: string): Wiki {
    const wiki = new Wiki(root, lessonsDir);
    wiki.#refresh();
    return wiki;
  }

  /** Rereads the lessons when the directory changed, so lessons from other bodies show up. */
  #refresh(): void {
    if (!this.lessonsDir) return;
    let stamp: number;
    try {
      stamp = statSync(this.lessonsDir).mtimeMs;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      stamp = 0;
    }
    if (stamp === this.#lessonsStamp) return;
    this.#lessons = readPages(this.lessonsDir, LESSONS, true);
    this.#lessonsStamp = stamp;
    this.#indexes.clear();
  }

  /** Every page, whole, for tooling that is not an agent. */
  get pages(): WikiPage[] {
    this.#refresh();
    return [...this.#curated, ...this.#lessons];
  }

  /** How many lessons exist. */
  get lessonCount(): number {
    this.#refresh();
    return this.#lessons.length;
  }

  #indexed(view: WikiView): Indexed[] {
    this.#refresh();
    const key = viewKey(view);
    let indexed = this.#indexes.get(key);
    if (!indexed) {
      indexed = [...this.#curated, ...this.#lessons].flatMap((page) => {
        const shown = visible(page, view);
        return shown ? [index(shown)] : [];
      });
      this.#indexes.set(key, indexed);
    }
    return indexed;
  }

  list(section?: string, view: WikiView = FULL_VIEW): PageSummary[] {
    return this.#indexed(view)
      .map((i) => i.page)
      .filter((p) => !section || p.id.startsWith(`${section}/`))
      .map(summary)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  read(id: string, view: WikiView = FULL_VIEW): WikiPage {
    const clean = id.replace(/\.md$/, "").replace(/^\/+/, "");
    const page = this.#indexed(view).find((i) => i.page.id === clean)?.page;
    if (page) return page;
    const near = this.search(clean.replace(/[/-]/g, " "), 3, view).map((h) => h.id);
    throw new WikiPageNotFoundError(`no wiki page "${clean}"${near.length ? `; did you mean ${near.join(", ")}?` : ""}`);
  }

  /** Ranks pages by weighted term matches (title and tags count most), scaled by term rarity. */
  search(query: string, limit = 5, view: WikiView = FULL_VIEW): SearchHit[] {
    const terms = [...new Set(tokens(query))];
    if (terms.length === 0) return [];
    return rankFields(this.#indexed(view), terms)
      .slice(0, limit)
      .map(({ document: { page }, score }) => ({ ...summary(page), score: Math.round(score * 100) / 100, snippet: snippet(page, terms) }));
  }

  /**
   * Writes an unverified lesson and makes it searchable. Returns its summary.
   * The file name comes from the title. Bodies can share a lessons directory, so the file is created
   * exclusively and a taken name gets the next number; an existing lesson is never overwritten.
   */
  async addLesson(input: LessonInputType, author: string): Promise<PageSummary> {
    if (!this.lessonsDir) throw new WikiDisabledError("this wiki has no lessons directory");
    const lesson = LessonInput.parse(input);
    const base = lesson.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "lesson";
    const meta: Partial<PageMeta> = {
      title: lesson.title,
      tags: lesson.tags,
      verified_by: `unreviewed lesson from ${author}`,
      author,
      created: new Date().toISOString(),
    };
    const text = `---\n${stringifyYaml(meta)}---\n\n${lesson.body.trim()}\n`;
    await mkdir(this.lessonsDir, { recursive: true });
    for (let n = 1; ; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      try {
        await writeFile(path.join(this.lessonsDir, `${slug}.md`), text, { flag: "wx" });
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "EEXIST") continue;
        throw err;
      }
      this.#refresh();
      return summary(this.read(`${LESSONS}/${slug}`));
    }
  }
}

/** Renders a page for an agent: status line, then the markdown. */
export function formatPage(page: WikiPage): string {
  const verified = page.meta.mc_version ? `verified on ${page.meta.mc_version} by ${page.meta.verified_by}` : page.meta.verified_by;
  return `# ${page.meta.title}\n[${page.id} | ${page.status} | ${verified}]\n\n${page.body}`;
}
