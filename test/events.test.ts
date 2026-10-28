// The event log's cursors and its answers: without a cursor the newest events, with one the oldest
// after it, every answer naming the log's latest seq; and a cursor from an earlier log hides nothing
// of a fresh one. The MCP get_events tool is the client of the same rule (mb-znn.21, mb-2f8).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventLog } from "../src/body/events.ts";
import type { BodyFeatures, EventsResponse } from "../src/protocol/index.ts";

const chat = (message: string) => ({ from: "ana", message });

describe("EventLog.since", () => {
  it("answers a call without a cursor with the newest limit events, oldest first, and names the latest seq", () => {
    const log = new EventLog();
    for (let i = 1; i <= 1000; i++) log.push("chat", chat(String(i)));
    const page = log.since(undefined, 200);
    assert.equal(page.events.length, 200);
    assert.equal(page.events[0]!.data.message, "801");
    assert.equal(page.events.at(-1)!.data.message, "1000", "the newest event is in the answer");
    assert.equal(page.latest, page.events.at(-1)!.seq);
    assert.equal(page.next, page.latest, "the next call resumes after the newest event");
    // A page that is the whole log still answers it: the latest is the last.
    assert.equal(log.since(undefined, 1000).events.length, 1000);
  });

  it("keeps an explicit cursor on the oldest events after it", () => {
    const log = new EventLog();
    for (let i = 1; i <= 10; i++) log.push("chat", chat(String(i)));
    const prior = log.since(undefined, 10).events;
    const page = log.since(prior[3]!.seq, 2);
    assert.deepEqual(page.events.map((event) => event.data.message), ["5", "6"]);
    assert.equal(page.next, prior[5]!.seq);
    assert.equal(page.latest, prior.at(-1)!.seq);
    // An empty page after the newest event still names the log's latest.
    const done = log.since(prior.at(-1)!.seq, 2);
    assert.deepEqual(done.events, []);
    assert.equal(done.latest, page.latest);
  });

  it("answers an empty log with its latest seq and no events", () => {
    assert.deepEqual(new EventLog().since(), { events: [], next: 0, latest: 0 });
  });
});

describe("EventLog cursors across a restart", () => {
  it("a cursor from an earlier log hides none of a fresh log's events", async () => {
    const earlier = new EventLog();
    for (let i = 0; i < 60; i++) earlier.push("chat", chat(String(i)));
    const oldCursor = earlier.since(0, 60).events[49]!.seq;

    const fresh = new EventLog();
    for (let i = 0; i < 60; i++) fresh.push("chat", chat(`fresh ${i}`));
    const replayed = fresh.since(oldCursor);
    assert.equal(replayed.events.length, 60, "no event of the fresh log is hidden by an older cursor");
    assert.equal(replayed.events[0]!.data.message, "fresh 0");
    assert.deepEqual((await fresh.wait({ types: ["chat"], since: oldCursor, timeoutMs: 100 })).event?.data, chat("fresh 0"));
  });

  it("treats a plain cursor a restarting log could have issued (50) as older than everything", async () => {
    // The incident: an old cursor of 50 against a fresh log of 62 dropped the first 50 events.
    const log = new EventLog();
    for (let i = 0; i < 60; i++) log.push("death", { cause: `drowned ${i}` });
    const replayed = log.since(50);
    assert.equal(replayed.events.length, 60);
    assert.equal(replayed.events[0]!.data.cause, "drowned 0");
    const waited = await log.wait({ types: ["death"], since: 50, timeoutMs: 100 });
    assert.equal(waited.event?.data.cause, "drowned 0");
    // Still one exact non-negative integer on the wire, with no file of its own.
    assert.ok(Number.isSafeInteger(replayed.latest) && replayed.latest > 0);
  });
});

const FEATURES: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move"] };
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const EVENT: EventsResponse = { events: [{ seq: 7, time: 0, type: "chat", data: chat("hi") }], next: 7, latest: 7 };

describe("get_events over MCP", () => {
  let body: Server;
  let url: string;
  let mcp: Client;
  const requested: string[] = [];

  before(async () => {
    body = createServer((req, res) => {
      requested.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/features" ? FEATURES : req.url?.startsWith("/events") ? EVENT : { doc: "the program reference" }));
    });
    await new Promise<void>((resolve) => body.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(body.address() as AddressInfo).port}`;
    mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" }));
  });
  after(async () => {
    await mcp.close();
    body.close();
  });

  /** The text of one get_events call, and the /events URLs it made beyond the digest's own. */
  async function events(args: Record<string, unknown>): Promise<string> {
    requested.length = 0;
    const answer = (await mcp.callTool({ name: "get_events", arguments: args })) as { content: { text: string }[] };
    return answer.content[0]!.text;
  }

  it("takes a limit, omits since when it was not given, and answers the body's latest", async () => {
    const text = await events({ limit: 5 });
    assert.deepEqual(JSON.parse(text), EVENT);
    const tool = requested.filter((target) => target.includes("limit=5"));
    assert.equal(tool.length, 1, requested.join(" "));
    assert.doesNotMatch(tool[0]!, /since=/, "no cursor is sent when none was given");
  });

  it("sends the cursor and the limit together when both are given, and defaults the limit to 200", async () => {
    await events({ since: 7, limit: 2 });
    assert.ok(requested.some((target) => target.includes("since=7") && target.includes("limit=2")), requested.join(" "));
    await events({});
    assert.ok(requested.some((target) => !target.includes("since=") && target.includes("limit=200")), requested.join(" "));
  });
});
