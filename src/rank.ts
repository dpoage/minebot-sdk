// Ranking documents against query terms: one scorer for the wiki and for kit search. Each
// document has weighted fields; a term scores by how often it occurs in a field (with
// diminishing returns), the field's weight, and how few documents contain it. Each caller keeps
// its own tokenizer and passes the tokens in.
//
// Besides an exact match, a term matches a token fuzzily: by prefix either way (the term, 3+
// chars, a prefix of the token, or the token, 4+ chars, a prefix of the term), or by a typo:
// edit distance (insert/delete/substitute/adjacent swap) 1 when both words have 4+ chars, 2 when
// both have 7+. Exact matches score as if fuzzy matching did not exist. A fuzzy match of a term
// counts only in a document that lacks the term exactly, scaled by its similarity. Documents with
// no exact match at all rank below every document with one.

/** One field of a document: its weight, and how often each token occurs in it. */
export interface RankField {
  weight: number;
  counts: Map<string, number>;
}

/** Token counts of one field's text. */
export function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** Similarity of a fuzzy match, by kind; an exact match is scored apart from these. */
const PREFIX_SIMILARITY = 0.75;
const EDIT1_SIMILARITY = 0.6;
const EDIT2_SIMILARITY = 0.4;

/** Largest edit distance tolerated between two words, by the shorter one: none under 4 chars, 1 under 7, else 2. A typo budget by the query word alone lets "sand" match "and". */
function maxEdits(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  return shorter >= 7 ? 2 : shorter >= 4 ? 1 : 0;
}

/** Optimal-string-alignment distance, or `max + 1` as soon as it must exceed `max`. */
function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && cost === 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      row.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** How well `token` matches `term` fuzzily: prefix, then small typo, else 0. Exact matches are not fuzzy. */
function similarity(term: string, token: string): number {
  if (term === token) return 0;
  if ((term.length >= 3 && token.startsWith(term)) || (token.length >= 4 && term.startsWith(token))) return PREFIX_SIMILARITY;
  const max = maxEdits(term, token);
  if (max === 0) return 0;
  const distance = boundedDistance(term, token, max);
  return distance > max ? 0 : distance === 1 ? EDIT1_SIMILARITY : EDIT2_SIMILARITY;
}

/** Rarity weight of a term held by `having` of `total` documents. */
function idfOf(having: number, total: number): number {
  return Math.log(1 + total / (1 + having));
}

/** The documents that match at least one of `terms`, best first, with their scores. */
export function rankFields<T extends { fields: RankField[] }>(documents: readonly T[], terms: readonly string[]): { document: T; score: number }[] {
  const vocabulary = new Set<string>();
  for (const document of documents) for (const field of document.fields) for (const token of field.counts.keys()) vocabulary.add(token);
  // Per term: the exact idf, and the fuzzily matching tokens with their similarity and idf.
  const exactIdf = new Map<string, number>();
  const fuzzy = new Map<string, { matched: Map<string, number>; idf: number }>();
  for (const term of new Set(terms)) {
    exactIdf.set(term, idfOf(documents.filter((document) => document.fields.some((field) => field.counts.has(term))).length, documents.length));
    const matched = new Map<string, number>();
    for (const token of vocabulary) {
      const s = similarity(term, token);
      if (s > 0) matched.set(token, s);
    }
    const holds = (counts: Map<string, number>) => {
      if (counts.has(term)) return true;
      for (const token of matched.keys()) if (counts.has(token)) return true;
      return false;
    };
    const having = documents.filter((document) => document.fields.some((field) => holds(field.counts))).length;
    fuzzy.set(term, { matched, idf: idfOf(having, documents.length) });
  }
  const scored = documents.map((document) => {
    let exact = 0;
    let approximate = 0;
    for (const term of terms) {
      const idf = exactIdf.get(term)!;
      let held = false;
      for (const field of document.fields) {
        const tf = field.counts.get(term) ?? 0;
        if (tf > 0) {
          held = true;
          exact += idf * field.weight * (tf / (tf + 1));
        }
      }
      if (held) continue;
      const { matched, idf: fuzzyIdf } = fuzzy.get(term)!;
      for (const field of document.fields) {
        // Only the field's best kind of match counts, scaled by its similarity.
        let best = 0;
        let tf = 0;
        for (const [token, s] of matched) {
          const count = field.counts.get(token);
          if (count === undefined || s < best) continue;
          if (s > best) [best, tf] = [s, 0];
          tf += count;
        }
        if (tf > 0) approximate += fuzzyIdf * field.weight * best * (tf / (tf + 1));
      }
    }
    return { document, exact, approximate };
  });
  // Documents without an exact match rank below the lowest one with an exact match.
  const exactScores = scored.filter((entry) => entry.exact > 0).map((entry) => entry.exact + entry.approximate);
  const fuzzyOnly = scored.filter((entry) => entry.exact === 0 && entry.approximate > 0).map((entry) => entry.approximate);
  const floor = exactScores.length > 0 ? Math.min(...exactScores) : Infinity;
  const highest = fuzzyOnly.length > 0 ? Math.max(...fuzzyOnly) : 0;
  const scale = highest >= floor ? floor / highest / 2 : 1;
  return scored
    .map(({ document, exact, approximate }) => ({ document, score: exact > 0 ? exact + approximate : approximate * scale }))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score);
}
