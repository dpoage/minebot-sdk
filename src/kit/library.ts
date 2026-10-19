// The kit library: the built-in kits plus the agent kits saved on this body. Several bodies
// may share the agent-kit directory; it is re-read when the directory changes, so a kit one
// body saves appears on the others without a restart. A file that fails to load is skipped
// and reported, and never stops the body.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findEscapeAttempts } from "../audit.ts";
import { KitName, type KitVersion } from "../protocol/index.ts";
import { compileKit, KitSourceError } from "./agent.ts";
import { BUILTIN_KIT_DIR, BUILTIN_KITS } from "./index.ts";
import type { Kit } from "./kit.ts";

/** Where earlier versions of agent kits are kept, inside the agent-kit directory: `.history/<kit>/<n>.ts` beside `<n>.json`. */
const HISTORY_DIR = ".history";

export interface KitLibraryOptions {
  /** Directory of agent kits, shared by every body pointed at it. Undefined disables agent kits. */
  dir?: string;
  /** Called for every file that fails to load; the daemon wires it to the body's event log. */
  onProblem?: (file: string, error: string) => void;
  /** The name recorded as the author of each saved version; the daemon passes the body's name. */
  savedBy?: string;
  /**
   * Called with the name of an agent kit whose source changed, appeared, or disappeared since the
   * library last read the directory, whichever body wrote it. The daemon resets the kit's call
   * statistics. Not called for the kits already there when the library is created.
   */
  onChange?: (kit: string) => void;
}

export class KitLibrary {
  readonly #dir: string | undefined;
  readonly #onProblem: (file: string, error: string) => void;
  readonly #savedBy: string;
  readonly #onChange: (kit: string) => void;
  #agentKits = new Map<string, Kit>();
  /** The source each loaded agent kit was compiled from, to tell which kits a re-read changed. */
  #sources = new Map<string, string>();
  #primed = false;
  #stamp = -1;

  constructor(options: KitLibraryOptions) {
    this.#dir = options.dir;
    this.#onProblem = options.onProblem ?? (() => {});
    this.#savedBy = options.savedBy ?? "unknown";
    this.#onChange = options.onChange ?? (() => {});
    this.#refresh();
  }

  get enabled(): boolean {
    return this.#dir !== undefined;
  }

