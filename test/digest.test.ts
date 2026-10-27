// The digest line that begins every MCP tool response: its wording (summarize), its cursor (Digest),
// the replay of the real 10-25 death loop, and the shipped surface (the MCP server over stdio against a
// body whose event log gains events between two tool calls).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventLog } from "../src/body/events.ts";
import { Digest, summarize } from "../src/client/digest.ts";
import type { BodyEvent, BodyFeatures, EventsResponse } from "../src/protocol/index.ts";

const PREFIX = "[since your last call] ";

let seq = 0;
const ev = (type: string, data: Record<string, unknown> = {}): BodyEvent => ({ seq: ++seq, time: 0, type, data });
const death = (x: number, y: number, z: number, cause?: string) => ev("death", { position: { x, y, z }, ...(cause === undefined ? {} : { cause }) });
const spawn = (x: number, y: number, z: number) => ev("spawn", { position: { x, y, z } });
const line = (events: BodyEvent[]) => summarize(events).line;

describe("summarize: the digest's wording", () => {
  it("says nothing when nothing high-signal happened", () => {
    const noise = [
      ev("hurt", { health: 3, food: 20 }),
      ev("block_broken", { name: "stone" }),
      ev("low_health", { health: 3 }),
      ev("low_oxygen", { oxygen: 9 }),
      ev("chat", { from: "x", message: "hi" }),
      ev("hostile_near", { name: "zombie" }),
      ev("item_picked_up", { name: "dirt" }),
      ev("spawn", { position: { x: 1, y: 2, z: 3 } }),
      ev("disconnected", { reason: "socketClosed" }),
    ];
    assert.equal(line(noise), undefined);
    assert.equal(line([]), undefined);
  });

  it("names one death, its cause without the player's name, its place floored, and the respawn with its distance", () => {
    assert.equal(
      line([death(-286.36, 42, 104.64, "Fartmastery drowned"), spawn(-517.5, 76, 105.5)]),
      `${PREFIX}died once: drowned at -287 42 104, respawned at -518 76 105 (234 blocks away)`,
    );
    assert.equal(line([death(10.9, 64, -0.5, "Fartmastery fell from a high place"), spawn(11.5, 64, -0.5)]), `${PREFIX}died once: fell from a high place at 10 64 -1, respawned at 11 64 -1 (1 block away)`);
  });

  it("counts several deaths, and gives the breakdown only when the causes differ", () => {
    assert.equal(
      line([death(0, 10, 0, "P drowned"), spawn(0, 80, 0), death(5, 20, 5, "P drowned"), spawn(0, 80, 0)]),
      `${PREFIX}died 2 times, last: drowned at 5 20 5, respawned at 0 80 0 (60 blocks away)`,
    );
    assert.equal(
      line([death(0, 10, 0, "P drowned"), death(1, 10, 0, "P fell from a high place"), death(2, 10, 0, "P drowned"), death(3, 10, 0, "P was slain by Zombie")]),
      `${PREFIX}died 4 times (drowned 2, fell from a high place 1, was slain by Zombie 1), last: was slain by Zombie at 3 10 0`,
    );
  });

  it("reads an absent cause as unknown", () => {
    assert.equal(line([death(1.5, 2, 3)]), `${PREFIX}died at 1 2 3`);
    assert.equal(line([death(1, 2, 3), death(4, 5, 6)]), `${PREFIX}died 2 times, last at 4 5 6`);
    assert.equal(line([death(1, 2, 3, "P drowned"), death(4, 5, 6)]), `${PREFIX}died 2 times (drowned 1, unknown 1), last at 4 5 6`);
  });

  it("pairs a respawn with the last death only, and ignores a spawn that follows no death", () => {
    assert.equal(line([spawn(0, 0, 0), death(3, 4, 0, "P drowned"), spawn(0, 0, 0), death(30, 40, 0, "P drowned")]), `${PREFIX}died 2 times, last: drowned at 30 40 0`);
    assert.equal(line([spawn(0, 0, 0), spawn(9, 9, 9)]), undefined);
  });

  it("carries a death whose respawn the window did not reach into the next window", () => {
    const first = summarize([death(0, 0, 0, "P drowned")]);
    assert.equal(first.line, `${PREFIX}died once: drowned at 0 0 0`);
    assert.deepEqual(first.awaitingRespawn, { x: 0, y: 0, z: 0 });
    const second = summarize([spawn(30, 40, 0)], first.awaitingRespawn);
    assert.equal(second.line, `${PREFIX}respawned at 30 40 0 (50 blocks away)`);
    assert.equal(second.awaitingRespawn, undefined);
  });

  it("adds disabled reflexes, host restarts, and kicks after the deaths, in that order, joined with '; '", () => {
    assert.equal(
      line([
        ev("kicked", { reason: "You were kicked for flying" }),
        ev("disconnected", { reason: "bot host restarted: the host crashed (exit 1): boom" }),
        ev("reflex_disabled", { name: "collect-loot", failures: 3, reason: "2 deaths in 10 minutes" }),
        ev("reflex_disabled", { name: "eat", failures: 3, reason: "failed 3 times" }),
        death(1, 2, 3, "P drowned"),
      ]),
      `${PREFIX}died once: drowned at 1 2 3; reflex collect-loot disabled: 2 deaths in 10 minutes; reflex eat disabled: failed 3 times; bot host restarted: the host crashed (exit 1): boom; kicked: You were kicked for flying`,
    );
  });

  it("keeps the line one line, and bounded", () => {
    const text = line([ev("kicked", { reason: `first\nsecond\n\n${"x".repeat(1000)}` })]);
    assert.ok(text !== undefined && !text.includes("\n") && text.startsWith(`${PREFIX}kicked: first second xxx`) && text.length < 300, String(text));
  });
});

