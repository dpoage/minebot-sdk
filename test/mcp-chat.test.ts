// send_chat over the real MCP surface against a whole fake body (see fixtures/host/fake-body.ts):
// speech never waits for the run slot — POST /chat is off it, unlike POST /call and POST /run —
// and `to` composes the /msg whisper in the MCP handler, before the POST the body sees.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RunResult } from "../src/protocol/index.ts";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
/** Gives the fake player a chat that records what the body sends, as the routines' own patches do; installing it clears the log. */
const RECORDER =
  "export default (ctx: { bot: Record<string, unknown> }) => {\n" +
  "  ctx.bot.sent = [];\n" +
  "  ctx.bot.chat = (message: string) => {\n" +
  "    ctx.bot.sent = [...((ctx.bot.sent as string[] | undefined) ?? []), message];\n" +
  "  };\n" +
  "};\n";
/** Reads back what the recorder has seen. */
const SENT = "export default (ctx: { bot: { sent?: string[] } }) => ctx.bot.sent ?? [];\n";

/** One MCP tool call: whether it errored, and its text. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const answer = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: answer.isError === true, text: answer.content[0]!.text };
}

after(removeScratch);

describe("the core send_chat tool against a whole body", () => {
  let body: FakeBody;
  let server: Server;
  let mcp: Client;

  before(async () => {
    body = await startFakeBody();
    // The body's API over HTTP, as the daemon's transport hands each request to the host.
    server = createServer(async (req, res) => {
      const raw = await text(req);
      const answer = await body.request(req.method!, req.url!, raw === "" ? undefined : JSON.parse(raw));
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env: { ...process.env, MINEBOT_URL: url, MINEBOT_TOKEN: "" } as Record<string, string>, stderr: "ignore" }));
  });
  after(async () => {
    await mcp.close();
    server.close();
    await body.close();
  });

  /** What the body has sent as chat so far. */
  async function sent(): Promise<string[]> {
    const run = (await body.ok("POST", "/run", { code: SENT })) as RunResult;
    assert.equal(run.status, "ok", run.error ?? "");
    return run.result as string[];
  }

  /** Resolves once the supervisor holds a run in flight and the host has had time to start its code. */
  async function running(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
    assert.ok(body.host.openRuns > 0, "no run reached the supervisor");
    await sleep(150);
  }

  it("speaks while a call holds the run slot: answered without waiting, the slot still held, the call keeps its own status", { timeout: 30_000 }, async () => {
    await body.ok("POST", "/run", { code: RECORDER });
    // social.waitForChat holds the run slot until the run's own timeout ends it (its args default
    // waits 60 s; the call-level timeout_ms cuts the run to 3 s here).
    const held = body.request("POST", "/call", { name: "social.waitForChat", timeoutMs: 3000 });
    await running();
    const started = Date.now();
    const answer = await call(mcp, "send_chat", { message: "hi there" });
    assert.ok(Date.now() - started < 2_000, `send_chat took ${Date.now() - started} ms`);
    assert.equal(answer.isError, false, answer.text);
    assert.deepEqual(JSON.parse(answer.text), { sent: true });
    // The slot is still held by waitForChat: any call is refused, so send_chat took no slot and stopped nothing.
    assert.equal((await body.request("POST", "/call", { name: "social.waitForChat", args: { timeoutMs: 1000 } })).status, 409);
    const finished = await held;
    assert.equal(finished.status, 200);
    assert.equal((finished.body as RunResult).status, "timeout", "the held call ends by its own timeout, not stopped");
    assert.deepEqual(await sent(), ["hi there"], "the bot's chat received exactly the message");
  });

  it("whispers with `to` as exactly `/msg <to> <message>`, and refuses what cannot fit or is not a player name", { timeout: 30_000 }, async () => {
    await body.ok("POST", "/run", { code: RECORDER });
    const whisper = await call(mcp, "send_chat", { to: "ana_1", message: "psst" });
    assert.equal(whisper.isError, false, whisper.text);
    // `/msg ana_1 ` is 11 characters, so 245 is the longest message that fits the 256-character chat limit.
    const longest = await call(mcp, "send_chat", { to: "ana_1", message: "x".repeat(245) });
    assert.equal(longest.isError, false, longest.text);
    assert.deepEqual(await sent(), ["/msg ana_1 psst", `/msg ana_1 ${"x".repeat(245)}`]);

    const over = await call(mcp, "send_chat", { to: "ana_1", message: "x".repeat(246) });
    assert.equal(over.isError, true, over.text);
    assert.match(over.text, /256/);
    assert.match(over.text, /245/);
    const notAName = await call(mcp, "send_chat", { to: "not a name!", message: "hi" });
    assert.equal(notAName.isError, true, notAName.text);
    assert.match(notAName.text, /player name/);
    assert.deepEqual(await sent(), ["/msg ana_1 psst", `/msg ana_1 ${"x".repeat(245)}`], "refused sends nothing");
  });
});
