// Ranking the kits a body offers against a query: kit names and descriptions, action names and
// docs, scored by the same weighted, rarity-scaled matching the wiki uses (src/rank.ts).
import { countTokens, rankFields } from "../rank.ts";
import type { Kit } from "./kit.ts";

/** One searchable unit: a kit as a whole, or one of its actions. */
export interface KitDocument {
  kit: string;
  action?: string;
  /** What a hit shows: the kit's description, or the first line of the action's doc. */
  text: string;
  fields: { weight: number; text: string }[];
}

export interface RankedDocument {
  document: KitDocument;
  score: number;
}

/**
 * Lowercase word tokens. `collectDrops` yields `collect` and `drops`, `*_log` yields `log`, and a
 * plural loses its `s`, so "logs" finds "log".
 */
export function terms(text: string): string[] {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

const MAX_TEXT_LENGTH = 200;

/** What a hit shows of a doc: its first line, cut to a length that reads in a list. */
function summary(text: string): string {
  const line = text.split("\n")[0]!;
  return line.length > MAX_TEXT_LENGTH ? `${line.slice(0, MAX_TEXT_LENGTH - 3)}...` : line;
}

/** The documents of the kits: one per kit, one per action. An action also carries its kit's description, so a query about the kit's purpose finds its actions. */
export function documentsOf(kits: readonly Kit[]): KitDocument[] {
  return kits.flatMap((kit) => [
    {
      kit: kit.name,
      text: summary(kit.description),
      fields: [
        { weight: 4, text: kit.name },
        { weight: 3, text: kit.description },
        { weight: 1, text: Object.keys(kit.actions).join(" ") },
      ],
    },
    ...Object.entries(kit.actions).map(([name, action]) => ({
      kit: kit.name,
      action: name,
      text: summary(action.doc),
      fields: [
        { weight: 4, text: name },
        { weight: 2, text: action.doc },
        { weight: 1, text: `${kit.name} ${kit.description} ${Object.keys(action.args.shape).join(" ")}` },
      ],
    })),
  ]);
}

/** Documents that match the query, best first. A term counts by where it occurs and how few documents have it. */
export function rank(documents: readonly KitDocument[], query: string): RankedDocument[] {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];
  const counted = documents.map((document) => ({
    document,
    fields: document.fields.map((field) => ({ weight: field.weight, counts: countTokens(terms(field.text)) })),
  }));
  return rankFields(counted, queryTerms).map(({ document, score }) => ({ document: document.document, score }));
}
