// A whole body for tests that need a player but no Minecraft server: the supervisor's HostProcess
// (with its event log and program history, and a short kill grace) forking fake-bot-host.ts, the
// real bot host over a fake player. Requests go through `forward`, as the HTTP transport's do.
// The module's own scratch directory holds everything a body writes; `removeScratch` deletes it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventLog } from "../../../src/body/events.ts";
import type { HostProcess } from "../../../src/body/host-process.ts";
import type { HostInit } from "../../../src/protocol/host.ts";
import type { BodyEvent } from "../../../src/protocol/index.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "minebot-fake-body-"));
process.env.MINEBOT_RUNTIME_DIR = path.join(ROOT, "runtime");
// The typechecker's scratch directories go under ROOT too.
process.env.TMPDIR = ROOT;

// MINEBOT_RUNTIME_DIR is read when the discovery module loads, so nothing that reaches it loads before the lines above.
const { EventLog: Events } = await import("../../../src/body/events.ts");
const { HostProcess: Host } = await import("../../../src/body/host-process.ts");
const { ProgramHistory } = await import("../../../src/body/history.ts");

/** The kill grace of every fake body's supervisor: a program that does not settle this long after its abort ends with its host. */
export const GRACE_MS = 500;
const ENTRY = path.join(import.meta.dirname, "fake-bot-host.ts");

export interface FakeBodyOptions {
  /** The state directory; a body started on the directory of an earlier one is that body restarted. Default: a new one. */
  stateDir?: string;
  /** Files written before the body starts: path relative to the state directory → text (objects become JSON). */
  stateFiles?: Record<string, unknown>;
  /** Overrides of the body's options (wikiMode, routines, triggers, ...). */
  init?: Partial<HostInit>;
  /** Event types whose echo from the event log never reaches the host's triggers. */
  dropEchoes?: string[];
}

export class FakeBody {
  readonly host: HostProcess;
  readonly events: EventLog;
  readonly stateDir: string;
  readonly historyFile: string;

  constructor(host: HostProcess, events: EventLog, stateDir: string, historyFile: string) {
    this.host = host;
    this.events = events;
    this.stateDir = stateDir;
    this.historyFile = historyFile;
  }

  get routinesDir(): string {
    return path.join(this.stateDir, "routines");
  }

  /** One API request; the answer is the status and the parsed JSON body. A body that is not given is empty. */
  request(method: string, url: string, json?: unknown): Promise<{ status: number; body: unknown }> {
    return this.host.forward({ method, url, body: json === undefined ? null : Buffer.from(JSON.stringify(json)), tooLarge: false });
  }

  /** The request, which must answer 200; the body. */
  async ok(method: string, url: string, json?: unknown): Promise<unknown> {
    const answer = await this.request(method, url, json);
    assert.equal(answer.status, 200, `${method} ${url} answered ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  }

  /** Writes routine modules straight into the library directory, without a save. */
  writeRoutines(files: Record<string, string>): void {
    mkdirSync(this.routinesDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(this.routinesDir, `${name}.ts`), text);
  }

  /** Every line of the program history, parsed. */
  history(): Record<string, unknown>[] {
    return existsSync(this.historyFile)
      ? readFileSync(this.historyFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  }

  eventsOf(type: string): BodyEvent[] {
    return this.events.since(0, 1000).events.filter((event) => event.type === type);
  }

  /** The first event of `type` after `since`, which the body produces on its own. */
  async waitFor(type: string, since = 0): Promise<BodyEvent> {
    const { event } = await this.events.wait({ types: [type], since, timeoutMs: 15_000 });
    assert.ok(event, `no ${type} event`);
    return event;
  }

  async close(): Promise<void> {
    await this.host.close();
  }
}

let started = 0;

/** Starts a body on a fake player and resolves once it is connected. */
export async function startFakeBody(options: FakeBodyOptions = {}): Promise<FakeBody> {
  const name = `fake${++started}`;
  const stateDir = options.stateDir ?? path.join(ROOT, `${name}-state`);
  for (const [relative, content] of Object.entries(options.stateFiles ?? {})) {
    const file = path.join(stateDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  const historyFile = path.join(ROOT, `${name}-history.jsonl`);
  const events = new Events();
  const init: HostInit = {
    name,
    username: name,
    auth: "offline",
    host: "127.0.0.1",
    port: 1,
    wikiMode: "read",
    stateDir,
    lessonsDir: path.join(ROOT, `${name}-lessons`),
    milestonesEnabled: true,
    ...options.init,
    startedAt: new Date().toISOString(),
    deaths: 0,
    reconnects: 0,
    applyMilestones: true,
    ...(options.dropEchoes && { dropEchoes: options.dropEchoes }),
  } as HostInit;
  const history = new ProgramHistory({ file: historyFile });
  const host = new Host({ init, events, history, entry: ENTRY, graceMs: GRACE_MS });
  await host.start();
  await history.start();
  host.join();
  const body = new FakeBody(host, events, stateDir, historyFile);
  await body.waitFor("connected");
  return body;
}

export function removeScratch(): void {
  rmSync(ROOT, { recursive: true, force: true });
}
