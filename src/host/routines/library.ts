// The routine library: a flat directory of modules, `<dir>/<name>.ts`, with every saved version kept
// under `<dir>/.history/<name>/<n>.ts` beside `<n>.json`. Several bodies may share the directory.
// Nothing here imports or evaluates a module: a routine runs only when something calls it.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RoutineName, RoutineSource, type RoutineInfo, type RoutineVersion } from "../../protocol/index.ts";

/** Where earlier versions are kept, inside the library directory: `.history/<routine>/<n>.ts` beside `<n>.json`. */
const HISTORY_DIR = ".history";

/** A request the library refuses: a name that is not a routine name, a source over the limit, or a version that was never saved. */
export class RoutineSourceError extends Error {}

export interface RoutineLibraryOptions {
  /** The library directory, shared by every body pointed at it. It is created by the first save. */
  dir: string;
  /** The name recorded as the author of each saved version; the daemon passes the body's name. */
  savedBy: string;
}

type VersionMeta = Omit<RoutineVersion, "current">;

/** One version as the log keeps it. */
interface Entry {
  meta: VersionMeta;
  source: string;
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && codes.includes(err.code);
}

/** The routine a library directory entry `fileName` is named for: `<name>.ts` with a valid routine name; undefined for any other entry. */
export function moduleName(fileName: string): string | undefined {
  const name = fileName.endsWith(".ts") ? fileName.slice(0, -".ts".length) : undefined;
  return name !== undefined && RoutineName.safeParse(name).success ? name : undefined;
}

/**
 * The text of library module file `file`, or undefined when there is no module there: the file is
 * absent or is not a regular file (a symlink, or a directory named `<name>.ts`). The loader reads
 * modules through this too, so both agree on what a module is.
 */
export function readModule(file: string): string | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined;
    return readFileSync(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT", "EISDIR", "ENOTDIR")) return undefined;
    throw err;
  }
}

/** Writes `text` to `file` so a reader sees either the old file or the whole new one. */
function replaceFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was never created, or is gone.
    }
    throw err;
  }
}

export class RoutineLibrary {
  readonly dir: string;
  readonly #savedBy: string;

  constructor(options: RoutineLibraryOptions) {
    this.dir = options.dir;
    this.#savedBy = options.savedBy;
  }

  /** The routines in the library by name: every flat regular file `<name>.ts`, each with the version whose source is the file's. */
  list(): RoutineInfo[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch (err) {
      if (isErrno(err, "ENOENT", "ENOTDIR")) return [];
      throw err;
    }
    const routines: RoutineInfo[] = [];
    for (const file of files.sort()) {
      const name = moduleName(file);
      if (name === undefined) continue;
      const current = readModule(path.join(this.dir, file));
      if (current === undefined) continue;
      const entry = this.#currentEntry(name, current);
      routines.push({ name, ...(entry && { version: entry.meta.version, savedAt: entry.meta.savedAt }) });
    }
    return routines;
  }

  /** The source of a routine, or undefined when there is no such routine. */
  source(name: string): string | undefined {
    if (!RoutineName.safeParse(name).success) return undefined;
    return readModule(this.#file(name));
  }

  /**
   * Writes a routine's source to the library and records it as a new version, unless it is the
   * version saved last. Only a bad name or a source over the limit is refused, and then nothing is
   * written. The source is not type-checked here and never evaluated.
   */
  async save(name: string, source: string): Promise<RoutineInfo> {
    return this.#store(name, source, undefined);
  }

  /** Saves `source` as the next version (with the version it restores, for a revert) and as the file. */
  #store(name: string, source: string, revertedFrom: number | undefined): RoutineInfo {
    this.#validate(name, source);
    mkdirSync(this.dir, { recursive: true });
    const file = this.#file(name);
    // The file is read before the history: a writer renames the file only after its version is
    // visible, so a file this read finds is never newer than the history read next.
    const current = readModule(file);
    let latest = this.#latest(name);
    if (current !== undefined && latest?.source !== current && this.#currentEntry(name, current) === undefined) {
      // Source no save wrote (edited by hand) is about to be replaced: keep it as a version of its own.
      latest = this.#writeVersion(name, current, { savedAt: statSync(file).mtime.toISOString(), savedBy: "unknown" });
    }
    if (latest?.source !== source) {
      latest = this.#writeVersion(name, source, { savedAt: new Date().toISOString(), savedBy: this.#savedBy, ...(revertedFrom !== undefined && { revertedFrom }) });
    }
    replaceFile(file, source);
    return { name, version: latest.meta.version, savedAt: latest.meta.savedAt };
  }

