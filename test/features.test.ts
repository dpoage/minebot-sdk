import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { BodyClient } from "../src/client/client.ts";
import { toolPlan } from "../src/client/mcp.ts";
import { z } from "zod";
import { type BodyFeatures, programApiDoc } from "../src/protocol/index.ts";
import { usageFor } from "../src/client/usage.ts";
import { defineRoutine } from "../src/routine/define.ts";
import { createHarness } from "../src/testing/index.ts";
import { OPERATOR_FLAG_HELP } from "../src/client/body-flags.ts";

const exec = promisify(execFile);

const ROUTINE_MODULES = ["gatherer", "crafter", "builder", "explorer", "social"];
/** What --builtins with the routine modules offers: the modules they use come along automatically. */
const OFFERED_MODULES = ["move", "sense", "dig", "place", "inventory", "craft", "items", "furnace", ...ROUTINE_MODULES];
const raw: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };
const builtinsTier: BodyFeatures = { ...raw, builtins: OFFERED_MODULES };
const wikiTier: BodyFeatures = { ...raw, wiki: "read" };
const full: BodyFeatures = { ...builtinsTier, wiki: "read" };

/** The kits are gone: no tier, on any surface, says the word. */
const KIT_WORDS = /\bkits?\b/i;
const BUILTIN_WORDS = /built-in|builtin/i;
const WIKI_WORDS = /\bwiki\b|\blessons?\b/i;
const MILESTONE_WORDS = /milestone/i;

describe("tier visibility in the usage text", () => {
  it("shows a raw body nothing about built-ins, the wiki, lessons, or milestones", () => {
    for (const hasBody of [false, true]) {
      const text = usageFor(raw, hasBody);
      assert.doesNotMatch(text, BUILTIN_WORDS);
      assert.doesNotMatch(text, WIKI_WORDS);
      assert.doesNotMatch(text, MILESTONE_WORDS);
      assert.doesNotMatch(text, /trigger/i);
      assert.doesNotMatch(text, /routine|\bbind\b|unbind|call <name>|call: {3}--args/i);
      // Every body's run takes args, a module's default function being called with them.
      assert.match(text, /^ {2}run: {4}--args <json>, --timeout <ms>$/m);
      assert.doesNotMatch(text, /--wiki|--lessons|--milestones|body:/);
    }
  });

  it("shows each tier only its own features", () => {
    assert.match(usageFor(builtinsTier, false), /builtins docs/);
    assert.doesNotMatch(usageFor(builtinsTier, false), /wiki|lesson/i);
    assert.match(usageFor(wikiTier, false), /wiki search/);
    assert.doesNotMatch(usageFor(wikiTier, false), /built-in|builtins|lesson/i);
    assert.match(usageFor(full, false), /builtins docs/);
    assert.match(usageFor(full, false), /wiki read/);
    assert.doesNotMatch(usageFor(full, false), /wiki lesson/);
    for (const tier of [raw, builtinsTier, wikiTier, full]) assert.doesNotMatch(usageFor(tier, false), KIT_WORDS);
  });

  it("lists the routine commands exactly when the body offers routines, and `bind reflex` only with reflexes too", () => {
    const COMMANDS = [/routines save <file\.\.\.>/, /routines source\|versions <name>/, /routines revert <name> <n>/, /bind action <name> <routine>/, /unbind <name>/, /call <name>/, /call: {3}--args <json>, --timeout <ms>/];
    const REFLEX = /bind reflex <name> <routine> --on <a,b>[\s\S]*--priority, --preempt/;
    for (const routines of [false, true]) {
      for (const reflexes of [false, true]) {
        for (const hasBody of [false, true]) {
          const text = usageFor({ ...raw, routines, reflexes }, hasBody);
          const label = `routines ${routines}, reflexes ${reflexes}, hasBody ${hasBody}`;
          for (const command of COMMANDS) assert.equal(command.test(text), routines, `${command} with ${label}`);
          assert.equal(REFLEX.test(text), routines && reflexes, `bind reflex with ${label}`);
          if (!routines) assert.doesNotMatch(text, /routine|\bbind\b|reflex/i, label);
          if (!reflexes) assert.doesNotMatch(text, /reflex|trigger|--cooldown/i, label);
        }
      }
    }
    // Nothing known: an operator reads about everything, a client-only install about nothing optional.
    assert.match(usageFor(null, true, OPERATOR_FLAG_HELP), /bind reflex <name> <routine>/);
    assert.doesNotMatch(usageFor(null, false), /routine|bind/i);
  });

  it("shows an operator everything when no body can be asked", () => {
    const text = usageFor(null, true, OPERATOR_FLAG_HELP);
    for (const word of ["body ", "--no-milestones", "--no-reflexes", "--no-routines", "--builtins", "wiki lesson"]) {
      assert.match(text, new RegExp(word.replace(/[-]/g, "\\-")));
    }
    assert.doesNotMatch(text, KIT_WORDS);
    assert.doesNotMatch(text, /--kits|--lock-kits|--agent-kits|--no-agent-kits/);
    assert.doesNotMatch(usageFor(null, false), /built-in|wiki|milestones/i);
  });
});

