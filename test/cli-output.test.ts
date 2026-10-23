// What the client prints is the same wherever it goes. The CLI ends with process.exit, and Node writes to a
// pipe asynchronously: an exit with output still queued cuts it short, with exit code 0. These tests run the
// real CLI against a body that answers with far more than a pipe holds (64 KB), once with stdout and stderr
// real pipes whose reader is slow, once with both redirected to files, and once through the sockets
// child_process hands a parent; each must carry, byte for byte, the text a terminal would show, and the
// exit code the command ends with. A command that prints and then fails also runs with stdout and stderr
// merged into one pipe and one file, where its error line must come after everything it printed.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { HAS_BODY, usageFor } from "../src/client/usage.ts";
import { OPERATOR_FLAG_HELP } from "../src/client/body-flags.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const SCRATCH = mkdtempSync(path.join(tmpdir(), "minebot-cli-output-"));
const FEATURES: BodyFeatures = { wiki: "read", lessons: false, milestones: false, reflexes: true, routines: true, builtins: ["move", "mine"] };

/** About 200 KB of numbered lines with multi-byte characters, so a cut anywhere shows in the bytes. */
function bulk(label: string): string {
  return Array.from({ length: 4000 }, (_, i) => `${label} line ${String(i).padStart(5, "0")} — héllo wörld, ünïcode ✓ ${"=".repeat(20)}`).join("\n");
}
const DOCS = bulk("docs");
const API = bulk("api");
const PAGE = bulk("page");
const NOTE = bulk("note");
const SOURCE = bulk("source");
const LOGS = bulk("log");
const FAILURE = bulk("failure");
const TYPE_ERRORS = bulk("type error").split("\n");

let server: Server;
let url: string;

