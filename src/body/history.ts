// The program history: one JSON line per started run, written when the run ends, and one line per
// registered reflex `when` expression. People and agents read it; nothing in the benchmark grades from it.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

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
   * Records the start of one program run and returns what records its end: the line is written when the
   * run ends, with the run's result. A run that never produces a result leaves no line.
   * `extra` adds fields to the line, such as the reflex that ran it. The seq is taken at the call.
   */
  async begin(code: string, extra: object = {}): Promise<RunEnd> {
    const file = this.#options.file;
    if (!file) return async () => {};

    const base = { seq: ++this.#seq, startedAt: new Date().toISOString(), code, ...extra };
    return (result) => appendFile(file, `${JSON.stringify({ ...base, ...result })}\n`);
  }

  /**
   * Records code that the body will run later: a reflex's `when` expression. The line has status
   * `registered` and the `extra` fields that name it.
   */
  async register(code: string, extra: object): Promise<void> {
    if (!this.#options.file) return;
    const line = { seq: ++this.#seq, startedAt: new Date().toISOString(), code, ...extra, status: "registered" };
    await appendFile(this.#options.file, `${JSON.stringify(line)}\n`);
  }
}