  /** Agent kits currently on disk, by name. Re-reads the directory when it changed. */
  agentKits(): Map<string, Kit> {
    this.#refresh();
    return new Map(this.#agentKits);
  }

  /** True for kits agents saved on this body. */
  isAgent(name: string): boolean {
    this.#refresh();
    return this.#agentKits.has(name);
  }

  /** Every loadable kit: the built-ins plus the agent kits. */
  list(): Kit[] {
    return [...BUILTIN_KITS, ...this.agentKits().values()];
  }

  /**
   * Validates kit source without writing anything: it must compile, pass the escape audit, keep
   * its name free of the built-ins, use only kits `resolvable` names, and not take part in a use
   * cycle. Returns the compiled kit, or throws KitSourceError.
   */
  check(source: string, resolvable: (name: string) => boolean): Kit {
    const escapes = findEscapeAttempts(source);
    if (escapes.length > 0) {
      throw new KitSourceError(`kit source matches the escape audit (${escapes.join(", ")}); write it without those names`);
    }
    const kit = compileKit(source);
    if (BUILTIN_KITS.some((builtin) => builtin.name === kit.name)) {
      throw new KitSourceError(`the name "${kit.name}" is taken by a built-in kit`);
    }
    for (const dep of kit.uses) {
      if (dep === kit.name) throw new KitSourceError(`kit "${kit.name}" cannot use itself`);
      if (!resolvable(dep)) {
        throw new KitSourceError(`kit "${kit.name}" uses "${dep}", which this body does not offer`);
      }
    }
    const agents = this.agentKits();
    const usesOf = (name: string): readonly string[] => agents.get(name)?.uses ?? [];
    const reaches = (from: string, target: string, seen: Set<string> = new Set()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return usesOf(from).some((dep) => reaches(dep, target, seen));
    };
    for (const dep of kit.uses) {
      if (reaches(dep, kit.name)) throw new KitSourceError(`kit "${kit.name}" would take part in a use cycle through "${dep}"`);
    }
    return kit;
  }

  /**
   * Validates kit source (see `check`) and writes it to the agent-kit directory. Nothing is
   * written when validation fails. The save becomes a new version in the kit's history, unless the
   * source is the one already saved.
   */
  async save(source: string, resolvable: (name: string) => boolean, revertedFrom?: number): Promise<Kit> {
    if (!this.#dir) throw new KitSourceError("agent kits are disabled on this body");
    const kit = this.check(source, resolvable);
    mkdirSync(this.#dir, { recursive: true });
    const file = path.join(this.#dir, `${kit.name}.ts`);
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    this.#record(kit.name, current, source, file, revertedFrom);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, source);
    renameSync(tmp, file);
    this.#stamp = -1;
    this.#refresh();
    return kit;
  }

  /** Deletes a saved kit. Built-in kits cannot be removed. */
  async remove(name: string): Promise<void> {
    if (BUILTIN_KITS.some((builtin) => builtin.name === name)) {
      throw new KitSourceError(`"${name}" is a built-in kit and cannot be removed`);
    }
    if (!this.#dir) throw new KitSourceError("agent kits are disabled on this body");
    const file = path.join(this.#dir, `${name}.ts`);
    if (!existsSync(file)) throw new KitSourceError(`no agent kit "${name}"`);
    unlinkSync(file);
    this.#stamp = -1;
    this.#refresh();
  }

  /** The saved versions of an agent kit, oldest first. A removed kit keeps its history. */
  async versions(name: string): Promise<KitVersion[]> {
    if (!this.#dir) throw new KitSourceError("agent kits are disabled on this body");
    const history = this.#history(name);
    if (history.length === 0) throw new KitSourceError(`no saved versions of "${name}"`);
    const file = path.join(this.#dir, `${name}.ts`);
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const currentVersion = current === undefined ? undefined : history.findLast((entry) => entry.source === current)?.meta.version;
    return history.map(({ meta }) => ({ ...meta, current: meta.version === currentVersion }));
  }

  /**
   * Saves an earlier version of a kit again, as a new version, validated like any save. The
   * history only grows, so a revert can itself be reverted.
   */
  async revert(name: string, version: number, resolvable: (name: string) => boolean): Promise<Kit> {
    if (!this.#dir) throw new KitSourceError("agent kits are disabled on this body");
    const history = this.#history(name);
    const entry = history.find((candidate) => candidate.meta.version === version);
    if (!entry) {
      const known = history.map((candidate) => candidate.meta.version).join(", ");
      throw new KitSourceError(`kit "${name}" has no version ${version}${known ? `; saved versions: ${known}` : ""}`);
    }
    const kit = compileKit(entry.source);
    if (kit.name !== name) throw new KitSourceError(`version ${version} of "${name}" holds the kit "${kit.name}"; it cannot be restored as "${name}"`);
    return this.save(entry.source, resolvable, version);
  }

  /** The source of a kit: the agent's file, or a built-in kit's file. Undefined for unknown kits. */
  source(name: string): string | undefined {
    if (KitName.safeParse(name).success && this.isAgent(name)) {
      return readFileSync(path.join(this.#dir!, `${name}.ts`), "utf8");
    }
    const builtin = path.join(BUILTIN_KIT_DIR, `${name}.ts`);
    return existsSync(builtin) ? readFileSync(builtin, "utf8") : undefined;
  }

  /** The directory holding the saved versions of one kit. Rejects names that are not kit names, so a name cannot leave the history directory. */
  #historyDir(name: string): string {
    if (!KitName.safeParse(name).success) throw new KitSourceError(`"${name}" is not a kit name`);
    return path.join(this.#dir!, HISTORY_DIR, name);
  }

  /** Every saved version of a kit with its source, oldest first. A version whose files cannot be read is skipped. */
  #history(name: string): { meta: Omit<KitVersion, "current">; source: string }[] {
    const dir = this.#historyDir(name);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
      throw err;
    }
    const entries: { meta: Omit<KitVersion, "current">; source: string }[] = [];
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      try {
        const meta = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Omit<KitVersion, "current">;
        entries.push({ meta, source: readFileSync(path.join(dir, `${meta.version}.ts`), "utf8") });
      } catch {
        // A save by another body may still be writing its files; the next listing sees it whole.
      }
    }
    return entries.sort((a, b) => a.meta.version - b.meta.version);
  }

  /**
   * Records what is about to be written over `file`. A file that is not the latest version (written
   * by hand, or before histories existed) becomes a version of its own first; then the new source
   * becomes the next version, unless it is the latest one already.
   */
  #record(name: string, current: string | undefined, source: string, file: string, revertedFrom: number | undefined): void {
    let latest = this.#history(name).at(-1)?.source;
    if (current !== undefined && latest !== current && this.#namesKit(name, current)) {
      this.#writeVersion(name, current, { savedAt: statSync(file).mtime.toISOString(), savedBy: "unknown" });
      latest = current;
    }
    if (latest !== source) {
      this.#writeVersion(name, source, { savedAt: new Date().toISOString(), savedBy: this.#savedBy, ...(revertedFrom !== undefined && { revertedFrom }) });
    }
  }

  /** Whether `source` compiles to a kit called `name`: the only kind of file that belongs in that kit's history. */
  #namesKit(name: string, source: string): boolean {
    try {
      return compileKit(source).name === name;
    } catch {
      return false;
    }
  }

  /** Writes the next version. Bodies can share the directory: the metadata file is created exclusively, so a number taken by another body moves this save to the next one. */
  #writeVersion(name: string, source: string, meta: Omit<KitVersion, "current" | "version">): void {
    const dir = this.#historyDir(name);
    mkdirSync(dir, { recursive: true });
    const latest = this.#history(name).at(-1)?.meta.version ?? 0;
    for (let version = latest + 1; ; version++) {
      try {
        writeFileSync(path.join(dir, `${version}.json`), `${JSON.stringify({ version, ...meta }, null, 2)}\n`, { flag: "wx" });
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "EEXIST") continue;
        throw err;
      }
      writeFileSync(path.join(dir, `${version}.ts`), source);
      return;
    }
  }

  /** Re-reads the agent-kit directory when its modification time changed. */
  #refresh(): void {
    if (!this.#dir) return;
    let stamp: number;
    try {
      stamp = statSync(this.#dir).mtimeMs;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      stamp = 0;
    }
    if (stamp === this.#stamp) return;
    const loaded = new Map<string, Kit>();
    const sources = new Map<string, string>();
    let files: string[] = [];
    try {
      files = readdirSync(this.#dir).filter((f) => f.endsWith(".ts")).sort();
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }
    for (const file of files) {
      const source = readFileSync(path.join(this.#dir, file), "utf8");
      let kit: Kit;
      try {
        kit = compileKit(source);
      } catch (err) {
        this.#onProblem(file, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (kit.name !== file.slice(0, -".ts".length)) {
        this.#onProblem(file, `the file name must match the kit name "${kit.name}"`);
        continue;
      }
      loaded.set(kit.name, kit);
      sources.set(kit.name, source);
    }
    // Uses must resolve against the built-ins and the other loadable agent kits; a cycle or a
    // missing kit drops every kit that needs it, each reported.
    const drop = (name: string, reason: string) => {
      if (!loaded.delete(name)) return;
      this.#onProblem(`${name}.ts`, reason);
      for (const other of loaded.values()) {
        if (other.uses.includes(name)) drop(other.name, `it uses "${name}", which was dropped (${reason})`);
      }
    };
    for (const kit of [...loaded.values()]) {
      const stack: string[] = [];
      const visit = (name: string): boolean => {
        if (stack.includes(name)) {
          drop(name, `it takes part in a use cycle: ${[...stack, name].join(" -> ")}`);
          return true;
        }
        stack.push(name);
        for (const dep of loaded.get(name)?.uses ?? []) {
          if (!BUILTIN_KITS.some((b) => b.name === dep) && visit(dep)) return true;
        }
        stack.pop();
        return false;
      };
      if (visit(kit.name)) continue;
      for (const dep of kit.uses) {
        if (dep === kit.name) {
          drop(kit.name, "it uses itself");
        } else if (!BUILTIN_KITS.some((b) => b.name === dep) && !loaded.has(dep)) {
          drop(kit.name, `it uses "${dep}", which is neither a built-in kit nor a saved kit`);
        }
      }
    }
    if (this.#primed) {
      for (const name of new Set([...this.#sources.keys(), ...loaded.keys()])) {
        if (this.#sources.get(name) !== (loaded.has(name) ? sources.get(name) : undefined)) this.#onChange(name);
      }
    }
    this.#sources = new Map([...sources].filter(([name]) => loaded.has(name)));
    this.#primed = true;
    this.#agentKits = loaded;
    this.#stamp = stamp;
  }
}
