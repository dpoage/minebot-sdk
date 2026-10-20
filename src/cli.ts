#!/usr/bin/env node
// The `minebot` command: a thin client. Everything heavy loads on demand — the body for
// `minebot body`, the MCP server for `minebot mcp` — so a client-only install works without them.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { BodyClient } from "./client/client.ts";
import { formatKitHits, formatKits, formatKitVersions, formatRun, formatStatus, formatTriggers } from "./client/render.ts";
import { HAS_BODY, usageFor } from "./client/usage.ts";
import { BODY_FLAG_OPTIONS, OPERATOR_FLAG_HELP } from "./client/body-flags.ts";
import { ENV_FILE, initWorkspace } from "./client/init.ts";
import { generateEnv } from "./client/types-gen.ts";
import { CAPABILITY_GATES, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, type BodyFeatures, RUNTIME_DIR } from "./protocol/index.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bot: { type: "string", default: process.env.MINEBOT_BOT ?? "bot" },
    brief: { type: "boolean", default: false },
    title: { type: "string" },
    tags: { type: "string", default: "" },
    limit: { type: "string", default: "5" },
    timeout: { type: "string" },
    since: { type: "string" },
    types: { type: "string" },
    from: { type: "string" },
    match: { type: "string" },
    action: { type: "string" },
    args: { type: "string" },
    out: { type: "string" },
    on: { type: "string" },
    when: { type: "string" },
    cooldown: { type: "string" },
    priority: { type: "string" },
    preempt: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    ...BODY_FLAG_OPTIONS,
  },
});

const [command, ...rest] = positionals;
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** What the body offers, or null when it cannot be reached. */
async function probeFeatures(): Promise<BodyFeatures | null> {
  try {
    return await (await BodyClient.connect(opts.bot)).features();
  } catch {
    return null;
  }
}

/** Commands that belong to an optional feature; a body without the feature answers as if the command did not exist. */
const FEATURE_COMMANDS: Record<string, (features: BodyFeatures) => boolean> = {
  kits: CAPABILITY_GATES.kits,
  wiki: CAPABILITY_GATES.wiki,
  milestones: CAPABILITY_GATES.milestones,
  triggers: CAPABILITY_GATES.triggers,
};

