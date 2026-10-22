// A call is served where the body has routines (an action's name) or built-ins (a <module>.<routine>
// name), and each name is checked by its kind. For each of the four combinations of {routines} x
// {builtins}, every surface says exactly what is callable: the route and its errors, the MCP tool and
// its description and schema, the CLI command and its usage, and the program reference.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { text } from "node:stream/consumers";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callNameSchema, toolPlan } from "../src/client/mcp.ts";
import { usageFor } from "../src/client/usage.ts";
import { capabilities, programApiDoc, type BodyFeatures, type RunResult } from "../src/protocol/index.ts";
import { removeScratch, startFakeBody } from "./fixtures/host/fake-body.ts";

after(removeScratch);

const exec = promisify(execFile);
const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];

interface Cell {
  routines: boolean;
  builtins: boolean;
}
const CELLS: Cell[] = [
  { routines: true, builtins: true },
  { routines: true, builtins: false },
  { routines: false, builtins: true },
  { routines: false, builtins: false },
];
const label = (cell: Cell) => `routines ${cell.routines ? "on" : "off"}, built-ins ${cell.builtins ? "on" : "off"}`;

const featuresOf = ({ routines, builtins }: Cell): BodyFeatures => ({ wiki: "write", lessons: true, milestones: true, reflexes: true, routines, builtins: builtins ? ["move", "inventory"] : [] });

