// P1.2's client: `minebot events` with no --since asks the body for the newest events, as the
// get_events tool does; a log larger than the 200 limit must not show its oldest page instead.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { EventLog } from "../src/body/events.ts";
import type { BodyFeatures } from "../src/protocol/index.ts";

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
const FEATURES: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };

// A body log larger than the default limit, so oldest-page and newest-page answers differ.
const log = new EventLog();
for (let i = 0; i < 300; i++) log.push("chat", { from: "ana", message: `payload-${i}` });

let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    const target = new URL(req.url ?? "/", "http://body");
    res.setHeader("content-type", "application/json");
    if (target.pathname === "/features") return void res.end(JSON.stringify(FEATURES));
    if (target.pathname === "/events") {
      // The daemon's rule: no cursor means the newest limit, a cursor the oldest after it.
      const since = target.searchParams.get("since");
      const limit = target.searchParams.get("limit");
      return void res.end(JSON.stringify(log.since(since === null ? undefined : Number(since), limit === null ? 200 : Number(limit))));
    }
    return void res.end(JSON.stringify({ doc: "the program reference" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function events(...args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [...CLI, "events", ...args], { env: { ...process.env, MINEBOT_URL: url, MINEBOT_TOKEN: "" } as Record<string, string> });
  return stdout;
}

describe("minebot events", () => {
  it("asks for the newest events when no --since is given", async () => {
    const out = await events();
    assert.match(out, /"payload-299"/, "the newest event is in the answer");
    assert.doesNotMatch(out, /"payload-0"/, "the oldest page is not what a no-cursor call returns");
  });

  it("still returns only events after --since", async () => {
    const cursor = log.since(0, 300).events[249]!.seq;
    const out = await events("--since", String(cursor));
    assert.match(out, /"payload-299"/);
    assert.doesNotMatch(out, /"payload-249"/, "the cursor's own event is behind it");
  });
});