/** The real events of 2026-10-25 15:59-16:23: 8 drownings at the same spot, 626 hurts. */
const WINDOW = readFileSync(path.join(import.meta.dirname, "fixtures", "death-loop-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as BodyEvent);

describe("replay: the 8-death loop of seq 5400-6115", () => {
  it("is the real window", () => {
    assert.equal(WINDOW.length, 716);
    assert.equal(WINDOW[0]!.seq, 5400);
    assert.equal(WINDOW.at(-1)!.seq, 6115);
    assert.equal(WINDOW.filter((e) => e.type === "death").length, 8);
    assert.equal(WINDOW.filter((e) => e.type === "hurt").length, 626);
  });

  it("yields one line that counts all 8 deaths, as the artifact has them (no cause recorded)", () => {
    const text = summarize(WINDOW).line!;
    assert.equal(text, `${PREFIX}died 8 times, last at -287 42 104, respawned at -519 177 89 (269 blocks away)`);
  });

  it("names the cause once the death event carries the server's message (the system line before each death)", () => {
    let message: string | undefined;
    const enriched = WINDOW.map((e) => {
      if (e.type === "system") message = e.data.message as string;
      return e.type === "death" ? { ...e, data: { ...e.data, cause: message } } : e;
    });
    const text = summarize(enriched).line!;
    assert.equal(text, `${PREFIX}died 8 times, last: drowned at -287 42 104, respawned at -519 177 89 (269 blocks away)`);
    assert.ok(!/hurt|low_health|item_picked_up|health|food/.test(text), text);
    assert.ok(!text.includes("\n"));
  });
});

/** A scripted event source over a log with one `body` id. */
class Log {
  body: string | undefined;
  events: BodyEvent[] = [];
  requests: [number, number][] = [];
  failing = false;
  /** Fails the nth request (1-based) from now on, once. */
  failAt = 0;
  #seq = 0;
  constructor(body?: string) {
    this.body = body;
  }
  push(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ seq: ++this.#seq, time: 0, type, data, ...(this.body === undefined ? {} : { body: this.body }) } as BodyEvent);
  }
  restart(body?: string): void {
    this.body = body;
    this.events = [];
    this.#seq = 0;
  }
  async read(since: number, limit: number): Promise<EventsResponse> {
    this.requests.push([since, limit]);
    if (this.failing || this.requests.length === this.failAt) throw new Error("cannot reach body");
    const from = since > this.#seq ? 0 : since;
    const events = this.events.filter((e) => e.seq > from).slice(0, limit);
    return { events, next: events.at(-1)?.seq ?? from };
  }
  digest(): Digest {
    return new Digest(async () => ({ events: (since, limit) => this.read(since, limit) }));
  }
}

describe("Digest: the cursor", () => {
  it("starts at the log's end at first contact, and reports only what came after, once", async () => {
    const log = new Log("a");
    log.push("death", { position: { x: 0, y: 0, z: 0 }, cause: "P drowned" });
    log.push("kicked", { reason: "before" });
    const digest = log.digest();
    await digest.start();
    assert.equal(await digest.take(), undefined);
    log.push("hurt", { health: 1 });
    assert.equal(await digest.take(), undefined);
    log.push("death", { position: { x: 1, y: 2, z: 3 }, cause: "P fell from a high place" });
    assert.equal(await digest.take(), `${PREFIX}died once: fell from a high place at 1 2 3`);
    assert.equal(await digest.take(), undefined);
  });

  it("does not move the start once made", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    log.push("kicked", { reason: "r" });
    await digest.start();
    assert.equal(await digest.take(), `${PREFIX}kicked: r`);
  });

  it("starts at the first successful contact: a body that was down at first adds no line, then marks its end", async () => {
    const log = new Log("a");
    log.push("kicked", { reason: "before contact" });
    log.failing = true;
    const digest = log.digest();
    await digest.start();
    assert.equal(await digest.take(), undefined);
    log.failing = false;
    await digest.start();
    log.push("kicked", { reason: "after contact" });
    assert.equal(await digest.take(), `${PREFIX}kicked: after contact`);
  });

  it("reads to the log's end, a page at a time", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    for (let i = 0; i < 2500; i++) log.push("hurt", { health: 1 });
    log.push("death", { position: { x: 1, y: 2, z: 3 }, cause: "P drowned" });
    for (let i = 0; i < 1500; i++) log.push("hurt", { health: 1 });
    log.requests.length = 0;
    assert.equal(await digest.take(), `${PREFIX}died once: drowned at 1 2 3`);
    assert.deepEqual(log.requests, [[0, 1000], [1000, 1000], [2000, 1000], [3000, 1000], [4000, 1000]]);
    assert.equal(await digest.take(), undefined);
  });

  it("keeps the cursor when a fetch fails, and adds no line", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    log.push("kicked", { reason: "r" });
    log.failing = true;
    assert.equal(await digest.take(), undefined);
    log.failing = false;
    assert.equal(await digest.take(), `${PREFIX}kicked: r`);
  });

  it("keeps the cursor when a later page fails", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    log.push("kicked", { reason: "r" });
    for (let i = 0; i < 1200; i++) log.push("hurt", { health: 1 });
    log.requests.length = 0;
    log.failAt = 2;
    assert.equal(await digest.take(), undefined);
    assert.equal(await digest.take(), `${PREFIX}kicked: r`);
  });

  it("re-reads a restarted log from seq 0 when its body id changed, even when it is longer than the cursor", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    log.push("hurt");
    await digest.take();
    log.restart("b");
    log.push("kicked", { reason: "first of the new log" });
    for (let i = 0; i < 20; i++) log.push("hurt");
    assert.equal(await digest.take(), `${PREFIX}kicked: first of the new log`);
    log.push("kicked", { reason: "later" });
    assert.equal(await digest.take(), `${PREFIX}kicked: later`);
  });

  it("re-reads a restarted log from the start when the body shows it only by the cursor being ahead", async () => {
    const log = new Log();
    const digest = log.digest();
    await digest.start();
    for (let i = 0; i < 5; i++) log.push("hurt");
    await digest.take();
    log.restart();
    log.push("kicked", { reason: "new log" });
    assert.equal(await digest.take(), `${PREFIX}kicked: new log`);
  });

  it("pairs a respawn that lands in the next window with the death before it", async () => {
    const log = new Log("a");
    const digest = log.digest();
    await digest.start();
    log.push("death", { position: { x: 0, y: 0, z: 0 }, cause: "P drowned" });
    assert.equal(await digest.take(), `${PREFIX}died once: drowned at 0 0 0`);
    log.push("spawn", { position: { x: 0, y: 0, z: 100 } });
    assert.equal(await digest.take(), `${PREFIX}respawned at 0 0 100 (100 blocks away)`);
  });
});

