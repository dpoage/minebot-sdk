// The program history: one JSON line per run, with the escape audit recorded where the history
// is written. A flagged program is written before it runs, so a program that kills the body is
// still recorded; the benchmark verifier reads these lines and fails a flagged trial.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { findEscapeAttempts } from "../audit.ts";

export interface HistoryOptions {
  file?: string;
}

/** What a run's end writes: the run's result, as the program produced it. */
export type RunEnd = (result: object) => Promise<void>;

export class ProgramHistory {
  readonly #options: HistoryOptions;
  #seq = 0;

  constructor(options: HistoryOptions) {
    this.#options = options;
  }

  /** Creates the file up front, so a history without programs is not mistaken for a lost one. */
  async start(): Promise<void> {
    if (!this.#options.file) return;
    await mkdir(path.dirname(this.#options.file), { recursive: true });
    await appendFile(this.#options.file, "");
  }

  /**
   * Records the start of one program run and returns what records its end. The audit keeps its
   * flags in the history (the verifier fails a flagged trial); the agent is not told mid-run, so
   * the result is what the program produced.
   * `extra` adds fields to the line, such as the reflex that ran it. The seq is taken at the
   * call, and a flagged program's line is on disk when it resolves.
   */
  async begin(code: string, extra: object = {}): Promise<RunEnd> {
    const file = this.#options.file;
    if (!file) return async () => {};

    const startedAt = new Date().toISOString();
    const escapeAttempts = findEscapeAttempts(code);
    const base = { seq: ++this.#seq, startedAt, code, escapeAttempts, ...extra };
    // A program that escapes can kill the body before its result is written, so the flag is recorded first.
    if (escapeAttempts.length > 0) {
      await appendFile(file, `${JSON.stringify({ ...base, status: "started" })}\n`);
    }
    return (result) => appendFile(file, `${JSON.stringify({ ...base, ...result })}\n`);
  }

  /**
   * Records code that the body will run later, with the audit over all of it: a reflex's `when`
   * expression. The line has status `registered` and the `extra` fields that name it.
   */
  async register(code: string, extra: object): Promise<void> {
    if (!this.#options.file) return;
    const line = { seq: ++this.#seq, startedAt: new Date().toISOString(), code, escapeAttempts: findEscapeAttempts(code), ...extra, status: "registered" };
    await appendFile(this.#options.file, `${JSON.stringify(line)}\n`);
  }
}
