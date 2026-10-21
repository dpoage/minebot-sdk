import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { BodyClient } from "../src/client/client.ts";
import { type BodyFeatures, kitsOffered, programApiDoc } from "../src/protocol/index.ts";
import { usageFor } from "../src/client/usage.ts";
import { OPERATOR_FLAG_HELP } from "../src/client/body-flags.ts";

const exec = promisify(execFile);

const ROUTINE_KITS = ["gatherer", "crafter", "builder", "explorer", "social"];
/** What --locks with the routine kits offers: their used primitives come along automatically. */
const OFFERED_KITS = ["move", "sense", "dig", "place", "inventory", "craft", "items", "furnace", ...ROUTINE_KITS];
const raw: BodyFeatures = { kits: [], kitsLocked: true, agentKits: false, wiki: "off", lessons: false, milestones: false, triggers: false, routines: false };
const kitsTier: BodyFeatures = { ...raw, kits: OFFERED_KITS, agentKits: true };
const wikiTier: BodyFeatures = { ...raw, wiki: "read" };
const full: BodyFeatures = { ...kitsTier, wiki: "read" };

const KIT_WORDS = /\bkits?\b/i;
const WIKI_WORDS = /\bwiki\b|\blessons?\b/i;
const MILESTONE_WORDS = /milestone/i;

describe("tier visibility in the usage text", () => {
  it("shows a raw body nothing about kits, the wiki, lessons, or milestones", () => {
    for (const hasBody of [false, true]) {
      const text = usageFor(raw, hasBody);
      assert.doesNotMatch(text, KIT_WORDS);
      assert.doesNotMatch(text, WIKI_WORDS);
      assert.doesNotMatch(text, MILESTONE_WORDS);
      assert.doesNotMatch(text, /trigger/i);
      assert.doesNotMatch(text, /--kits|--lock-kits|--wiki|--lessons|--milestones|body:/);
    }
  });

  it("shows each tier only its own features", () => {
    assert.match(usageFor(kitsTier, false), /kits docs/);
    assert.doesNotMatch(usageFor(kitsTier, false), /kits use|wiki|lesson/i);
    assert.match(usageFor(wikiTier, false), /wiki search/);
    assert.doesNotMatch(usageFor(wikiTier, false), /kits?\b|lesson/i);
    assert.match(usageFor(full, false), /kits docs/);
    assert.match(usageFor(full, false), /wiki read/);
    assert.doesNotMatch(usageFor(full, false), /wiki lesson/);
  });

  it("shows an operator everything when no body can be asked", () => {
    const text = usageFor(null, true, OPERATOR_FLAG_HELP);
    for (const word of ["body ", "--no-agent-kits", "--no-milestones", "--no-triggers", "--no-routines", "kits use", "wiki lesson", "--lock-kits"]) {
      assert.match(text, new RegExp(word.replace(/[-]/g, "\\-")));
    }
    assert.doesNotMatch(usageFor(null, false), /kits|wiki|milestones/i);
  });
});

