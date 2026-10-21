import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RoutineLibrary, RoutineSourceError } from "../src/host/routines/library.ts";
import { typeCheckRoutine } from "../src/host/typecheck.ts";
import { ROUTINE_SOURCE_LIMIT, type RoutineVersion } from "../src/protocol/index.ts";

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory for one test; the library inside it does not exist until something is saved. */
function libraryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "minebot-routine-lib-"));
  scratch.push(root);
  return path.join(root, "routines");
}

/** Every path under `dir` with the hash of each file: two equal snapshots are byte-identical trees. A missing `dir` is its own snapshot. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return ["<absent>"];
  const lines: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${path.relative(dir, full)}/`);
        walk(full);
      } else {
        lines.push(`${path.relative(dir, full)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(dir);
  return lines;
}

const strip = ({ version, revertedFrom, current }: RoutineVersion) => ({ version, revertedFrom, current });

describe("RoutineLibrary versions", () => {
  it("keeps one version per save that differs from the latest, oldest first, for any sequence of saves and reverts", async () => {
    // A small pool of sources makes repeats (same as latest, same as an older version) likely.
    let seed = 20260721;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      const library = new RoutineLibrary({ dir: libraryDir(), savedBy: "tester" });
      const model: { source: string; revertedFrom?: number }[] = [];
      for (let step = 0; step < 24; step++) {
        const revert = model.length > 0 && random(3) === 0;
        let source: string;
        let info;
        if (revert) {
          const v = 1 + random(model.length);
          source = model[v - 1]!.source;
          info = await library.revert("walk", v);
          if (model.at(-1)!.source !== source) model.push({ source, revertedFrom: v });
        } else {
          source = `export default ${random(5)};\n`;
          info = await library.save("walk", source);
          if (model.at(-1)?.source !== source) model.push({ source });
        }
        assert.equal(library.source("walk"), source);
        assert.equal(info.version, model.length, `round ${round} step ${step}: the version the call reports`);
        assert.deepEqual(
          (await library.versions("walk")).map(strip),
          model.map((entry, i) => ({ version: i + 1, revertedFrom: entry.revertedFrom, current: i === model.length - 1 })),
          `round ${round} step ${step}`,
        );
      }
    }
  });

  it("restores an earlier version as a new one, and a revert can be reverted", async () => {
    const library = new RoutineLibrary({ dir: libraryDir(), savedBy: "tester" });
    await library.save("r", "export default 1;\n");
    await library.save("r", "export default 2;\n");
    const reverted = await library.revert("r", 1);
    assert.equal(reverted.version, 3);
    assert.equal(library.source("r"), "export default 1;\n");
    assert.deepEqual((await library.versions("r")).map(strip), [
      { version: 1, revertedFrom: undefined, current: false },
      { version: 2, revertedFrom: undefined, current: false },
      { version: 3, revertedFrom: 1, current: true },
    ]);
    await library.revert("r", 2);
    assert.equal(library.source("r"), "export default 2;\n");
    assert.equal((await library.versions("r")).length, 4);
  });

  it("adds no version for a save, or a revert, of the source the routine already has", async () => {
    const library = new RoutineLibrary({ dir: libraryDir(), savedBy: "tester" });
    await library.save("r", "export default 1;\n");
    await library.save("r", "export default 2;\n");
    const again = await library.save("r", "export default 2;\n");
    assert.equal(again.version, 2);
    await library.revert("r", 1);
    const noop = await library.revert("r", 1);
    assert.equal(noop.version, 3);
    assert.deepEqual((await library.versions("r")).map((v) => v.version), [1, 2, 3]);
  });

  it("records who saved each version and when", async () => {
    const dir = libraryDir();
    await new RoutineLibrary({ dir, savedBy: "alice" }).save("r", "export default 1;\n");
    await new RoutineLibrary({ dir, savedBy: "bob" }).save("r", "export default 2;\n");
    const versions = await new RoutineLibrary({ dir, savedBy: "carol" }).versions("r");
    assert.deepEqual(versions.map((v) => v.savedBy), ["alice", "bob"]);
    for (const v of versions) assert.equal(new Date(v.savedAt).toISOString(), v.savedAt);
  });

  it("keeps source found in the library that no save wrote, as a version of its own, before replacing it", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    await library.save("r", "export default 1;\n");
    writeFileSync(path.join(dir, "r.ts"), "export default 'by hand';\n");
    assert.deepEqual(library.list(), [{ name: "r" }]);
    assert.ok((await library.versions("r")).every((v) => !v.current));
    await library.save("r", "export default 2;\n");
    const versions = await library.versions("r");
    assert.deepEqual(versions.map((v) => [v.version, v.savedBy, v.current]), [[1, "tester", false], [2, "unknown", false], [3, "tester", true]]);
    assert.equal(readFileSync(path.join(dir, ".history/r/2.ts"), "utf8"), "export default 'by hand';\n");
  });

  it("answers an unknown version with the versions there are, and an unsaved routine with no versions", async () => {
    const library = new RoutineLibrary({ dir: libraryDir(), savedBy: "tester" });
    assert.deepEqual(await library.versions("r"), []);
    await library.save("r", "export default 1;\n");
    await assert.rejects(library.revert("r", 7), (err) => err instanceof RoutineSourceError && /no version 7; saved versions: 1/.test(err.message));
    await assert.rejects(library.revert("other", 1), (err) => err instanceof RoutineSourceError && /no version 1/.test(err.message));
    await assert.rejects(library.revert("r", 1.5), RoutineSourceError);
  });

  it("sees what another body saved without being told", async () => {
    const dir = libraryDir();
    const a = new RoutineLibrary({ dir, savedBy: "a" });
    const b = new RoutineLibrary({ dir, savedBy: "b" });
    await a.save("r", "export default 1;\n");
    assert.equal(b.source("r"), "export default 1;\n");
    await b.save("r", "export default 2;\n");
    assert.deepEqual((await a.versions("r")).map((v) => [v.version, v.savedBy, v.current]), [[1, "a", false], [2, "b", true]]);
  });
});

describe("RoutineLibrary saves", () => {
  const bad = ["", "Upper", "1abc", "_x", "-x", "a b", "a.b", "a/b", "../x", "a/../b", "..", ".history", "x".repeat(49), "naïve"];

  it("refuses a bad name or an oversize source and leaves the library byte for byte as it was", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    assert.deepEqual(snapshot(dir), ["<absent>"]);
    for (const name of bad) await assert.rejects(library.save(name, "export default 1;\n"), RoutineSourceError, JSON.stringify(name));
    await assert.rejects(library.save("big", "x".repeat(ROUTINE_SOURCE_LIMIT + 1)), RoutineSourceError);
    assert.deepEqual(snapshot(dir), ["<absent>"], "nothing is created for a refused save");

    await library.save("keep", "export default 1;\n");
    await library.save("keep", "export default 2;\n");
    const before = snapshot(dir);
    assert.ok(before.length >= 6, before.join("\n"));
    for (const name of bad) await assert.rejects(library.save(name, "export default 1;\n"), RoutineSourceError, JSON.stringify(name));
    await assert.rejects(library.save("keep", "x".repeat(ROUTINE_SOURCE_LIMIT + 1)), RoutineSourceError);
    await assert.rejects(library.save("big", "x".repeat(ROUTINE_SOURCE_LIMIT + 1)), RoutineSourceError);
    // The limit is in bytes: 65537 two-byte characters are over it though they are fewer than 128 Ki characters.
    await assert.rejects(library.save("keep", "é".repeat(ROUTINE_SOURCE_LIMIT / 2 + 1)), RoutineSourceError);
    for (const name of bad) await assert.rejects(library.revert(name, 1), RoutineSourceError, JSON.stringify(name));
    assert.deepEqual(snapshot(dir), before);
    assert.equal(library.source("keep"), "export default 2;\n");
  });

  it("accepts a source of exactly the limit and a name of exactly 48 characters", async () => {
    const library = new RoutineLibrary({ dir: libraryDir(), savedBy: "tester" });
    const name = `a${"-_0".repeat(15)}${"z".repeat(2)}`;
    assert.equal(name.length, 48);
    const source = "é".repeat(ROUTINE_SOURCE_LIMIT / 2);
    assert.equal((await library.save(name, source)).version, 1);
    assert.equal(library.source(name), source);
  });

  it("replaces the file by rename and leaves no temporary file behind", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    await library.save("r", "export default 1;\n");
    const before = statSync(path.join(dir, "r.ts")).ino;
    await library.save("r", "export default 2;\n");
    assert.notEqual(statSync(path.join(dir, "r.ts")).ino, before, "a rewrite in place keeps the inode");
    assert.deepEqual(readdirSync(dir).sort(), [".history", "r.ts"]);
    assert.deepEqual(readdirSync(path.join(dir, ".history/r")).sort(), ["1.json", "1.ts", "2.json", "2.ts"]);
  });

  it("stores the saved source verbatim, with its history", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    const source = "// \u00e9\r\nexport default 1;";
    const info = await library.save("r", source);
    assert.equal(readFileSync(path.join(dir, "r.ts"), "utf8"), source);
    assert.equal(readFileSync(path.join(dir, ".history/r/1.ts"), "utf8"), source);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".history/r/1.json"), "utf8")), { version: 1, savedAt: info.savedAt, savedBy: "tester" });
  });
});

describe("RoutineLibrary list and source", () => {
  it("lists the flat modules by name with their versions, and nothing else", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    assert.deepEqual(library.list(), []);
    const zed = await library.save("zed", "export default 1;\n");
    await library.save("alpha", "export default 1;\n");
    const alpha = await library.save("alpha", "export default 2;\n");
    await library.save("a-b_c9", "export default 1;\n");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub/x.ts"), "export default 1;\n");
    mkdirSync(path.join(dir, "dir.ts"));
    writeFileSync(path.join(dir, "Upper.ts"), "export default 1;\n");
    writeFileSync(path.join(dir, "plain.js"), "export default 1;\n");
    writeFileSync(path.join(dir, "alpha.ts.123.tmp"), "export default 1;\n");
    writeFileSync(path.join(dir, "by-hand.ts"), "export default 1;\n");
    const listed = library.list();
    assert.deepEqual(listed.map((r) => r.name), ["a-b_c9", "alpha", "by-hand", "zed"]);
    assert.deepEqual(listed.find((r) => r.name === "alpha"), { name: "alpha", version: 2, savedAt: alpha.savedAt });
    assert.deepEqual(listed.find((r) => r.name === "zed"), { name: "zed", version: 1, savedAt: zed.savedAt });
    assert.deepEqual(listed.find((r) => r.name === "by-hand"), { name: "by-hand" });
  });

  it("lists a library reached through a symlink", async () => {
    const dir = libraryDir();
    await new RoutineLibrary({ dir, savedBy: "tester" }).save("r", "export default 1;\n");
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    const library = new RoutineLibrary({ dir: link, savedBy: "tester" });
    assert.deepEqual(library.list().map((r) => r.name), ["r"]);
    assert.equal(library.source("r"), "export default 1;\n");
  });

  it("gives the source of a routine, and nothing for a name that is not one or a module that is not there", async () => {
    const dir = libraryDir();
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    assert.equal(library.source("r"), undefined);
    await library.save("r", "export default 1;\n");
    writeFileSync(path.join(dir, "secret.txt"), "no");
    mkdirSync(path.join(dir, "d.ts"));
    assert.equal(library.source("r"), "export default 1;\n");
    for (const name of ["missing", "d", "../routines/r", "r.ts", "R", ".history", ""]) assert.equal(library.source(name), undefined, JSON.stringify(name));
  });
});

describe("RoutineLibrary never evaluates a module", () => {
  it("leaves no marker after save, list, source, versions, revert, or the type check of a module that writes one at its top level", async () => {
    const dir = libraryDir();
    const marker = path.join(path.dirname(dir), "marker");
    const body = (n: number) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport default ${n};\n`;
    const library = new RoutineLibrary({ dir, savedBy: "tester" });
    await library.save("boom", body(1));
    await library.save("boom", body(2));
    library.list();
    library.source("boom");
    await library.versions("boom");
    await library.revert("boom", 1);
    await typeCheckRoutine(dir, "boom");
    assert.equal(existsSync(marker), false, "a module ran");
  });
});

describe("RoutineLibrary bodies sharing one directory", () => {
  /** Resolves with the next message of `child`; rejects if the child exits first. */
  function nextMessage(child: ChildProcess): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`a body exited with ${code}`)));
    return promise;
  }

  it("numbers the saves of two bodies in separate processes without losing or repeating one", async () => {
    const dir = libraryDir();
    const fixture = fileURLToPath(new URL("./fixtures/routines/save-many.ts", import.meta.url));
    const each = 40;
    const bodies = ["a", "b"].map((who) => {
      const child = fork(fixture, [dir, who, String(each)], { execArgv: process.execArgv });
      return { child, ready: nextMessage(child) };
    });
    try {
      await Promise.all(bodies.map((body) => body.ready));
      // Several rounds: the bodies' saves overlap only as far as the scheduler lets them, and one round can miss.
      for (let round = 0; round < 5; round++) {
        const name = `shared${round}`;
        const done = bodies.map((body) => nextMessage(body.child));
        for (const body of bodies) body.child.send(name);
        await Promise.all(done);

        const versions = await new RoutineLibrary({ dir, savedBy: "reader" }).versions(name);
        assert.equal(versions.length, 2 * each, `round ${round}`);
        assert.deepEqual(versions.map((v) => v.version), Array.from({ length: 2 * each }, (_, i) => i + 1));
        const sources = versions.map((v) => readFileSync(path.join(dir, ".history", name, `${v.version}.ts`), "utf8"));
        assert.equal(new Set(sources).size, 2 * each, "every save is a version of its own");
        assert.deepEqual(readdirSync(path.join(dir, ".history", name)).sort(), Array.from({ length: 2 * each }, (_, i) => [`${i + 1}.json`, `${i + 1}.ts`]).flat().sort());
        assert.equal(versions.filter((v) => v.current).length, 1);
      }
    } finally {
      for (const body of bodies) body.child.disconnect();
    }
  });
});