const FEATURES: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move"] };
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const DOC = "the program reference";

describe("minebot mcp: every response begins with the digest", () => {
  let server: Server;
  let url: string;
  const log = new EventLog();
  before(async () => {
    server = createServer((req, res) => {
      const target = new URL(req.url ?? "/", "http://stub");
      res.setHeader("content-type", "application/json");
      if (target.pathname === "/events") {
        res.end(JSON.stringify(log.since(Number(target.searchParams.get("since")), Number(target.searchParams.get("limit")))));
      } else if (target.pathname === "/runs") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "no run has finished yet" }));
      } else {
        res.end(JSON.stringify(target.pathname === "/features" ? FEATURES : { doc: DOC }));
      }
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await promise;
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("adds the line to the first response after the event, ok or error, and to no other", async () => {
    // Events before the MCP process's first contact never appear.
    log.push("death", { position: { x: 9, y: 9, z: 9 }, cause: "Fartmastery was shot by Skeleton" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const text = async (name: string) => {
      const result = await client.callTool({ name, arguments: {} });
      return { text: (result.content as { text: string }[])[0]!.text, isError: result.isError === true };
    };
    try {
      assert.deepEqual(await text("api_reference"), { text: DOC, isError: false });

      log.push("hurt", { health: 4, food: 20 });
      log.push("low_health", { health: 4 });
      log.push("death", { position: { x: -286.5, y: 42, z: 104.5 }, cause: "Fartmastery drowned" });
      log.push("spawn", { position: { x: -517.5, y: 76, z: 105.5 } });
      log.push("block_broken", { name: "stone" });
      assert.deepEqual(await text("api_reference"), { text: `${PREFIX}died once: drowned at -287 42 104, respawned at -518 76 105 (233 blocks away)\n${DOC}`, isError: false });
      assert.deepEqual(await text("api_reference"), { text: DOC, isError: false });

      log.push("kicked", { reason: "Flying is not enabled" });
      log.push("reflex_disabled", { name: "collect-loot", failures: 2, reason: "2 deaths in 10 minutes" });
      assert.deepEqual(await text("get_run"), {
        text: `${PREFIX}reflex collect-loot disabled: 2 deaths in 10 minutes; kicked: Flying is not enabled\nno run has finished yet`,
        isError: true,
      });
      assert.deepEqual(await text("get_run"), { text: "no run has finished yet", isError: true });
    } finally {
      await client.close();
    }
  });
});
