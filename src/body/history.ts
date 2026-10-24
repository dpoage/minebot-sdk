// The program history: one JSON line per started run, written when the run ends, and one line per
// registered reflex `when` expression. People and agents read it; nothing in the benchmark grades from it.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunRecord, RunResult } from "../protocol/index.ts";

export interface HistoryOptions {
  file?: string;
}

/** A run's start as the history has it: its seq, its line, and the write of its end. */
export interface RunStart {
  /** The run's seq: what its `program_finished` event carries and `get_run` takes, with or without a file to write the line to. */
  seq: number;
  startedAt: string;
  /**
   * The run's record — its history line without the code — for the end it got: what `get_run`
   * serves. Pure: the record stands even when the line cannot be written.
   */
  record: (end: RunResult) => RunRecord;
  /** Writes the run's line, with the run's result as the history produced it; throws when the file cannot take it. */
  end: (end: RunResult) => Promise<void>;
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
   * Records the start of one program run and returns what records its end: the line is written when the
   * run ends, with the run's result. A run that never produces a result leaves no line. `extra` adds
   * fields to the line, such as the reflex that ran it. The seq is taken at the call, with or without
   * a file to write it to, so a run is numbered and kept for `get_run` on a body started without `--history`.
   */
  async begin(code: string, extra: object = {}): Promise<RunStart> {
    const file = this.#options.file;
    const base = { seq: ++this.#seq, startedAt: new Date().toISOString(), code, ...extra };
    const line = (end: RunResult) => ({ ...base, ...end });
    return {
      seq: base.seq,
      startedAt: base.startedAt,
      record: (end) => {
        const { code: _, ...record } = line(end);
        return record;
      },
      end: async (end) => {
        if (file) await appendFile(file, `${JSON.stringify(line(end))}\n`);
      },
    };
  }

  /**
   * Records code that the body will run later: a reflex's `when` expression. The line has status
   * `registered` and the `extra` fields that name it. The seq is taken at the call, with or without a file.
   */
  async register(code: string, extra: object): Promise<void> {
    const seq = ++this.#seq;
    if (!this.#options.file) return;
    const line = { seq, startedAt: new Date().toISOString(), code, ...extra, status: "registered" };
    await appendFile(this.#options.file, `${JSON.stringify(line)}\n`);
  }
}
