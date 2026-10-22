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

const EVERYTHING: BodyFeatures = { kits: ["move"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move"] };
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

const CORE = ["api_reference", "bind_routine", "builtin_docs", "call_routine", "get_events", "kit_docs", "observe", "run_program", "stop_program", "wait_for"];
const ROUTINE_TOOLS = ["bind_routine", "call_routine", "list_routines", "routine_revert", "routine_save", "routine_source", "routine_versions", "unbind_routine"];
const BUILTIN_TOOLS = ["builtin_docs", "builtin_search", "builtin_source", "list_builtins"];
const FULL = [
  ...CORE,
  "kit_remove", "kit_revert", "kit_save", "kit_search", "kit_source", "kit_try", "kit_versions", "list_kits",
  "notes_delete", "notes_list", "notes_set", "send_chat", "status",
  "use_kits",
  "wiki_add_lesson", "wiki_list", "wiki_read", "wiki_search",
  "list_routines", "routine_revert", "routine_save", "routine_source", "routine_versions", "unbind_routine",
  "builtin_search", "builtin_source", "list_builtins",
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

  it("serves no routine tool but the call of a built-in, in either set, for a body without routines", async () => {
    const { server, url: bare } = await stubBody({ ...EVERYTHING, routines: false });
    try {
      for (const args of [[], ["--tools", "full"]]) {
        const served = await tools(bare, ...args);
        // The call of a built-in is served wherever the body offers built-ins, with a library or without.
        assert.deepEqual(served.filter((name) => ROUTINE_TOOLS.includes(name)), ["call_routine"], args.join(" "));
      }
    } finally {
      server.close();
    }
  });

  it("serves the built-in tools exactly when the body offers built-ins, builtin_docs in the core set and the rest with --tools full", async () => {
    const { server, url: none } = await stubBody({ ...EVERYTHING, builtins: [] });
    try {
      for (const args of [[], ["--tools", "full"]]) {
        assert.deepEqual((await tools(none, ...args)).filter((name) => BUILTIN_TOOLS.includes(name)), [], `no built-ins, ${args.join(" ")}`);
        assert.deepEqual((await tools(url, ...args)).filter((name) => BUILTIN_TOOLS.includes(name)), args.length === 0 ? ["builtin_docs"] : BUILTIN_TOOLS, `built-ins, ${args.join(" ")}`);
      }
    } finally {
      server.close();
    }
  });
});
