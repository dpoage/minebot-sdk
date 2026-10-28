// P1.4: one catalog lists every event type the body pushes. This scans src/ for the literal type
// every events push names, so a new push without a catalog row (or a stale row) fails, and it holds
// the three tool descriptions to the catalog so an agent can discover the types without guessing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EVENT_TYPES } from "../src/protocol/event-types.ts";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(entryPath);
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

/** The first argument of the call whose `(` ends at `open`, as written, up to the top-level `,` or `)`. */
function firstArgument(source: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (quote !== "") {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return source.slice(open, i).trim();
      depth--;
    } else if (char === "," && depth === 0) return source.slice(open, i).trim();
  }
  throw new Error(`unterminated push call at ${open}`);
}

/** `<receiver>.push(` where the receiver is an event sink: the bare `events` parameter, or a member ending in `.events`. */
const PUSH_SITE = /(?:^|[^\w$.])((?:this\.#?[\w$]+\.events|this\.#?[\w$]*events|[\w$]+\.events|events))\.push\(/g;

describe("the event type catalog", () => {
  it("holds exactly the literal types the body pushes in src/", () => {
    const pushed = new Set<string>();
    const nonLiteral: string[] = [];
    let relays = 0;
    for (const file of sources(SRC)) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(ROOT, file);
      for (const match of source.matchAll(PUSH_SITE)) {
        const open = match.index + match[0].length;
        const argument = firstArgument(source, open);
        const line = source.slice(0, match.index).split("\n").length;
        if (argument.startsWith("...")) continue; // array concatenation, not an event type
        const literal = /^"(?:[^"\\]|\\.)*"$/.test(argument)
          ? argument.slice(1, -1)
          : /^'(?:[^'\\]|\\.)*'$/.test(argument)
            ? argument.slice(1, -1)
            : undefined;
        if (literal !== undefined) {
          pushed.add(literal);
          continue;
        }
        // The supervisor relays the host's events; the host's own pushes are literal and scanned here.
        if (relative === "src/body/host-process.ts" && argument === "message.type") {
          relays++;
          continue;
        }
        nonLiteral.push(`${relative}:${line} pushes ${argument}, not a string literal`);
      }
    }
    assert.deepEqual(nonLiteral, [], "every events push must name its type as a string literal");
    assert.equal(relays, 1, "the host relay is the only non-literal push, and there is one");
    assert.deepEqual([...pushed].sort(), Object.keys(EVENT_TYPES).sort(), "the pushed types and the catalog's keys differ");
  });
});

const FEATURES = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move"] };
const CLI = [...process.execArgv, path.join(ROOT, "src", "cli.ts")];

describe("the event tools' descriptions", () => {
  let body: Server;
  let mcp: Client;
  const described = new Map<string, string>();

  before(async () => {
    body = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/features" ? FEATURES : { doc: "the program reference" }));
    });
    await new Promise<void>((resolve) => body.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(body.address() as AddressInfo).port}`;
    mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(
      new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env: { ...process.env, MINEBOT_URL: url } as Record<string, string>, stderr: "ignore" }),
    );
    for (const tool of (await mcp.listTools()).tools) described.set(tool.name, tool.description ?? "");
  });
  after(async () => {
    await mcp.close();
    body.close();
  });

  it("wait_for, get_events and bind_routine list exactly the catalog's types, generated", () => {
    const expected = `Event types: ${Object.keys(EVENT_TYPES).join(", ")}.`;
    for (const name of ["wait_for", "get_events", "bind_routine"]) {
      const description = described.get(name);
      assert.ok(description !== undefined, `${name} is served`);
      assert.ok(description!.endsWith(expected), `${name} does not end in the catalog's list:\n${description}`);
      assert.doesNotMatch(description!, /\.\.\./, `${name} still abbreviates its list`);
    }
  });
});
