// The notepad a routine sees as `ctx.notes`, in memory: same key and text rules and the same limit
// as the body's, nothing persisted.
import { MAX_NOTES, NoteKey, NoteText, type Note } from "../protocol/index.ts";
import type { RoutineContext } from "../routine/context.ts";

export function memoryNotes(): RoutineContext["notes"] {
  // Insertion order is change order: a set moves its key to the end, and `list` reads newest first.
  const notes = new Map<string, Note>();
  return {
    list: () => [...notes.values()].reverse().map((note) => ({ ...note })),
    get(key) {
      const note = notes.get(NoteKey.parse(key));
      return note?.text;
    },
    set(key, text) {
      NoteKey.parse(key);
      NoteText.parse(text);
      if (!notes.has(key) && notes.size >= MAX_NOTES) throw new Error(`a body keeps at most ${MAX_NOTES} notes; delete or merge some first`);
      notes.delete(key);
      const note = { key, text, updated: new Date().toISOString() };
      notes.set(key, note);
      return { ...note };
    },
    delete: (key) => notes.delete(NoteKey.parse(key)),
  };
}