  /** The saved versions of a routine, oldest first. Empty when nothing was saved under the name. */
  async versions(name: string): Promise<RoutineVersion[]> {
    this.#validateName(name);
    const current = readModule(this.#file(name));
    const history = this.#entries(name);
    const currentVersion = current === undefined ? undefined : history.findLast((entry) => entry.source === current)?.meta.version;
    return history.map(({ meta }) => ({ ...meta, current: meta.version === currentVersion }));
  }

  /**
   * Saves an earlier version of a routine again, as a new version. The history only grows, so a
   * revert can itself be reverted; reverting to the source the routine has changes nothing.
   */
  async revert(name: string, version: number): Promise<RoutineInfo> {
    this.#validateName(name);
    const history = this.#entries(name);
    const entry = history.find((candidate) => candidate.meta.version === version);
    if (!entry) {
      const known = history.map((candidate) => candidate.meta.version).join(", ");
      throw new RoutineSourceError(`routine "${name}" has no version ${version}${known ? `; saved versions: ${known}` : ""}`);
    }
    return this.#store(name, entry.source, version);
  }

  #file(name: string): string {
    return path.join(this.dir, `${name}.ts`);
  }

  #validateName(name: string): void {
    const parsed = RoutineName.safeParse(name);
    if (!parsed.success) throw new RoutineSourceError(`"${name}" is not a routine name: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  #validate(name: string, source: string): void {
    this.#validateName(name);
    const parsed = RoutineSource.safeParse(source);
    if (!parsed.success) throw new RoutineSourceError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  /** The directory holding the saved versions of one routine. Only called with a valid name, so it cannot leave the history directory. */
  #historyDir(name: string): string {
    return path.join(this.dir, HISTORY_DIR, name);
  }

  /** The numbers of the version files of a routine, whether or not their files are complete yet, ascending. */
  #numbers(name: string): number[] {
    let files: string[];
    try {
      files = readdirSync(this.#historyDir(name));
    } catch (err) {
      if (isErrno(err, "ENOENT", "ENOTDIR")) return [];
      throw err;
    }
    return files
      .filter((file) => /^\d+\.json$/.test(file))
      .map((file) => Number.parseInt(file, 10))
      .sort((a, b) => a - b);
  }

  /** One version with its source, or undefined while its files are not complete (a save by another body may still be writing them) or when they are unreadable. */
  #entry(name: string, version: number): Entry | undefined {
    const dir = this.#historyDir(name);
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, `${version}.json`), "utf8")) as Partial<VersionMeta> | null;
      if (!meta || meta.version !== version || typeof meta.savedAt !== "string" || typeof meta.savedBy !== "string") return undefined;
      return { meta: meta as VersionMeta, source: readFileSync(path.join(dir, `${version}.ts`), "utf8") };
    } catch {
      return undefined;
    }
  }

  /** Every readable version of a routine, oldest first. */
  #entries(name: string): Entry[] {
    return this.#numbers(name).flatMap((version) => this.#entry(name, version) ?? []);
  }

  /** The newest readable version. */
  #latest(name: string): Entry | undefined {
    const numbers = this.#numbers(name);
    for (let i = numbers.length - 1; i >= 0; i--) {
      const entry = this.#entry(name, numbers[i]!);
      if (entry) return entry;
    }
    return undefined;
  }

  /** The newest version whose source is `source`: the version a file holding it is. */
  #currentEntry(name: string, source: string): Entry | undefined {
    const numbers = this.#numbers(name);
    for (let i = numbers.length - 1; i >= 0; i--) {
      const entry = this.#entry(name, numbers[i]!);
      if (entry?.source === source) return entry;
    }
    return undefined;
  }

  /**
   * Writes the next version. Bodies can share the directory: the metadata file is created
   * exclusively, so a number another body took moves this save to the next one. The source lands
   * by rename after it, so a version is visible only once whole.
   */
  #writeVersion(name: string, source: string, meta: Omit<VersionMeta, "version">): Entry {
    const dir = this.#historyDir(name);
    mkdirSync(dir, { recursive: true });
    for (let version = (this.#numbers(name).at(-1) ?? 0) + 1; ; version++) {
      const full: VersionMeta = { version, ...meta };
      try {
        writeFileSync(path.join(dir, `${version}.json`), `${JSON.stringify(full, null, 2)}\n`, { flag: "wx" });
      } catch (err) {
        if (isErrno(err, "EEXIST")) continue;
        throw err;
      }
      replaceFile(path.join(dir, `${version}.ts`), source);
      return { meta: full, source };
    }
  }
}