describe("tier visibility in the program reference", () => {
  it("lists only the globals the body offers", () => {
    const rawDoc = programApiDoc(raw);
    assert.doesNotMatch(rawDoc, KIT_WORDS);
    assert.doesNotMatch(rawDoc, WIKI_WORDS);
    assert.doesNotMatch(rawDoc, MILESTONE_WORDS);
    assert.match(rawDoc, /status\(\): resolves to \{ deaths, reconnects \}\./);
    assert.match(programApiDoc(kitsTier), /- kit: the active kits' actions, namespaced by kit \(move, sense/);
    assert.match(programApiDoc(kitsTier), /await kit\.move\.to\(\{ position: \[x, y, z\] \}\)/);
    assert.doesNotMatch(programApiDoc(kitsTier), /wiki/);
    assert.match(programApiDoc(wikiTier), /- wiki: .*wiki\.read\(id\)/);
    assert.doesNotMatch(programApiDoc(wikiTier), KIT_WORDS);
    assert.doesNotMatch(programApiDoc(wikiTier), /lessons|addLesson/);
    assert.match(programApiDoc({ ...wikiTier, wiki: "write", lessons: true }), /lessons that agents wrote.*addLesson/);
    assert.match(programApiDoc({ ...raw, kitsLocked: false, kits: ["move"] }), /kits\.use\("gatherer"\) to swap the active kits/);
    assert.doesNotMatch(programApiDoc({ ...kitsTier, agentKits: false }), /kits\.save|kits\.remove|kits\.source|your own kits/i);
    assert.match(programApiDoc({ ...kitsTier }), /kits\.save\(source\)/);
    assert.match(programApiDoc({ ...raw, milestones: true }), /progress toward this body's milestones/);
  });

  it("offers kits when some are active or the set can change", () => {
    assert.equal(kitsOffered(raw), false);
    assert.equal(kitsOffered(kitsTier), true);
    assert.equal(kitsOffered({ kits: [], kitsLocked: false }), true);
  });
});

describe("tier visibility on a running body", () => {
  /** The node arguments that run the CLI: this run's own flags (`--conditions=minebot-sdk:source`) carry over, so the CLI resolves `minebot-sdk/kit` to the source tree too. */
  const CLI = [...process.execArgv, path.join(import.meta.dirname, "..", "src", "cli.ts")];
  const runtime = mkdtempSync(path.join(tmpdir(), "minebot-features-"));
  const children: ChildProcess[] = [];

  /** Starts `minebot body` against a port where no server listens: the body serves its API and keeps trying to connect. */
  async function start(name: string, ...flags: string[]): Promise<BodyClient> {
    const env = { ...process.env, MINEBOT_RUNTIME_DIR: runtime };
    const stateDir = path.join(runtime, `${name}-state`);
    const child = spawn(
      "node",
      [...CLI, "body", "--bot", name, "--host", "127.0.0.1", "--port", "1", "--state", stateDir, "--lessons", path.join(stateDir, "lessons"), "--lock-kits", ...flags],
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
  let plainKitsBody: BodyClient;
  before(async () => {
    [rawBody, fullBody, plainKitsBody] = await Promise.all([
      start("features-raw", "--wiki", "off", "--no-milestones", "--no-agent-kits", "--no-triggers", "--no-routines", "--kits", ""),
      start("features-full", "--wiki", "read", "--kits", ROUTINE_KITS.join(","), "--no-milestones"),
      start("features-plainkits", "--wiki", "off", "--no-agent-kits", "--no-milestones", "--no-triggers", "--kits", ROUTINE_KITS.join(",")),
    ]);
  });
  after(() => {
    for (const child of children) child.kill("SIGTERM");
  });

  it("lists in the CLI's unknown-kits-action error only the verbs the body offers", async () => {
    // Locked kits with agent kits: no `use`.
    const full = await cli(fullBody, "kits", "frobnicate");
    assert.equal(full.code, 1);
    assert.match(full.out, /unknown kits action "frobnicate"; use "docs", "search", "save", "try", "rm", "source", "versions", or "revert"/);
    // Locked kits without agent kits: only docs and search, and the agent verbs answer as unknown.
    const plain = await cli(plainKitsBody, "kits", "frobnicate");
    assert.match(plain.out, /unknown kits action "frobnicate"; use "docs", or "search"/);
    for (const verb of ["save", "try", "rm", "source", "versions", "revert"]) {
      assert.match((await cli(plainKitsBody, "kits", verb)).out, new RegExp(`unknown kits action "${verb}"; use "docs", or "search"`), verb);
    }
  });

  const get = (client: BodyClient, route: string) => fetch(new URL(route, client.endpoint.url), { headers: { authorization: `Bearer ${client.endpoint.token}` } });

  it("answers requests for a feature it lacks like requests for any unknown route", async () => {
    for (const route of ["/kits", "/kits/docs", "/kits/source?name=move", "/kits/save", "/wiki/list", "/wiki/search?q=logs", "/wiki/page?id=flows/first-day", "/milestones", "/triggers", "/routines", "/routines/source?name=act", "/routines/versions?name=act", "/bindings"]) {
      const res = await get(rawBody, route);
      assert.equal(res.status, 404, route);
      assert.equal(((await res.json()) as { error: string }).error, `no route for GET ${route.split("?")[0]}`);
    }
    const post = await fetch(new URL("/kits", rawBody.endpoint.url), {
      method: "POST",
      headers: { authorization: `Bearer ${rawBody.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ use: ["gatherer"] }),
    });
    assert.equal(post.status, 404);
    await assert.rejects(rawBody.setMilestones({ milestones: [] }), /no route for PUT \/milestones/);
    await assert.rejects(rawBody.addTrigger({ name: "t", on: ["hurt"], run: "return 1" }), /no route for POST \/triggers/);
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
    assert.doesNotMatch(doc, KIT_WORDS);
    assert.doesNotMatch(doc, WIKI_WORDS);
    assert.doesNotMatch(doc, MILESTONE_WORDS);
    assert.doesNotMatch(doc, /trigger/i);
    assert.doesNotMatch(doc, /routine/i);
  });

  it("gives the CLI of a raw body no commands for features it lacks", async () => {
    const help = await cli(rawBody, "--help");
    assert.equal(help.code, 0);
    assert.doesNotMatch(help.out, KIT_WORDS);
    assert.doesNotMatch(help.out, /wiki|lesson|milestone|trigger/i);
    for (const command of ["kits", "kits docs", "wiki search logs", "milestones", "triggers"]) {
      const result = await cli(rawBody, ...command.split(" "));
      assert.equal(result.code, 1, command);
      assert.match(result.out, new RegExp(`^unknown command: ${command.split(" ")[0]}\\n`), command);
      // The first line repeats what the agent typed; the usage after it is the same as for --help.
      assert.equal(result.out.slice(result.out.indexOf("\n\n") + 2), help.out);
    }
    assert.match((await cli(rawBody, "status")).out, /^disconnected; body started \S+; deaths 0; reconnects \d+\n?$/);
  });

  it("serves a full body its kits and wiki, and nothing about milestones", async () => {
    assert.deepEqual((await fullBody.features()).kits, OFFERED_KITS);
    assert.deepEqual((await fullBody.kits()).kits.map((k) => k.name), OFFERED_KITS);
    assert.ok((await fullBody.wikiSearch("pickaxe")).hits.length > 0);
    assert.match((await cli(fullBody, "--help")).out, /kits docs[\s\S]*wiki search/);
    assert.doesNotMatch((await cli(fullBody, "--help")).out, /milestone/i);
    assert.match((await cli(fullBody, "kits", "docs")).out, /## gatherer/);
    assert.match((await cli(fullBody, "wiki", "read", "flows/first-day")).out, /collect\(isLog/);
  });

  it("serves a body with triggers its routes, command, and reference, and saves them across the CLI and the client", async () => {
    assert.equal((await fullBody.features()).triggers, true);
    assert.deepEqual(await fullBody.triggers(), { triggers: [] });
    assert.match((await cli(fullBody, "--help")).out, /triggers add <name> --on/);
    assert.match((await fullBody.apiDoc()).doc, /triggers\.add\(/);
    assert.match((await cli(fullBody, "triggers")).out, /^no triggers/);
    const file = path.join(runtime, "react.js");
    writeFileSync(file, "log('hurt', event.data);");
    const added = await cli(fullBody, "triggers", "add", "react", "--on", "hurt,night", "--when", "event.data.health < 8", "--cooldown", "0", "--preempt", file);
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /^saved trigger\nreact {2}\[on\] {2}on hurt, night; when event\.data\.health < 8; preempts/);
    const [saved] = (await fullBody.triggers()).triggers;
    assert.deepEqual([saved!.name, saved!.cooldownMs, saved!.preempt, saved!.priority], ["react", 0, true, 0]);
    assert.match((await cli(fullBody, "triggers", "disable", "react")).out, /\[off: disabled\]/);
    assert.equal((await fullBody.triggers()).triggers[0]!.enabled, false);
    await assert.rejects(fullBody.addTrigger({ name: "bad", on: ["trigger_fired"], run: "1" }), /cannot listen to trigger events/);
    await assert.rejects(fullBody.removeTrigger("nope"), /no trigger "nope"/);
    assert.deepEqual(await fullBody.removeTrigger("react"), { removed: "react" });
    assert.equal((await cli(fullBody, "triggers", "rm", "react")).code, 1);
  });

  it("serves a body without kits no kit content in the wiki", async () => {
    const wikiBody = await start("features-wiki", "--wiki", "read", "--no-milestones", "--no-agent-kits", "--kits", "");
    const first = (await cli(wikiBody, "wiki", "read", "flows/first-day")).out;
    assert.match(first, /collect\(isLog/);
    assert.doesNotMatch(first, KIT_WORDS);
    assert.doesNotMatch((await cli(wikiBody, "wiki", "read", "flows/escape-underground")).out, KIT_WORDS);
    const search = (await cli(wikiBody, "wiki", "search", "gather logs")).out;
    assert.doesNotMatch(search, KIT_WORDS);
    assert.match((await cli(wikiBody, "wiki", "read", "minebot/kits")).out, /no wiki page/);
  });

  it("shows a body with kits only the kits it offers", async () => {
    const some = await start("features-some", "--wiki", "off", "--no-milestones", "--no-agent-kits", "--kits", "gatherer");
    const offered = ["move", "sense", "dig", "inventory", "items", "gatherer"];
    assert.deepEqual((await some.kits()).kits.map((k) => k.name), offered);
    await assert.rejects(some.kitDocs(["social"]), /unknown kit "social"$/);
    const { doc } = await some.apiDoc();
    assert.match(doc, new RegExp(`namespaced by kit \\(${offered.join(", ")}\\)`));
  });
});