describe("tier visibility in the program reference", () => {
  it("lists only the globals the body offers", () => {
    const rawDoc = programApiDoc(raw);
    assert.doesNotMatch(rawDoc, BUILTIN_WORDS);
    assert.doesNotMatch(rawDoc, WIKI_WORDS);
    assert.doesNotMatch(rawDoc, MILESTONE_WORDS);
    assert.match(rawDoc, /status\(\): resolves to \{ deaths, reconnects \}\./);
    assert.match(programApiDoc(builtinsTier), /^Built-in routines: move, sense/m);
    assert.doesNotMatch(programApiDoc(builtinsTier), /wiki/);
    assert.match(programApiDoc(wikiTier), /- wiki: .*wiki\.read\(id\)/);
    assert.doesNotMatch(programApiDoc(wikiTier), BUILTIN_WORDS);
    assert.doesNotMatch(programApiDoc(wikiTier), /lessons|addLesson/);
    assert.match(programApiDoc({ ...wikiTier, wiki: "write", lessons: true }), /lessons that agents wrote.*addLesson/);
    for (const tier of [raw, builtinsTier, wikiTier, full]) assert.doesNotMatch(programApiDoc(tier), /\bkits?\b|\bkit\./i);
    assert.match(programApiDoc({ ...raw, milestones: true }), /progress toward this body's milestones/);
  });
});

describe("tier visibility on a running body", () => {
  /** The node arguments that run the CLI: this run's own flags (`--conditions=minebot-sdk:source`) carry over, so the CLI resolves `minebot-sdk/routine` to the source tree too. */
  const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
  const runtime = mkdtempSync(path.join(tmpdir(), "minebot-features-"));
  const children: ChildProcess[] = [];

  /** Starts `minebot body` against a port where no server listens: the body serves its API and keeps trying to connect. */
  async function start(name: string, ...flags: string[]): Promise<BodyClient> {
    const env = { ...process.env, MINEBOT_RUNTIME_DIR: runtime };
    const stateDir = path.join(runtime, `${name}-state`);
    const child = spawn(
      "node",
      [...CLI, "body", "--bot", name, "--host", "127.0.0.1", "--port", "1", "--state", stateDir, "--lessons", path.join(stateDir, "lessons"), ...flags],
      { env, stdio: "ignore" },
    );
    children.push(child);
    const file = path.join(runtime, `${name}.json`);
    for (let i = 0; i < 100 && !existsSync(file); i++) await setTimeout(100);
    return new BodyClient(JSON.parse(readFileSync(file, "utf8")));
  }

  /** Runs the CLI as an agent would: pointed at a body by URL and token. */
  async function cli(client: BodyClient, ...args: string[]): Promise<{ code: number; out: string }> {
    const env = { ...process.env, MINEBOT_RUNTIME_DIR: runtime, MINEBOT_URL: client.endpoint.url, MINEBOT_TOKEN: client.endpoint.token };
    try {
      const { stdout, stderr } = await exec("node", [...CLI, ...args], { env });
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      const failed = err as { code: number; stdout: string; stderr: string };
      return { code: failed.code, out: failed.stdout + failed.stderr };
    }
  }

  let rawBody: BodyClient;
  let fullBody: BodyClient;
  before(async () => {
    [rawBody, fullBody] = await Promise.all([
      start("features-raw", "--wiki", "off", "--no-milestones", "--no-reflexes", "--no-routines", "--builtins", "none"),
      start("features-full", "--wiki", "read", "--builtins", ROUTINE_MODULES.join(","), "--no-milestones"),
    ]);
  });
  after(() => {
    for (const child of children) child.kill("SIGTERM");
  });

  it("has no kits command, on a body with every feature or none: the word is an unknown command like any other", async () => {
    for (const body of [rawBody, fullBody]) {
      for (const args of [["kits"], ["kits", "docs"], ["kits", "use", "move"], ["kits", "save", "k.ts"]]) {
        const result = await cli(body, ...args);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.out, /^unknown command: kits\n/, args.join(" "));
      }
    }
  });

  it("refuses the flags of the kits as unknown flags, with no alias", async () => {
    for (const flag of [["--kits", "move"], ["--lock-kits"], ["--agent-kits", "./kits"], ["--no-agent-kits"]]) {
      await assert.rejects(
        exec("node", [...CLI, "body", "--bot", "features-old-flag", ...flag], { env: { ...process.env, MINEBOT_RUNTIME_DIR: runtime } }),
        (err: { stderr: string }) => err.stderr.includes(`Unknown option '${flag[0]}'`),
        flag.join(" "),
      );
    }
  });

  const get = (client: BodyClient, route: string) => fetch(new URL(route, client.endpoint.url), { headers: { authorization: `Bearer ${client.endpoint.token}` } });

  it("answers requests for a feature it lacks like requests for any unknown route", async () => {
    for (const route of ["/kits", "/kits/docs", "/kits/source?name=move", "/kits/save", "/wiki/list", "/wiki/search?q=logs", "/wiki/page?id=flows/first-day", "/milestones", "/triggers", "/routines", "/routines/source?name=act", "/routines/versions?name=act", "/bindings", "/builtins", "/builtins/docs", "/builtins/search?q=walk", "/builtins/source?name=move"]) {
      const res = await get(rawBody, route);
      assert.equal(res.status, 404, route);
      assert.equal(((await res.json()) as { error: string }).error, `no route for GET ${route.split("?")[0]}`);
    }
    const post = await fetch(new URL("/kits", fullBody.endpoint.url), {
      method: "POST",
      headers: { authorization: `Bearer ${fullBody.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ use: ["gatherer"] }),
    });
    assert.equal(post.status, 404, "the kits' routes are unknown on a body that offers everything too");
    await assert.rejects(rawBody.setMilestones({ milestones: [] }), /no route for PUT \/milestones/);
    await assert.rejects(rawBody.bind({ kind: "reflex", name: "t", routine: "act", on: ["hurt"] }), /no route for POST \/bind/);
    await assert.rejects(rawBody.addLesson({ title: "A lesson", body: "Some text here." }), /no route for POST \/wiki\/lessons/);
    for (const route of ["/routines/save", "/bind", "/unbind", "/call"]) {
      const res = await fetch(new URL(route, rawBody.endpoint.url), { method: "POST", headers: { authorization: `Bearer ${rawBody.endpoint.token}` }, body: "{ not json" });
      assert.equal(res.status, 404, route);
      assert.equal(((await res.json()) as { error: string }).error, `no route for POST ${route}`);
    }
    assert.equal((await rawBody.features()).routines, false);
  });

  it("keeps a body's routines in the directory --routines names, and creates it", async () => {
    const dir = path.join(runtime, "features-routines-dir");
    const body = await start("features-routines", "--wiki", "off", "--no-milestones", "--routines", dir);
    assert.equal((await body.features()).routines, true);
    assert.equal(existsSync(dir), true);
    const saved = await fetch(new URL("/routines/save", body.endpoint.url), {
      method: "POST",
      headers: { authorization: `Bearer ${body.endpoint.token}` },
      body: JSON.stringify({ name: "act", source: "export default () => 1;\n" }),
    });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(path.join(dir, "act.ts"), "utf8"), "export default () => 1;\n");
    assert.equal(existsSync(path.join(runtime, "features-routines-state", "routines")), false);
  });

  it("offers the modules --builtins names with the ones they use, to the CLI of that body and no other", async () => {
    const body = await start("features-builtins", "--wiki", "off", "--no-milestones", "--builtins", "gatherer");
    assert.deepEqual((await body.features()).builtins, ["move", "sense", "dig", "inventory", "items", "gatherer"]);
    const help = await cli(body, "--help");
    assert.match(help.out, /builtins docs \[module\.\.\.\]/);
    const docs = await cli(body, "builtins", "docs", "gatherer");
    assert.equal(docs.code, 0, docs.out);
    assert.match(docs.out, /^## gatherer\n.*\nUses: move, sense, dig, inventory, items\.\n### gatherer\.gather\(ctx, \{ /);
    const withheld = await cli(body, "builtins", "docs", "place");
    assert.equal(withheld.code, 1);
    assert.match(withheld.out, /unknown built-in module "place"; offered: move, sense, dig, inventory, items, gatherer/);
    assert.match((await cli(body, "builtins", "source", "move")).out, /^\/\/ The move routines:/);
    assert.deepEqual((await rawBody.features()).builtins, [], "--builtins none offers none");
    assert.doesNotMatch((await cli(rawBody, "--help")).out, /builtins/);
  });

  it("serves a blocking wait on every body", async () => {
    const res = await fetch(new URL("/wait", rawBody.endpoint.url), {
      method: "POST",
      headers: { authorization: `Bearer ${rawBody.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ types: ["chat"], timeoutMs: 1 }),
    });
    assert.equal(res.status, 200);
    const waited = (await res.json()) as { event: unknown; next: number; timedOut: boolean };
    assert.equal(waited.event, null);
    assert.equal(waited.timedOut, true);
    const bad = await fetch(new URL("/wait", rawBody.endpoint.url), {
      method: "POST",
      headers: { authorization: `Bearer ${rawBody.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ match: "a(" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /regular expression/);
  });

  it("prints the event or the timeout from the CLI wait command", async () => {
    const result = await cli(rawBody, "wait", "--types", "chat", "--timeout", "1");
    assert.equal(result.code, 0);
    assert.equal(result.out.trim(), "timed out");
    assert.match((await cli(fullBody, "--help")).out, /wait /);
  });

  it("reports a raw body's status, observation, features, and reference without the other features", async () => {
    assert.deepEqual(await rawBody.features(), raw);
    assert.doesNotMatch(JSON.stringify(await rawBody.status()), /milestone|kit|wiki/i);
    assert.doesNotMatch(JSON.stringify(await rawBody.observe()), /kits/);
    const { doc } = await rawBody.apiDoc();
    assert.doesNotMatch(doc, BUILTIN_WORDS);
    assert.doesNotMatch(doc, WIKI_WORDS);
    assert.doesNotMatch(doc, MILESTONE_WORDS);
    assert.doesNotMatch(doc, /trigger/i);
    assert.doesNotMatch(doc, /routine/i);
  });

  it("gives the CLI of a raw body no commands for features it lacks", async () => {
    const help = await cli(rawBody, "--help");
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.out, BUILTIN_WORDS);
    assert.doesNotMatch(help.out, /wiki|lesson|milestone|trigger/i);
    assert.doesNotMatch(help.out, /routine|\bbind\b|unbind/i);
    for (const command of ["kits", "kits docs", "wiki search logs", "milestones", "triggers", "routines", "routines save act.ts", "bind action act act", "unbind act", "call act"]) {
      const result = await cli(rawBody, ...command.split(" "));
      assert.equal(result.code, 1, command);
      assert.match(result.out, new RegExp(`^unknown command: ${command.split(" ")[0]}\\n`), command);
      // The first line repeats what the agent typed; the usage after it is the same as for --help.
      assert.equal(result.out.slice(result.out.indexOf("\n\n") + 2), help.out);
    }
    assert.match((await cli(rawBody, "status")).out, /^disconnected; body started \S+; deaths 0; reconnects \d+\n?$/);
  });

  it("serves a full body its built-ins and wiki, and nothing about milestones", async () => {
    assert.deepEqual((await fullBody.features()).builtins, OFFERED_MODULES);
    assert.deepEqual((await fullBody.builtins()).builtins.map((module) => module.name), OFFERED_MODULES);
    assert.ok((await fullBody.wikiSearch("pickaxe")).hits.length > 0);
    assert.match((await cli(fullBody, "--help")).out, /builtins docs[\s\S]*wiki search/);
    assert.doesNotMatch((await cli(fullBody, "--help")).out, /milestone/i);
    assert.match((await cli(fullBody, "builtins", "docs")).out, /## gatherer/);
    assert.match((await cli(fullBody, "wiki", "read", "flows/first-day")).out, /collect\(isLog/);
  });

  it("serves a body with reflexes its binding command and reference, and offers no code triggers: no route, command, flag, or word", async () => {
    assert.equal((await fullBody.features()).reflexes, true);
    assert.equal("triggers" in (await fullBody.features()), false);
    assert.match((await cli(fullBody, "--help")).out, /bind reflex <name> <routine> --on/);
    const { doc } = await fullBody.apiDoc();
    assert.match(doc, /Reflexes: POST \/bind/);
    assert.doesNotMatch(doc, /trigger/i);
    assert.doesNotMatch((await cli(fullBody, "--help")).out, /trigger/i);
    for (const [method, route] of [["GET", "/triggers"], ["POST", "/triggers"], ["POST", "/triggers/remove"], ["POST", "/triggers/enabled"]] as const) {
      const res = await fetch(new URL(route, fullBody.endpoint.url), { method, headers: { authorization: `Bearer ${fullBody.endpoint.token}`, "content-type": "application/json" }, ...(method === "POST" && { body: "{}" }) });
      assert.equal(res.status, 404, `${method} ${route}`);
      const { error } = (await res.json()) as { error: string };
      assert.equal(error, `no route for ${method} ${route}`);
    }
    const unknown = await cli(fullBody, "triggers");
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /^unknown command: triggers\n/);
    await assert.rejects(
      exec("node", [...CLI, "body", "--bot", "features-old-flag", "--no-triggers"], { env: { ...process.env, MINEBOT_RUNTIME_DIR: runtime } }),
      (err: { stderr: string }) => /Unknown option '--no-triggers'/.test(err.stderr),
    );
    assert.equal((await rawBody.features()).reflexes, false, "--no-reflexes turns them off");
    assert.deepEqual((await fullBody.bindings()).bindings, []);
    await fullBody.saveRoutine("react", "export default () => 1;\n");
    const bound = await cli(fullBody, "bind", "reflex", "react", "react", "--on", "hurt,night", "--when", "event.data.health < 8", "--cooldown", "0", "--preempt");
    assert.equal(bound.code, 0, bound.out);
    assert.match(bound.out, /^bound react {2}reflex of react {2}\[on\] {2}on hurt, night; when event\.data\.health < 8; preempts/);
    await assert.rejects(fullBody.bind({ kind: "reflex", name: "bad", routine: "react", on: ["reflex_fired"] }), /cannot listen to reflex events/);
    assert.deepEqual(await fullBody.unbind("react"), { unbound: "react" });
  });

  it("serves a body without built-ins and routines none of their content in the wiki", async () => {
    const wikiBody = await start("features-wiki", "--wiki", "read", "--no-milestones", "--builtins", "none", "--no-routines");
    const first = (await cli(wikiBody, "wiki", "read", "flows/first-day")).out;
    assert.match(first, /collect\(isLog/);
    assert.doesNotMatch(first, KIT_WORDS);
    assert.doesNotMatch((await cli(wikiBody, "wiki", "read", "flows/escape-underground")).out, KIT_WORDS);
    const search = (await cli(wikiBody, "wiki", "search", "gather logs")).out;
    assert.doesNotMatch(search, KIT_WORDS);
    assert.match((await cli(wikiBody, "wiki", "read", "minebot/kits")).out, /no wiki page/);
  });

  it("shows a body with built-ins only the modules it offers", async () => {
    const some = await start("features-some", "--wiki", "off", "--no-milestones", "--builtins", "gatherer");
    const offered = ["move", "sense", "dig", "inventory", "items", "gatherer"];
    assert.deepEqual((await some.builtins()).builtins.map((module) => module.name), offered);
    await assert.rejects(some.builtinDocs(["social"]), /unknown built-in module "social"/);
    const { doc } = await some.apiDoc();
    assert.match(doc, new RegExp(`^Built-in routines: ${offered.join(", ")}\\.`, "m"));
  });

  /** The front matter field the wiki's page view reads. */
  const FrontMatter = z.object({ requires: z.array(z.string()).default([]) });

  /** The ids of the pages under wiki/ that a body with these features serves: the pages whose `requires` the body has, read from the front matter on disk. */
  function pagesFor(features: Record<string, boolean>): string[] {
    const wikiDir = path.join(import.meta.dirname, "..", "wiki");
    const ids: string[] = [];
    for (const entry of readdirSync(wikiDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
      const file = path.join(entry.parentPath, entry.name);
      const { requires } = FrontMatter.parse(parseYaml(/^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))![1]!));
      if (requires.every((feature) => features[feature])) ids.push(path.relative(wikiDir, file).slice(0, -".md".length).split(path.sep).join("/"));
    }
    return ids.sort();
  }

  /** What no page may say to a body: the call shapes and tools of the kits and code triggers that are gone. */
  const STALE_PAGE_TEXT = /kit\.|kits\.|defineKit|trigger_/;

  /** The pages a body lists, and the ones among them whose served text says something stale. */
  async function served(body: BodyClient): Promise<{ ids: string[]; stale: string[] }> {
    const ids = (await body.wikiList()).pages.map((page) => page.id).sort();
    const stale: string[] = [];
    for (const id of ids) if (STALE_PAGE_TEXT.test((await body.wikiRead(id)).text)) stale.push(id);
    return { ids, stale };
  }

  it("serves a default body (routines on, no --builtins) every page its features fit, and no page that names the kits or the trigger tools", { timeout: 60_000 }, async () => {
    const body = await start("features-view-default", "--wiki", "read", "--no-milestones");
    const features = await body.features();
    assert.deepEqual([features.routines, features.reflexes, features.builtins.length > 0], [true, true, true]);
    const { ids, stale } = await served(body);
    assert.deepEqual(ids, pagesFor({ builtins: true, milestones: false, reflexes: true, routines: true }));
    assert.ok(ids.includes("minebot/routines"), "the routines page is served where routines are on");
    assert.deepEqual(stale, [], "pages whose served text names kit.*, kits.*, defineKit, or trigger_*");
  });

  it("serves a builtins-only body (--builtins, no routines) every page its features fit, and no page that names the kits or the trigger tools", { timeout: 60_000 }, async () => {
    const body = await start("features-view-builtins", "--wiki", "read", "--no-milestones", "--builtins", "gatherer", "--no-routines");
    const features = await body.features();
    assert.deepEqual([features.routines, features.builtins.length > 0], [false, true]);
    const { ids, stale } = await served(body);
    assert.deepEqual(ids, pagesFor({ builtins: true, milestones: false, reflexes: false, routines: false }));
    assert.ok(!ids.includes("minebot/routines"), "the routines page is hidden where routines are off");
    assert.deepEqual(stale, [], "pages whose served text names kit.*, kits.*, defineKit, or trigger_*");
  });
});

describe("what the references say about imports and require", () => {
  it("tells a run that paths and file: URLs fail to import, and does not say that every URL does", () => {
    const doc = programApiDoc({ ...raw, routines: true });
    assert.match(doc, /importing an absolute path, a `file:` URL, or a relative path to anything but a module of the library fails\./);
    assert.doesNotMatch(doc, /an absolute path, a URL,/);
    // The loader refuses a file: URL and an absolute path (module-run.test.ts); a data: or node: import is not refused, so the reference must not claim a URL import fails.
  });

  it("tells an agent that routine_save accepts require, which a saved routine has", () => {
    const { routine_save: save } = toolPlan({ ...raw, routines: true }, "full");
    assert.doesNotMatch(save!.description, /`require` does not work/);
    assert.match(save!.description, /`require` works too/);
  });
});

describe("what h.calls records", () => {
  const unnamed = defineRoutine({ args: z.object({}) }, () => 1);
  const named = defineRoutine({ name: "mine.one" }, () => 2);
  const plain = () => 3;

  it("records only the routine values named module.routine, nested calls included", async () => {
    const h = createHarness();
    const result = await h.run(async (ctx) => [await unnamed(ctx), await named(ctx, { a: 1 }), plain()]);
    assert.deepEqual(result, [1, 2, 3]);
    assert.deepEqual(h.calls, [{ kit: "mine", action: "one", args: { a: 1 } }]);
  });

  it("says so in the doc comments of the published harness types", () => {
    const source = readFileSync(path.join(import.meta.dirname, "..", "src", "testing", "index.ts"), "utf8");
    assert.match(source, /declared with a `module\.routine` name \(the built-in routines\)/);
    assert.match(source, /A routine value without such a name is not recorded\./);
    assert.match(source, /those named `module\.routine` are recorded in `calls`/);
    assert.doesNotMatch(source, /by import run with that scope and are recorded in `calls`/);
    assert.doesNotMatch(source, /each routine value it calls by import is observed/);
  });
});
