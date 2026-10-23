// A body's view of the wiki: the access mode, the feature-derived page view, and lesson naming.
// WikiFeature is the enum the page format and the cut-block markers share; adding a gate means
// adding it here and nothing else.
import { capabilities, type BodyFeatures, WikiFeature } from "../protocol/index.ts";
import type { LessonInput, PageSummary, SearchHit, WikiMode, WikiPage } from "../protocol/index.ts";
import { WikiDisabledError, Wiki, formatPage } from "./wiki.ts";


/**
 * What a body sees of the wiki. A body without built-in routines must not read about them, so pages that
 * need a missing feature are hidden, and blocks marked `<!-- builtins -->...<!-- /builtins -->`
 * (or `milestones`, `reflexes`, `routines`) are cut from the pages that stay. A body that offers only some
 * built-in modules does not see the blocks of the others: `<!-- builtins:<module> -->...<!-- /builtins:<module> -->`.
 */
export type WikiView = Record<WikiFeature, boolean> & {
  /**
   * The built-in modules the body offers. A `<!-- builtins:<module> -->` block shows only when the feature is on and every module it
   * names is in this list. Absent: every module is offered.
   */
  modules?: readonly string[];
};

/** The view that shows every page whole. */
export const FULL_VIEW: WikiView = { builtins: true, milestones: true, reflexes: true, routines: true };

/** Derives the wiki view from the body's features: the capability table is the only source. */
export function wikiView(features: BodyFeatures): WikiView {
  const caps = capabilities(features);
  return { builtins: caps.builtins, milestones: caps.milestones, reflexes: caps.reflexes, routines: caps.routines, modules: features.builtins };
}

/** A body's view of the wiki: enforces the access mode, hides content for features the body lacks, and names lessons after the body. */
export class WikiAccess {
  readonly mode: WikiMode;
  readonly #wiki: Wiki | null;
  readonly #author: string;
  readonly #view: () => WikiView;

  /** `view` is read on every call, because the body's features can change while it runs. */
  constructor(wiki: Wiki | null, mode: WikiMode, author: string, view: () => WikiView = () => FULL_VIEW) {
    this.#wiki = wiki;
    this.mode = mode;
    this.#author = author;
    this.#view = view;
  }

  #require(write = false): Wiki {
    if (this.mode === "off" || !this.#wiki) throw new WikiDisabledError("the wiki is off on this body");
    if (write && this.mode !== "write") throw new WikiDisabledError("the wiki is read-only on this body");
    return this.#wiki;
  }

  /** Whether lessons are part of this wiki: the body can write them, or some exist. */
  get lessons(): boolean {
    return this.mode === "write" || (this.mode === "read" && (this.#wiki?.lessonCount ?? 0) > 0);
  }

  search(query: string, limit?: number): SearchHit[] {
    return this.#require().search(query, limit, this.#view());
  }

  read(id: string): WikiPage {
    return this.#require().read(id, this.#view());
  }

  list(section?: string): PageSummary[] {
    return this.#require().list(section, this.#view());
  }

  async addLesson(input: LessonInput): Promise<PageSummary> {
    return this.#require(true).addLesson(input, this.#author);
  }

  /** A page and its agent-facing rendering. */
  readFormatted(id: string): { page: WikiPage; text: string } {
    const page = this.read(id);
    return { page, text: formatPage(page) };
  }
}

export { formatPage };
