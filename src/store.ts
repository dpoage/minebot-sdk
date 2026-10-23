// A small JSON key-value file that survives body restarts. Bodies keep notes, milestones, and routine stores in these.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Keys and JSON values, saved to one file on every change. Writes go to a temp file first, then rename. */
export class JsonStore {
  readonly file: string;
  readonly #memory: boolean;
  #data: Record<string, unknown>;

  constructor(file: string, options: { memory?: boolean } = {}) {
    this.file = file;
    this.#memory = options.memory ?? false;
    if (this.#memory) {
      this.#data = {};
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
      this.#data = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") this.#data = {};
      else throw new Error(`cannot load ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A store that never touches the disk: for tests and for the `minebot-sdk/testing` harness, whose notes and `ctx.store` namespaces live in memory. */
  static memory(): JsonStore {
    return new JsonStore("", { memory: true });
  }

  get(key: string): unknown {
    return this.#data[key];
  }

  keys(): string[] {
    return Object.keys(this.#data);
  }

  /** Stores a JSON-serializable value. `undefined` deletes the key. */
  set(key: string, value: unknown): void {
    if (value === undefined) delete this.#data[key];
    else this.#data[key] = JSON.parse(JSON.stringify(value));
    this.#save();
  }

  delete(key: string): boolean {
    if (!(key in this.#data)) return false;
    delete this.#data[key];
    this.#save();
    return true;
  }

  #save(): void {
    if (this.#memory) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
