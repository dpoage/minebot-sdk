// P1.5: the core MCP tool set carries the notes and the built-in search, so an agent can write its
// notes and find a built-in without spending the run slot on run_program. Over the real MCP surface
// and a whole fake body, as mcp-chat.test.ts does (mb-znn.23).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeBody, removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

/** One MCP tool call: whether it errored, and its text. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const answer = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: answer.isError === true, text: answer.content[0]!.text };
}

after(removeScratch);

describe("the core MCP tool set: notes and built-in search", () => {
  let body: FakeBody;
  let server: Server;
  let mcp: Client;

  before(async () => {
    body = await startFakeBody();
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

  it("serves notes_list, notes_set and builtin_search without --tools full", async () => {
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of ["notes_list", "notes_set", "builtin_search"]) assert.ok(names.includes(name), `${name} is missing from ${names.join(", ")}`);
    // The tools a run's ctx covers stay out of the core set.
    for (const name of ["status", "notes_delete"]) assert.ok(!names.includes(name), `${name} is not core`);
  });

  it("writes and reads a note while a run holds the run slot", { timeout: 30_000 }, async () => {
    const held = body.request("POST", "/call", { name: "social.waitForChat", timeoutMs: 3000 });
    const deadline = Date.now() + 10_000;
    while (body.host.openRuns === 0 && Date.now() < deadline) await sleep(10);
    assert.ok(body.host.openRuns > 0, "no run reached the supervisor");

    const written = await call(mcp, "notes_set", { key: "plan", text: "dig here at 12 60 -3" });
    assert.equal(written.isError, false, written.text);
    const listed = await call(mcp, "notes_list", {});
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, /dig here at 12 60 -3/);
    // The slot is still held: another call is refused, so the note did not take or stop it.
    assert.equal((await body.request("POST", "/call", { name: "social.waitForChat", args: { timeoutMs: 1000 } })).status, 409);
    const finished = await held;
    assert.equal(finished.status, 200);
    const result: unknown = finished.body;
    assert.ok(typeof result === "object" && result !== null && "status" in result, JSON.stringify(result));
    assert.equal(result.status, "timeout", "the held call ends by its own timeout, not stopped");
  });
});