before(async () => {
  server = createServer(async (req, res) => {
    const raw = await text(req);
    const requested = new URL(req.url!, "http://body");
    const body = raw === "" ? {} : (JSON.parse(raw) as { code?: string; name?: string });
    res.setHeader("content-type", "application/json");
    const answer = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    switch (`${req.method} ${requested.pathname}`) {
      case "GET /features": return answer(FEATURES);
      case "GET /builtins/docs": return answer({ docs: DOCS });
      case "GET /builtins/source": return answer({ error: FAILURE }, 404);
      case "GET /routines/source": return answer({ name: "big", source: SOURCE });
      case "POST /routines/save": return answer({ routine: { name: body.name, version: 1, savedAt: "now" }, typeCheck: { status: "failed", errors: TYPE_ERRORS } });
      case "GET /api": return answer({ doc: API });
      case "GET /wiki/page": return answer({ page: {}, text: PAGE });
      case "GET /notes/big": return answer({ key: "big", text: NOTE, updated: "now" });
      case "POST /run": return answer({ status: body.code === "fail" ? "error" : "ok", durationMs: 5, logs: LOGS });
      case "POST /call": return answer({ status: body.name === "bad" ? "error" : "ok", durationMs: 5, logs: LOGS });
      default: return answer({ error: `no answer for ${req.method} ${req.url}` }, 404);
    }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface Captured {
  code: number;
  out: Buffer;
  err: Buffer;
}

const env = () => ({ ...process.env, MINEBOT_URL: url, MINEBOT_TOKEN: "" });

/** Runs the CLI under `sh -c script`, which leaves its stdout, stderr and exit code in files of a fresh directory. */
async function viaShell(script: string, args: string[]): Promise<Captured> {
  const dir = mkdtempSync(path.join(SCRATCH, "run-"));
  const child = spawn("sh", ["-c", script, "sh", ...CLI, ...args], { env: { ...env(), NODE: process.execPath, DIR: dir }, stdio: "ignore" });
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  await closed.promise;
  return { code: Number(readFileSync(path.join(dir, "code"), "utf8")), out: readFileSync(path.join(dir, "out")), err: readFileSync(path.join(dir, "err")) };
}

/**
 * Both streams real pipes (a shell pipeline, not the sockets child_process makes), each read by a `cat` that
 * starts only after a delay, so the CLI has more queued than the pipe holds when it ends.
 */
const throughPipes = (args: string[]) =>
  viaShell(`{ { "$NODE" "$@"; echo $? > "$DIR/code"; } 2>&1 1>&3 | { sleep 0.4; cat > "$DIR/err"; }; } 3>&1 | { sleep 0.4; cat > "$DIR/out"; }`, args);

/** Both streams redirected to files by the shell. */
const toFiles = (args: string[]) => viaShell(`"$NODE" "$@" > "$DIR/out" 2> "$DIR/err"; echo $? > "$DIR/code"`, args);

/** stdout and stderr one pipe, as `2>&1 | cat` makes them, read by a `cat` that starts only after a delay. */
const mergedPipe = (args: string[]) =>
  viaShell(`: > "$DIR/err"; { "$NODE" "$@"; echo $? > "$DIR/code"; } 2>&1 | { sleep 0.4; cat > "$DIR/out"; }`, args);

/** stdout and stderr one file. */
const mergedFile = (args: string[]) => viaShell(`: > "$DIR/err"; "$NODE" "$@" > "$DIR/out" 2>&1; echo $? > "$DIR/code"`, args);

/** Both streams as a parent process reads them. */
async function throughSockets(args: string[]): Promise<Captured> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [...CLI, ...args], { env: env(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: Buffer; stderr: Buffer };
    return { code: failed.code, out: failed.stdout, err: failed.stderr };
  }
}

function assertBytes(actual: Buffer, expected: string, what: string): void {
  const want = Buffer.from(expected);
  assert.equal(actual.length, want.length, `${what}: ${actual.length} bytes, expected ${want.length}`);
  assert.ok(actual.equals(want), `${what}: same length, different bytes`);
}

const RUN_FILE = (code: string) => {
  const file = path.join(SCRATCH, `module-${code}.ts`);
  writeFileSync(file, code);
  return file;
};

/** The text a terminal shows for the run of `status`: formatRun's lines, then the newline console.log adds. */
const runText = (status: string) => `status: ${status} (5 ms)\n\nlogs:\n${LOGS}\n`;

interface Case {
  name: string;
  args: () => string[];
  code: number;
  out: string;
  err: string;
}

const MISSING = path.join(SCRATCH, "missing.ts");
// The message Node gives for the file the CLI cannot read, as the CLI receives it.
const MISSING_MESSAGE = await readFile(MISSING, "utf8").then(
  () => assert.fail(`${MISSING} exists`),
  (err: Error) => err.message,
);

const CASES: Case[] = [
  { name: "builtins docs", args: () => ["builtins", "docs"], code: 0, out: `${DOCS}\n`, err: "" },
  { name: "api", args: () => ["api"], code: 0, out: `${API}\n`, err: "" },
  { name: "wiki read", args: () => ["wiki", "read", "any"], code: 0, out: `${PAGE}\n`, err: "" },
  { name: "notes get", args: () => ["notes", "get", "big"], code: 0, out: `${NOTE}\n`, err: "" },
  { name: "routines source", args: () => ["routines", "source", "big"], code: 0, out: `${SOURCE}\n`, err: "" },
  { name: "run with large logs", args: () => ["run", RUN_FILE("ok")], code: 0, out: runText("ok"), err: "" },
  { name: "run that fails (status 2)", args: () => ["run", RUN_FILE("fail")], code: 2, out: runText("error"), err: "" },
  { name: "call with large logs", args: () => ["call", "good"], code: 0, out: runText("ok"), err: "" },
  { name: "call that fails (status 2)", args: () => ["call", "bad"], code: 2, out: runText("error"), err: "" },
  { name: "an error exit with a large message on stderr", args: () => ["builtins", "source", "missing"], code: 1, out: "", err: `[minebot] ${FAILURE}\n` },
  {
    name: "an error exit after large output (the second of two routines is missing)",
    args: () => ["routines", "save", RUN_FILE("ok"), MISSING],
    code: 1,
    out: `saved module-ok  v1  now\ntype check: failed\n${TYPE_ERRORS.map((error) => `  ${error}`).join("\n")}\n`,
    err: `[minebot] ${MISSING_MESSAGE}\n`,
  },
];

// The unknown-command exit prints the command word back, so a long word makes its stderr past 64 KB.
const WORD = "x".repeat(100_000);
const UNKNOWN: Case = {
  name: "the unknown-command exit",
  args: () => [WORD],
  code: 1,
  out: "",
  err: `unknown command: ${WORD}\n\n${usageFor(FEATURES, HAS_BODY, OPERATOR_FLAG_HELP)}\n`,
};

describe("client output past a pipe's capacity", () => {
  for (const c of [...CASES, UNKNOWN]) {
    for (const [leg, run] of [["pipes", throughPipes], ["files", toFiles], ["sockets", throughSockets]] as const) {
      it(`${c.name}: the same bytes and exit code to ${leg} as to a terminal`, async () => {
        const got = await run(c.args());
        assertBytes(got.out, c.out, "stdout");
        assertBytes(got.err, c.err, "stderr");
        assert.equal(got.code, c.code, "exit code");
      });
    }
  }
});

describe("client output past a pipe's capacity, stdout and stderr merged", () => {
  // Every command that writes to stderr after it has printed to stdout.
  for (const c of CASES.filter((c) => c.out !== "" && c.err !== "")) {
    for (const [leg, run] of [["one pipe", mergedPipe], ["one file", mergedFile]] as const) {
      it(`${c.name}: what it printed, then the error, to ${leg} as to a terminal`, async () => {
        const got = await run(c.args());
        assertBytes(got.out, c.out + c.err, "stdout and stderr");
        assert.equal(got.code, c.code, "exit code");
      });
    }
  }
});
