// The agent kits an earlier body saved in `<state>/agent-kits/` are left alone: a body started over that state directory, run, and
// closed never reads, writes, or deletes anything in it, and says once on stderr, naming the directory, that it does not load them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-agent-kits-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
process.env.TMPDIR = ROOT;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads, so nothing that reaches it loads before the lines above.
const { startDaemon } = await import("../src/body/daemon.ts");

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A loopback port that refuses connections: bound once, then released. */
async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Every file below `dir` as `relative path → sha256`, directories as their own entries: what a cleanup, a rewrite, or a new file would change. */
function treeOf(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    tree[path.relative(dir, file)] = entry.isDirectory() ? "dir" : createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return tree;
}

const KIT = "// a kit file saved by an earlier body\nexport default {};\n";

/** A state directory with the files an earlier body left: agent kits with a version log, and the call counts. */
function stateWith(files: Record<string, string>): string {
  const state = path.join(mkdtempSync(path.join(ROOT, "state-")), "state");
  const kits = path.join(state, "agent-kits");
  mkdirSync(state, { recursive: true });
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(kits, relative)), { recursive: true });
    writeFileSync(path.join(kits, relative), text);
  }
  writeFileSync(path.join(state, "kit-stats.json"), `${JSON.stringify({ actions: { greeter: { hi: { ok: 3, failed: 0 } } } })}\n`);
  return state;
}

/** Starts a body over `state`, runs one request through it, and closes it, collecting what the supervisor wrote to stderr. */
async function lifecycle(state: string): Promise<string[]> {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    written.push(String(chunk));
    return Reflect.apply(write, process.stderr, [chunk, ...rest]) as boolean;
  }) as typeof process.stderr.write;
  try {
    const name = `agent-kits-${path.basename(path.dirname(state))}`;
    const daemon = await startDaemon({
      name,
      username: name,
      auth: "offline",
      host: "127.0.0.1",
      port: await refusedPort(),
      apiHost: "127.0.0.1",
      apiPort: 0,
      token: "t",
      wikiMode: "off",
      milestonesEnabled: false,
      stateDir: state,
    });
    try {
      const answer = await fetch(`${daemon.endpoint.url}/run`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ code: "return 1" }) });
      assert.equal(answer.status, 503, "the body ran a request: not connected, as in every body of these tests");
    } finally {
      await daemon.close();
    }
  } finally {
    process.stderr.write = write;
  }
  return written.join("").split("\n").filter(Boolean);
}

describe("the agent kits an earlier body saved", () => {
  it("are left byte for byte as they were by a body that starts, runs, and closes over them, and the body says once that they are not loaded", async () => {
    const state = stateWith({ "greeter.ts": KIT, "other.ts": `${KIT}// other\n`, ".history/greeter/1.ts": KIT, ".history/greeter/1.json": '{ "version": 1 }\n' });
    const before = treeOf(path.join(state, "agent-kits"));
    assert.equal(Object.keys(before).length, 6);
    const stats = readFileSync(path.join(state, "kit-stats.json"), "utf8");

    const lines = await lifecycle(state);

    assert.deepEqual(treeOf(path.join(state, "agent-kits")), before);
    // The body writes its call counts at close, in its own format; what an earlier body counted stays in them.
    assert.deepEqual(JSON.parse(readFileSync(path.join(state, "kit-stats.json"), "utf8")), JSON.parse(stats));
    const naming = lines.filter((line) => line.includes(path.join(state, "agent-kits")));
    assert.equal(naming.length, 1, lines.join("\n"));
    assert.match(naming[0]!, /agent kits are no longer loaded/);
  });

  it("are not reported by a body whose agent-kits directory holds no kit file, or is not there", async () => {
    const withoutKitFiles: Record<string, string>[] = [{ ".history/greeter/1.ts": KIT, "notes.txt": "x" }, {}];
    for (const files of withoutKitFiles) {
      const state = stateWith(files);
      const lines = await lifecycle(state);
      assert.deepEqual(lines.filter((line) => line.includes("agent-kits") || /agent kit/i.test(line)), [], JSON.stringify(Object.keys(files)));
    }
  });

  it("are not created: a body over a state directory without them leaves no agent-kits directory", async () => {
    const state = stateWith({});
    await lifecycle(state);
    assert.deepEqual(readdirSync(state).filter((name) => name.includes("kit") && name !== "kit-stats.json"), []);
  });
});
