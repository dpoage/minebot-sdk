// Notes: the agent's own persistent notepad on the body. Notes survive context compaction,
// body restarts, and a change of harness, so a long-running agent can keep its plan and findings here.
import { z } from "zod";
import { MAX_NOTES, NoteKey, NoteText, type Note } from "./protocol/index.ts";
import type { JsonStore } from "./store.ts";

export { MAX_NOTES, MAX_NOTE_LENGTH, NoteKey, NoteText } from "./protocol/index.ts";

export class NoteLimitError extends Error {}

const Stored = z.object({ text: z.string(), updated: z.string() });

export class Notes {
  readonly #store: JsonStore;

  constructor(store: JsonStore) {
    this.#store = store;
  }

  /** All notes, most recently changed first. */
  list(): Note[] {
    return this.#store
      .keys()
      .flatMap((key) => {
        const parsed = Stored.safeParse(this.#store.get(key));
        return parsed.success ? [{ key, ...parsed.data }] : [];
      })
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  get(key: string): Note | undefined {
    const parsed = Stored.safeParse(this.#store.get(NoteKey.parse(key)));
    return parsed.success ? { key, ...parsed.data } : undefined;
  }

  set(key: string, text: string): Note {
    NoteKey.parse(key);
    NoteText.parse(text);
    if (this.#store.get(key) === undefined && this.#store.keys().length >= MAX_NOTES) {
      throw new NoteLimitError(`a body keeps at most ${MAX_NOTES} notes; delete or merge some first`);
    }
    const note = { text, updated: new Date().toISOString() };
    this.#store.set(key, note);
    return { key, ...note };
  }

  delete(key: string): boolean {
    return this.#store.delete(NoteKey.parse(key));
  }
}