async function main(): Promise<number> {
  if (opts.help || !command) {
    console.log(usageFor(await probeFeatures(), HAS_BODY, OPERATOR_FLAG_HELP));
    return command || opts.help ? 0 : 1;
  }
  const gate = Object.hasOwn(FEATURE_COMMANDS, command) ? FEATURE_COMMANDS[command] : undefined;
  const features = gate ? await probeFeatures() : null;
  if (gate && features && !gate(features)) return unknownCommand(features);
  switch (command) {
    case "body": {
      if (!HAS_BODY) return unknownCommand(await probeFeatures());
      // Not a static import: a client-only install ships no src/body/, and the command is then unknown.
      const { runBody } = await import("./body/main.ts");
      const flagValues: Record<string, string | boolean | undefined> = {};
      const raw = opts as Record<string, string | boolean | undefined>;
      for (const flag of Object.keys(BODY_FLAG_OPTIONS)) flagValues[flag] = raw[flag];
      return runBody({ name: opts.bot, token: process.env.MINEBOT_TOKEN || undefined, flags: flagValues });
    }
    case "list": {
      const files = await readdir(RUNTIME_DIR).catch(() => []);
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        const name = file.slice(0, -".json".length);
        const state = await BodyClient.connect(name)
          .then((c) => c.observe())
          .then((o) => (o.connected ? `connected as ${o.username}` : "disconnected"))
          .catch((err: unknown) => `unreachable (${err instanceof Error ? err.message : String(err)})`);
        console.log(`${name}\t${state}`);
      }
      return 0;
    }
    case "observe": {
      const client = await BodyClient.connect(opts.bot);
      if (opts.brief) console.log(await client.brief());
      else print(await client.observe());
      return 0;
    }
    case "status":
      console.log(formatStatus(await (await BodyClient.connect(opts.bot)).status()));
      return 0;
    case "milestones": {
      const client = await BodyClient.connect(opts.bot);
      const [action, file] = rest;
      if (action === "set") {
        if (!file) throw new Error("milestones set needs a milestones JSON file");
        // The body validates the milestones.
        print(await client.setMilestones(JSON.parse(await readFile(file, "utf8"))));
      } else if (action === "clear") print(await client.setMilestones(null));
      else if (action) throw new Error(`unknown milestones action "${action}"; use set or clear`);
      else print(await client.milestones());
      return 0;
    }
    case "notes": {
      const client = await BodyClient.connect(opts.bot);
      const [action, key, ...words] = rest;
      switch (action) {
        case undefined:
        case "list": {
          const { notes } = await client.notes();
          if (notes.length === 0) console.log("no notes");
          for (const n of notes) console.log(`${n.key}  (${n.updated})\n  ${n.text.split("\n")[0]!.slice(0, 160)}`);
          return 0;
        }
        case "get":
          if (!key) throw new Error("notes get needs a key");
          console.log((await client.note(key)).text);
          return 0;
        case "set": {
          if (!key) throw new Error("notes set needs a key");
          const body = words.length > 0 ? words.join(" ") : (await text(process.stdin)).trimEnd();
          print(await client.setNote(key, body));
          return 0;
        }
        case "rm":
          if (!key) throw new Error("notes rm needs a key");
          print(await client.deleteNote(key));
          return 0;
        default:
          throw new Error(`unknown notes action "${action}"; use list, get, set, or rm`);
      }
    }
    case "triggers": {
      const client = await BodyClient.connect(opts.bot);
      const [action, name, file] = rest;
      switch (action) {
        case undefined:
        case "list": {
          const { triggers } = await client.triggers();
          console.log(triggers.length === 0 ? "no triggers" : formatTriggers(triggers));
          return 0;
        }
        case "add": {
          if (!name) throw new Error("triggers add needs a name");
          if (!opts.on) throw new Error("triggers add needs --on <event types>");
          const run = !file || file === "-" ? await text(process.stdin) : await readFile(file, "utf8");
          const { trigger, replaced } = await client.addTrigger({
            name,
            on: opts.on.split(",").map((t) => t.trim()).filter(Boolean),
            run,
            from: opts.from,
            match: opts.match,
            when: opts.when,
            cooldownMs: opts.cooldown === undefined ? undefined : Number(opts.cooldown),
            timeoutMs: opts.timeout === undefined ? undefined : Number(opts.timeout),
            priority: opts.priority === undefined ? undefined : Number(opts.priority),
            preempt: opts.preempt || undefined,
          });
          console.log(`${replaced ? "replaced" : "saved"} trigger\n${formatTriggers([trigger])}`);
          return 0;
        }
        case "rm":
          if (!name) throw new Error("triggers rm needs a name");
          print(await client.removeTrigger(name));
          return 0;
        case "enable":
        case "disable": {
          if (!name) throw new Error(`triggers ${action} needs a name`);
          console.log(formatTriggers([(await client.setTriggerEnabled(name, action === "enable")).trigger]));
          return 0;
        }
        default:
          throw new Error(`unknown triggers action "${action}"; use list, add, rm, enable, or disable`);
      }
    }
    case "run": {
      const file = rest[0];
      const source = !file || file === "-" ? await text(process.stdin) : await readFile(file, "utf8");
      // A .ts program is checked by tsc in a workspace; the body runs JavaScript, so its types come off here.
      const code = file?.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
      const client = await BodyClient.connect(opts.bot);
      const run = await client.run(code, opts.timeout === undefined ? undefined : Number(opts.timeout));
      console.log(formatRun(run));
      return run.status === "ok" ? 0 : 2;
    }
    case "stop":
      print(await (await BodyClient.connect(opts.bot)).stop());
      return 0;
    case "events":
      print(await (await BodyClient.connect(opts.bot)).events(Number(opts.since ?? 0)));
      return 0;
    case "wait": {
      const client = await BodyClient.connect(opts.bot);
      const waited = await client.wait({
        types: opts.types?.split(",").map((t) => t.trim()).filter(Boolean),
        from: opts.from,
        match: opts.match,
        since: opts.since === undefined ? undefined : Number(opts.since),
        timeoutMs: opts.timeout === undefined ? undefined : Number(opts.timeout),
      });
      if (waited.event) print(waited.event);
      else console.log("timed out");
      return 0;
    }
    case "chat": {
      const message = rest.join(" ");
      if (!message) throw new Error("chat needs a message");
      print(await (await BodyClient.connect(opts.bot)).chat(message));
      return 0;
    }
    case "init": {
      const dir = rest[0] ?? ".";
      const written = await initWorkspace(dir);
      for (const file of written) console.log(`wrote ${path.join(dir, file)}`);
      if (written.length === 0) console.log(`${dir} already has every workspace file`);
      console.log(`\nNext: cd ${dir} && npm install, run a body with --agent-kits ./kits, then \`minebot types --out ${ENV_FILE}\` and \`npx tsc\`.`);
      return 0;
    }
    case "types": {
      const client = await BodyClient.connect(opts.bot);
      const bodyFeatures = await client.features();
      // Kits are an optional capability: a body without them has no schemas route, and the globals are typed without them.
      const kits = CAPABILITY_GATES.kits(bodyFeatures) ? (await client.kitSchemas()).kits : [];
      const env = generateEnv(bodyFeatures, kits);
      if (opts.out === undefined) process.stdout.write(env);
      else {
        await mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
        await writeFile(opts.out, env);
        console.error(`wrote ${opts.out}`);
      }
      return 0;
    }
    case "kits": {
      const client = await BodyClient.connect(opts.bot);
      const [action, ...names] = rest;
      // The verbs this body offers: the same gates as its routes. Without an answer from the body, all of them.
      const verbs = [
        ...(features && !CAPABILITY_GATES.kitSwitching(features) ? [] : ["use"]),
        "docs",
        "search",
        ...(features && !CAPABILITY_GATES.agentKits(features) ? [] : ["save", "try", "rm", "source", "versions", "revert"]),
      ];
      if (action && !verbs.includes(action)) {
        throw new Error(`unknown kits action "${action}"; use ${verbs.slice(0, -1).map((v) => `"${v}"`).join(", ")}, or "${verbs.at(-1)}"`);
      }
      if (action === "docs") {
        console.log((await client.kitDocs(names)).docs);
        return 0;
      }
      if (action === "save") {
        const file = names[0];
        const source = !file || file === "-" ? await text(process.stdin) : await readFile(file, "utf8");
        print(await client.saveKit(source));
        return 0;
      }
      if (action === "rm") {
        if (!names[0]) throw new Error("kits rm needs a kit name");
        print(await client.removeKit(names[0]));
        return 0;
      }
      if (action === "source") {
        if (!names[0]) throw new Error("kits source needs a kit name");
        console.log((await client.kitSource(names[0])).source);
        return 0;
      }
      if (action === "search") {
        if (names.length === 0) throw new Error("kits search needs a query");
        const { hits } = await client.searchKits(names.join(" "), Number(opts.limit));
        console.log(hits.length === 0 ? "no matching kits" : formatKitHits(hits));
        return 0;
      }
      if (action === "try") {
        if (!opts.action) throw new Error("kits try needs --action <name>; pass the action's arguments as JSON with --args");
        const file = names[0];
        const source = !file || file === "-" ? await text(process.stdin) : await readFile(file, "utf8");
        const run = await client.tryKit(source, opts.action, opts.args === undefined ? undefined : JSON.parse(opts.args), opts.timeout === undefined ? undefined : Number(opts.timeout));
        console.log(formatRun(run));
        return run.status === "ok" ? 0 : 2;
      }
      if (action === "versions") {
        if (!names[0]) throw new Error("kits versions needs a kit name");
        console.log(formatKitVersions(names[0], (await client.kitVersions(names[0])).versions));
        return 0;
      }
      if (action === "revert") {
        const version = Number(names[1]);
        if (!names[0] || !Number.isInteger(version)) throw new Error("kits revert needs a kit name and a version number");
        print(await client.revertKit(names[0], version));
        return 0;
      }
      if (action === "use") await client.useKits(names);
      const { kits, locked } = await client.kits();
      console.log(formatKits(kits, locked));
      return 0;
    }
    case "wiki": {
      const client = await BodyClient.connect(opts.bot);
      const [action, ...args] = rest;
      switch (action) {
        case "search": {
          const { hits } = await client.wikiSearch(args.join(" "), Number(opts.limit));
          if (hits.length === 0) console.log("no matching pages");
          for (const h of hits) console.log(`${h.id}  [${h.status}]  ${h.title}\n    ${h.snippet}`);
          return 0;
        }
        case "read":
          if (!args[0]) throw new Error("wiki read needs a page id");
          console.log((await client.wikiRead(args[0])).text);
          return 0;
        case "list": {
          const { pages, mode } = await client.wikiList(args[0]);
          for (const p of pages) console.log(`${p.id}  [${p.status}]  ${p.title}`);
          console.log(`\n${pages.length} pages; wiki is ${mode} on this body`);
          return 0;
        }
        case "lesson": {
          if (features && !CAPABILITY_GATES.lessons(features)) throw new Error(`unknown wiki action "lesson"; use search, read, or list`);
          if (!opts.title) throw new Error("wiki lesson needs --title");
          const body = await text(process.stdin);
          print(await client.addLesson({ title: opts.title, tags: opts.tags.split(",").filter(Boolean), body }));
          return 0;
        }
        default:
          throw new Error(`unknown wiki action "${action ?? ""}"; use ${features && CAPABILITY_GATES.lessons(features) ? "search, read, list, or lesson" : "search, read, or list"}`);
      }
    }
    case "mcp": {
      // Not a static import: only the MCP server needs the MCP SDK.
      const { serveMcp } = await import("./client/mcp.ts");
      await serveMcp(opts.bot);
      const closed = Promise.withResolvers<void>();
      process.stdin.once("end", () => closed.resolve());
      await closed.promise;
      return 0;
    }
    case "api":
      console.log((await (await BodyClient.connect(opts.bot)).apiDoc()).doc);
      return 0;
    default:
      return unknownCommand(await probeFeatures());
  }
}

async function unknownCommand(features: BodyFeatures | null): Promise<number> {
  console.error(`unknown command: ${command}\n\n${usageFor(features, HAS_BODY, OPERATOR_FLAG_HELP)}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[minebot] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