describe("what each surface says is callable, in each combination of routines and built-ins", () => {
  for (const cell of CELLS) {
    const callable = cell.routines || cell.builtins;
    const f = featuresOf(cell);

    it(`names the kinds of name a call takes, and nothing else: ${label(cell)}`, () => {
      assert.equal(capabilities(f).call, callable);

      // The MCP tool: present iff a call is served, in both tool sets; its description names the kinds it takes.
      for (const toolSet of ["core", "full"] as const) {
        const tool = toolPlan(f, toolSet).call_routine!;
        assert.equal(tool.enabled, callable, `${toolSet}: call_routine enabled`);
        if (!tool.enabled) continue;
        assert.equal(/bind_routine/.test(tool.description), cell.routines, `${toolSet}: action names in the description`);
        assert.equal(/<module>\.<routine>/.test(tool.description), cell.builtins, `${toolSet}: built-in names in the description`);
      }

      // The tool's schema accepts the names of the kinds the body can call and refuses the others.
      if (callable) {
        const schema = callNameSchema(capabilities(f));
        assert.equal(schema.safeParse("move.to").success, cell.builtins, "a built-in's call name");
        assert.equal(schema.safeParse("act").success, cell.routines, "an action's name");
      }

      // The CLI's usage: the command and its options line only where a call is served, saying which names it takes.
      const usage = usageFor(f, false);
      assert.equal(/^ {2}call [<]/m.test(usage), callable, "call command");
      assert.equal(/^ {2}call: /m.test(usage), callable, "call options");
      assert.equal(/^ {2}call <name> {10}Call the routine bound to name/m.test(usage), cell.routines, "action names in the usage");
      assert.equal(/<module>\.<routine>/.test(usage), cell.builtins, "built-in names in the usage");

      // The program reference: what a call is, and which names it takes.
      const doc = programApiDoc(f);
      assert.equal(/POST \/call \{/.test(doc), callable, "POST /call");
      assert.equal(/calls the routine bound to name/.test(doc), cell.routines, "action names in the reference");
      assert.equal(/POST \/call \{ name: "<module>\.<routine>"/.test(doc), cell.builtins, "built-in names in the reference");
      assert.equal(/A call is a run: one at a time with programs/.test(doc), callable, "what a call is");
    });
  }
});

describe("POST /call and its errors, in each combination of routines and built-ins", () => {
  const ECHO = "export default (_ctx: unknown, args: unknown) => args;\n";

  for (const cell of CELLS) {
    it(`serves the route and answers each kind of name by what the body keeps: ${label(cell)}`, { timeout: 30_000 }, async () => {
      const body = await startFakeBody({ init: { routines: cell.routines, ...(!cell.builtins && { builtins: [] }) }, stateFiles: cell.routines ? { "routines/echo.ts": ECHO } : {} });
      try {
        const features = (await body.ok("GET", "/features")) as BodyFeatures;
        assert.deepEqual([features.routines, features.builtins.length > 0], [cell.routines, cell.builtins]);
        const noRoute = { status: 404, body: { error: "no route for POST /call" } };

        // A dotted name needs built-ins and an offered module.
        const builtin = await body.request("POST", "/call", { name: "inventory.list" });
        if (cell.builtins) assert.deepEqual([builtin.status, (builtin.body as RunResult).status, (builtin.body as RunResult).result], [200, "ok", {}]);
        else assert.deepEqual(builtin, cell.routines ? { status: 404, body: { error: 'no built-in routine "inventory.list"' } } : noRoute);
        assert.deepEqual(await body.request("POST", "/call", { name: "move.nope" }), cell.builtins || cell.routines ? { status: 404, body: { error: 'no built-in routine "move.nope"' } } : noRoute);

        // A dot-free name needs routines: an action binding.
        const act = await body.request("POST", "/call", { name: "echo" });
        if (cell.routines) {
          assert.deepEqual(act, { status: 404, body: { error: 'no action bound to "echo"' } });
          await body.ok("POST", "/bind", { kind: "action", name: "echo", routine: "echo" });
          const bound = await body.request("POST", "/call", { name: "echo", args: { a: 1 } });
          assert.deepEqual([bound.status, (bound.body as RunResult).result], [200, { a: 1 }]);
        } else if (cell.builtins) {
          assert.equal(act.status, 404);
          assert.match((act.body as { error: string }).error, /^no action named "echo": this body has no routine library; built-in routines are called as <module>\.<routine>$/);
        } else {
          assert.deepEqual(act, noRoute);
        }
      } finally {
        await body.close();
      }
    });
  }
});

/** A body that answers the probes with `features` and every other request with a run, recording the requests. */
async function stubBody(features: BodyFeatures): Promise<{ url: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/features" || req.url === "/api") return void res.end(JSON.stringify(req.url === "/features" ? features : { doc: "the program reference" }));
    seen.push(`${req.method} ${req.url} ${raw}`);
    res.end(JSON.stringify({ status: "ok", durationMs: 1, logs: "", result: 1 }));
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

describe("`minebot call` and `call_routine`, in each combination of routines and built-ins", () => {
  for (const cell of CELLS) {
    it(`is a command and a tool exactly where a call is served, and the tool takes the names of the kinds the body can call: ${label(cell)}`, { timeout: 60_000 }, async () => {
      const callable = cell.routines || cell.builtins;
      const stub = await stubBody(featuresOf(cell));
      try {
        // The command.
        const run = await exec(process.execPath, [...CLI, "call", "move.to", "--args", "{}"], { env: { ...process.env, MINEBOT_URL: stub.url, MINEBOT_TOKEN: "" } }).then(
          () => 0,
          (error: { code: number }) => error.code,
        );
        assert.equal(run, callable ? 0 : 1, "minebot call");
        assert.deepEqual(stub.seen, callable ? ['POST /call {"name":"move.to","args":{}}'] : []);
        stub.seen.length = 0;

        // The tool.
        const transport = new StdioClientTransport({ command: process.execPath, args: [...CLI, "mcp"], env: { ...process.env, MINEBOT_URL: stub.url } as Record<string, string>, stderr: "ignore" });
        const client = new Client({ name: "test", version: "0" });
        await client.connect(transport);
        try {
          const served = (await client.listTools()).tools.map((tool) => tool.name).includes("call_routine");
          assert.equal(served, callable, "call_routine listed");
          if (callable) {
            for (const [name, accepted] of [["move.to", cell.builtins], ["act", cell.routines]] as const) {
              const answer = (await client.callTool({ name: "call_routine", arguments: { name } })) as { isError?: boolean };
              assert.equal(answer.isError !== true, accepted, `${name} through call_routine`);
            }
            assert.deepEqual(stub.seen, [cell.builtins && 'POST /call {"name":"move.to"}', cell.routines && 'POST /call {"name":"act"}'].filter(Boolean));
          }
        } finally {
          await client.close();
        }
      } finally {
        stub.server.close();
      }
    });
  }
});
