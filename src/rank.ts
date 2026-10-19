// Ranking documents against query terms: one scorer for the wiki and for kit search. Each
// document has weighted fields; a term scores by how often it occurs in a field (with
// diminishing returns), the field's weight, and how few documents contain it. Each caller keeps
// its own tokenizer and passes the tokens in.

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

/** The documents that match at least one of `terms`, best first, with their scores. */
export function rankFields<T extends { fields: RankField[] }>(documents: readonly T[], terms: readonly string[]): { document: T; score: number }[] {
  const idf = new Map(
    terms.map((term) => {
      const having = documents.filter((document) => document.fields.some((field) => field.counts.has(term))).length;
      return [term, Math.log(1 + documents.length / (1 + having))] as const;
    }),
  );
  return documents
    .map((document) => {
      let score = 0;
      for (const term of terms) {
        for (const field of document.fields) {
          const tf = field.counts.get(term) ?? 0;
          if (tf > 0) score += idf.get(term)! * field.weight * (tf / (tf + 1));
        }
      }
      return { document, score };
    })
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score);
}
