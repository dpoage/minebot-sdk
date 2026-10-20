// The tool list an MCP client sees from `minebot mcp`, in each tool set, against a stub body that
// answers only the feature probe: what an agent's harness registers is what this asserts.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BodyFeatures } from "../src/protocol/index.ts";

const EVERYTHING: BodyFeatures = { kits: ["move"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true };
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

const CORE = ["api_reference", "get_events", "kit_docs", "observe", "run_program", "stop_program", "wait_for"];
const FULL = [
  ...CORE,
  "kit_remove", "kit_revert", "kit_save", "kit_search", "kit_source", "kit_try", "kit_versions", "list_kits",
  "notes_delete", "notes_list", "notes_set", "send_chat", "status",
  "trigger_add", "trigger_list", "trigger_remove", "trigger_set_enabled", "use_kits",
  "wiki_add_lesson", "wiki_list", "wiki_read", "wiki_search",
].sort();

describe("minebot mcp tool sets", () => {
  let body: Server;
  let url: string;
  before(async () => {
    body = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/features" ? EVERYTHING : { doc: "the program reference" }));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    body.listen(0, "127.0.0.1", resolve);
    await promise;
    url = `http://127.0.0.1:${(body.address() as AddressInfo).port}`;
  });
  after(() => body.close());

  async function tools(...args: string[]): Promise<string[]> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp", ...args], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    } finally {
      await client.close();
    }
  }

  it("serves the core tools by default, with notes, status, and chat left to programs", async () => {
    assert.deepEqual(await tools(), CORE);
  });

  it("serves every tool the body's features allow with --tools full", async () => {
    assert.deepEqual(await tools("--tools", "full"), FULL);
  });
});
