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

const EVERYTHING: BodyFeatures = { kits: ["move"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true, routines: true };
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

const CORE = ["api_reference", "bind_routine", "call_routine", "get_events", "kit_docs", "observe", "run_program", "stop_program", "wait_for"];
const ROUTINE_TOOLS = ["bind_routine", "call_routine", "list_routines", "routine_revert", "routine_save", "routine_source", "routine_versions", "unbind_routine"];
const FULL = [
  ...CORE,
  "kit_remove", "kit_revert", "kit_save", "kit_search", "kit_source", "kit_try", "kit_versions", "list_kits",
  "notes_delete", "notes_list", "notes_set", "send_chat", "status",
  "trigger_add", "trigger_list", "trigger_remove", "trigger_set_enabled", "use_kits",
  "wiki_add_lesson", "wiki_list", "wiki_read", "wiki_search",
  "list_routines", "routine_revert", "routine_save", "routine_source", "routine_versions", "unbind_routine",
].sort();

/** A body that answers the feature probe with `features`; its URL, and a way to stop it. */
async function stubBody(features: BodyFeatures): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/features" ? features : { doc: "the program reference" }));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function tools(url: string, ...args: string[]): Promise<string[]> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp", ...args], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

describe("minebot mcp tool sets", () => {
  let body: Server;
  let url: string;
  before(async () => {
    ({ server: body, url } = await stubBody(EVERYTHING));
  });
  after(() => body.close());

  it("serves the core tools by default, with notes, status, and chat left to programs", async () => {
    assert.deepEqual(await tools(url), CORE);
  });

  it("serves every tool the body's features allow with --tools full", async () => {
    assert.deepEqual(await tools(url, "--tools", "full"), FULL);
  });

  it("serves no routine tool, in either set, for a body without routines", async () => {
    const { server, url: bare } = await stubBody({ ...EVERYTHING, routines: false });
    try {
      for (const args of [[], ["--tools", "full"]]) {
        const served = await tools(bare, ...args);
        assert.deepEqual(served.filter((name) => ROUTINE_TOOLS.includes(name)), [], args.join(" "));
      }
    } finally {
      server.close();
    }
  });
});
