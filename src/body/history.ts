// The program history: one JSON line per run, with the escape audit recorded where the history
// is written. A flagged program is written before it runs, so a program that kills the body is
// still recorded; the benchmark verifier reads these lines and fails a flagged trial.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { findEscapeAttempts } from "../audit.ts";

export interface HistoryOptions {
  file?: string;
  /** What the body was running when each program ran. */
  activeKits: () => string[];
}

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
   * Records one program run. The audit keeps its flags in the history (the verifier fails a
   * flagged trial); the agent is not told mid-run, so the run result is exactly what the
   * program produced. `extra` adds fields to the line, such as the trigger that ran it.
   */
  async record(code: string, run: () => Promise<object>, extra: object = {}): Promise<object> {
    if (!this.#options.file) return run();

    const startedAt = new Date().toISOString();
    const escapeAttempts = findEscapeAttempts(code);
    const base = { seq: ++this.#seq, startedAt, kits: this.#options.activeKits(), code, escapeAttempts, ...extra };
    // A program that escapes can kill the body before its result is written, so the flag is recorded first.
    if (escapeAttempts.length > 0) {
      await appendFile(this.#options.file, `${JSON.stringify({ ...base, status: "started" })}\n`);
    }
    const result = await run();
    await appendFile(this.#options.file, `${JSON.stringify({ ...base, ...result })}\n`);
    return result;
  }

  /**
   * Records code that the body will run later, with the audit over all of it: a trigger's program
   * and its `when` expression. The line has status `registered` and the `extra` fields that name it.
   */
  async register(code: string, extra: object): Promise<void> {
    if (!this.#options.file) return;
    const line = { seq: ++this.#seq, startedAt: new Date().toISOString(), kits: this.#options.activeKits(), code, escapeAttempts: findEscapeAttempts(code), ...extra, status: "registered" };
    await appendFile(this.#options.file, `${JSON.stringify(line)}\n`);
  }
}
