import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { eventToolDescriptions, TOOL_SETS, toolPlan } from "../src/client/mcp.ts";
import { usageFor } from "../src/client/usage.ts";
import { CAPABILITIES, capabilities, CAPABILITY_GATES, programApiDoc, type BodyFeatures, type Capability } from "../src/protocol/index.ts";
import { wikiView } from "../src/wiki/access.ts";
import { routineContext, type GlobalsDeps } from "../src/host/globals.ts";
import { Notes } from "../src/notes.ts";
import { JsonStore } from "../src/store.ts";
import type { Connection } from "../src/host/connection.ts";
import type { WikiAccess } from "../src/wiki/access.ts";
import type { Bot } from "mineflayer";

const SCOPE = { log: () => {}, sleep: async () => {}, signal: new AbortController().signal, on: () => {} };

/** The facilities a body wires into a run's context, over stubs: only the members `routineContext` builds matter here. */
function depsFor(features: BodyFeatures): GlobalsDeps {
  return {
    connection: { requireBot: () => ({}) as Bot } as unknown as Connection,
    wiki: {} as WikiAccess,
    notes: new Notes(JsonStore.memory()),
    store: () => JsonStore.memory(),
    observe: () => () => {},
    features: () => features,
    status: async () => ({ connected: true, startedAt: "", deaths: 0, reconnects: 0 }),
  };
}

/** A body with every capability on: the baseline to switch one off. */
const EVERYTHING: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move", "gatherer"] };

/** Words an agent must not see when the capability is off. */
const FORBIDDEN_WORDS: Record<Capability, RegExp> = {
  wiki: /\bwiki\b|\blessons?\b/i,
  lessons: /\blearned\b|add a lesson|wiki lesson|wiki_add_lesson|addLesson/i,
  milestones: /\bmilestones?\b|minebot milestones|body's milestones/i,
  reflexes: /\breflexes?\b|reflex_|--no-reflexes|\btriggers?\b|trigger_|--no-triggers/i,
  // A body without a routine library still describes its built-ins, which a routine imports: "built-in routine" and the <module>.<routine> call name are theirs. `minebot-sdk/routine` is the package's authoring subpath (Vec3, goals), named whether or not the body has a library.
  routines: /(?<!built-in |\.<|minebot-sdk\/)\broutines?\b|bind_routine|--no-routines|\/bind\b|defineRoutine/i,
  builtins: /built-in routines?\b|\bbuiltins?\b|builtin_|minebot-sdk\/routines\/|<module>\.<routine>/i,
  // Calls are served for the library's actions and for built-ins: the words of the call surfaces go only when neither is offered.
  call: /call_routine|\/call\b|\bcall <|minebot call|\bcall: /i,
};

function withOff(capability: Capability): BodyFeatures {
  const features = { ...EVERYTHING };
  switch (capability) {
    case "wiki":
      features.wiki = "off";
      break;
    case "lessons":
      features.wiki = "read";
      break;
    case "milestones":
      features.milestones = false;
      break;
    case "reflexes":
      features.reflexes = false;
      break;
    case "routines":
      features.routines = false;
      break;
    case "builtins":
      features.builtins = [];
      break;
    case "call":
      features.routines = false;
      features.builtins = [];
      break;
  }
  return features;
}

describe("the capability table", () => {
  it("derives every capability from BodyFeatures through the gates", () => {
    assert.deepEqual(capabilities(EVERYTHING), {
      wiki: true,
      lessons: true,
      milestones: true,
      reflexes: true,
      routines: true,
      builtins: true,
      call: true,
    });
    assert.deepEqual(CAPABILITIES, ["wiki", "lessons", "milestones", "reflexes", "routines", "builtins", "call"]);
  });

  it("turns each capability off, alone, in every surface", () => {
    for (const capability of CAPABILITIES) {
      const features = withOff(capability);
      assert.equal(CAPABILITY_GATES[capability](features), false, `${capability} should be off`);
      const forbidden = FORBIDDEN_WORDS[capability];

      // The program reference.
      const doc = programApiDoc(features);
      assert.doesNotMatch(doc, forbidden, `programApiDoc leaks ${capability}`);

      // The CLI usage text.
      const usage = usageFor(features, false);
      assert.doesNotMatch(usage, forbidden, `usageFor leaks ${capability}`);

      // The MCP tool plan, in both tool sets: the capability's tools are disabled, and no enabled tool leaks it.
      // builtin_docs, call_routine and bind_routine are the gated tools in the core set (test/mcp.test.ts checks the whole list).
      const capsNow = capabilities(features);
      for (const toolSet of TOOL_SETS) {
        for (const [tool, entry] of Object.entries(toolPlan(features, toolSet))) {
          const served = capsNow[capabilityOf(tool)] && (toolSet === "full" || CORE_GATED_TOOLS.includes(tool));
          assert.equal(entry.enabled, served, `${tool} enabled state wrong with ${capability} off in the ${toolSet} set`);
          if (entry.enabled) assert.doesNotMatch(entry.description, forbidden, `enabled tool ${tool} description leaks ${capability}`);
        }
      }

      // The event tools, which are not in the plan: their generated type lists show only what this body can push.
      const eventTools = eventToolDescriptions(features);
      const shown: Record<string, string> = { wait_for: eventTools.wait_for, get_events: eventTools.get_events, ...(capsNow.routines && { bind_routine: eventTools.bind_routine }) };
      for (const [tool, description] of Object.entries(shown)) {
        assert.doesNotMatch(description, forbidden, `served tool ${tool} description leaks ${capability}`);
      }

      // The wiki's view of the body: the gated features map straight onto it.
      const view = wikiView(features);
      if (capability === "builtins" || capability === "milestones" || capability === "reflexes" || capability === "routines") {
        assert.equal(view[capability], false, `wikiView leaks ${capability}`);
      }
    }
  });

  it("keeps the other capabilities on when one is off", () => {
    const off = withOff("lessons");
    assert.equal(capabilitiesOn(off).length, CAPABILITIES.length - 1);
  });

  it("gates every route and every command through the table", () => {
    // The daemon's routes name a capability; the CLI's feature commands use the same gates.
    const daemon = readFileSync(new URL("../src/host/routes.ts", import.meta.url), "utf8");
    const routes = [...daemon.matchAll(/path: "(\/[a-z/:]+)",\s*(?:capability: "([a-zA-Z]+)",\s*)?/g)];
    assert.ok(routes.length >= 20, `expected the route table, found ${routes.length}`);
    for (const match of routes) {
      const path = match[1]!;
      const capability = match[2];
      if (path === "/observe" || path === "/status" || path === "/notes" || path.startsWith("/notes/") || path === "/events" || path === "/run" || path === "/wait" || path === "/stop" || path === "/chat" || path === "/api" || path === "/features" || path === "/milestones") {
        // /milestones is gated below; the rest are base routes and must name no capability.
        if (path !== "/milestones") assert.equal(capability, undefined, `${path} should be a base route`);
      }
    }
    const gated = routes.filter((match) => match[2] !== undefined);
    for (const match of gated) {
      assert.ok(CAPABILITIES.includes(match[2] as Capability), `${match[1]} names unknown capability ${match[2]}`);
    }
    assert.ok(gated.some((match) => match[1] === "/routines"), "routine routes are gated");
    assert.ok(!routes.some((match) => match[1]!.startsWith("/kits")), "no route of the kits is left");
    assert.ok(gated.some((match) => match[1]!.startsWith("/wiki/")), "wiki routes are gated");
    assert.ok(!routes.some((match) => match[1]!.startsWith("/triggers")), "no route of the code triggers is left");
    // The CLI's feature commands come from the same gates.
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    assert.match(cli, /const FEATURE_COMMANDS: Record<string, \(features: BodyFeatures\) => boolean> = \{\s*wiki: CAPABILITY_GATES\.wiki,\s*milestones: CAPABILITY_GATES\.milestones,\s*routines: CAPABILITY_GATES\.routines,\s*bind: CAPABILITY_GATES\.routines,\s*unbind: CAPABILITY_GATES\.routines,\s*call: CAPABILITY_GATES\.call,\s*builtins: CAPABILITY_GATES\.builtins,\s*\};/);
  });

  it("describes reflexes in bind_routine exactly when the body offers reflexes, and the routine tools exactly when it offers routines", () => {
    for (const toolSet of TOOL_SETS) {
      const withReflexes = toolPlan(EVERYTHING, toolSet);
      const withoutReflexes = toolPlan(withOff("reflexes"), toolSet);
      assert.match(withReflexes.bind_routine!.description, /reflex/);
      assert.doesNotMatch(withoutReflexes.bind_routine!.description, /reflex|trigger|cooldown|preempt/i);
      assert.equal(withoutReflexes.bind_routine!.enabled, true, "bind_routine stays for actions");
      for (const tool of ROUTINE_TOOLS) {
        assert.equal(withReflexes[tool]!.enabled, toolSet === "full" || tool === "bind_routine" || tool === "call_routine", `${tool} in the ${toolSet} set`);
        // With built-ins still offered, calls are still served.
        assert.equal(toolPlan(withOff("routines"), toolSet)[tool]!.enabled, tool === "call_routine", `${tool} must be off without routines, except the call of a built-in`);
      }
    }
  });

  it("tags every routine and binding route with the routines capability", () => {
    const daemon = readFileSync(new URL("../src/host/routes.ts", import.meta.url), "utf8");
    const routineRoutes = [
      ["GET", "/routines"],
      ["GET", "/routines/source"],
      ["POST", "/routines/save"],
      ["GET", "/routines/versions"],
      ["POST", "/routines/revert"],
      ["GET", "/bindings"],
      ["POST", "/bind"],
      ["POST", "/unbind"],
    ] as const;
    for (const [method, path] of routineRoutes) {
      assert.match(daemon, new RegExp(`method: "${method}",\\s*path: "${path}",\\s*capability: "routines",`), `${method} ${path} must name the routines capability`);
    }
  });

  it("tags every built-in route with the builtins capability, and offers built-ins exactly when the offered set is not empty", () => {
    const daemon = readFileSync(new URL("../src/host/routes.ts", import.meta.url), "utf8");
    for (const path of ["/builtins", "/builtins/docs", "/builtins/search", "/builtins/source"]) {
      assert.match(daemon, new RegExp(`method: "GET",\\s*path: "${path}",\\s*capability: "builtins",`), `GET ${path} must name the builtins capability`);
    }
    for (const builtins of [[], ["move"], ["move", "gatherer"]]) {
      const features = { ...EVERYTHING, builtins };
      assert.equal(capabilities(features).builtins, builtins.length > 0);
      assert.equal(CAPABILITY_GATES.builtins(features), builtins.length > 0);
      assert.equal(/\bbuiltins\b/.test(usageFor(features, false)), builtins.length > 0, "usage");
      assert.equal(/Built-in routines: /.test(programApiDoc(features)), builtins.length > 0, "api doc");
      assert.equal(toolPlan(features, "full").list_builtins!.enabled, builtins.length > 0, "tool plan");
    }
  });

  it("names an offered module only in the program reference's built-in line and goal table: the commands, the tools and the rest of the reference do not depend on which modules are offered", () => {
    const few = { ...EVERYTHING, builtins: ["move"] };
    const many = { ...EVERYTHING, builtins: ["move", "gatherer", "crafter"] };
    for (const toolSet of TOOL_SETS) assert.deepEqual(toolPlan(few, toolSet), toolPlan(many, toolSet), toolSet);
    assert.equal(usageFor(few, false), usageFor(many, false));
    const line = /^Built-in routines: .*$/m;
    // P2.5: the goal table is the one other section that names offered modules, a row at a time; it is the last section of the reference.
    const GOALS = "\n\nBefore you write it yourself, a built-in routine of this body already does it:";
    const rest = (doc: string) => (doc.includes(GOALS) ? doc.slice(0, doc.indexOf(GOALS)) : doc).replace(line, "");
    assert.match(programApiDoc(many), /^Built-in routines: move, gatherer, crafter\./m);
    assert.equal(rest(programApiDoc(few)), rest(programApiDoc(many)));
    // Offering crafter offers the row about it, and offering move alone offers no row at all.
    assert.match(programApiDoc(many), /\| make tools, or any item you can craft \| `crafter\.make` \|/);
    assert.doesNotMatch(programApiDoc(few), /already does it/);
    // And with the library off, the line only describes how to look them up.
    const withoutLibrary = programApiDoc({ ...many, routines: false });
    assert.match(withoutLibrary, /^Built-in routines: move, gatherer, crafter\. Reference: minebot builtins docs/m);
    assert.doesNotMatch(withoutLibrary, /minebot-sdk\/routines\/|with no bind/);
    assert.match(withoutLibrary, /POST \/call \{ name: "<module>\.<routine>"/);
  });

  it("describes routines in the program reference exactly when the body offers them", () => {
    assert.match(programApiDoc(EVERYTHING), /Routines: /);
    assert.doesNotMatch(programApiDoc(withOff("routines")), /Routines: /);
  });

  // Every feature set: all on, each capability off alone, and a body with nothing optional.
  const FEATURE_SETS: [string, BodyFeatures][] = [
    ["everything", EVERYTHING],
    ...CAPABILITIES.map((capability): [string, BodyFeatures] => [`${capability} off`, withOff(capability)]),
    ["nothing optional", { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] }],
  ];
  for (const [name, features] of FEATURE_SETS) {
    it(`describes a module run, not a program: ${name}`, () => {
      const doc = programApiDoc(features);
      assert.match(doc, /^A run is a TypeScript or JavaScript module/);
      assert.match(doc, /export default/);
      assert.doesNotMatch(doc, /^Globals:/m, "a Globals: section");
      assert.doesNotMatch(doc, /top-level return|body of an async function|The value you return is sent back/i, "a program's wording");
    });

    it(`lists exactly the members of ctx, in the order Object.keys(ctx) gives them: ${name}`, () => {
      const listed = /^ctx, the default function's first argument, has exactly: (.*)\.$/m.exec(programApiDoc(features))?.[1]?.split(", ");
      assert.deepEqual(listed, Object.keys(routineContext(SCOPE, depsFor(features))));
      // Each listed member has its reference line.
      for (const member of listed ?? []) assert.match(programApiDoc(features), new RegExp(`^- ${member}[:(]`, "m"), member);
    });
  }

  it("does not mention milestones anywhere a body without them looks", () => {
    assert.doesNotMatch(programApiDoc(withOff("milestones")), FORBIDDEN_WORDS.milestones);
    assert.doesNotMatch(usageFor(withOff("milestones"), false), FORBIDDEN_WORDS.milestones);
    assert.match(programApiDoc(EVERYTHING), /milestones/);
  });
});

function capabilitiesOn(features: BodyFeatures): Capability[] {
  return CAPABILITIES.filter((capability) => CAPABILITY_GATES[capability](features));
}

/** The gated tools the core set serves: the rest of the gated tools are in the full set only. */
const CORE_GATED_TOOLS = ["builtin_docs", "builtin_search", "call_routine", "bind_routine"];
const ROUTINE_TOOLS = ["call_routine", "bind_routine", "list_routines", "routine_save", "routine_source", "routine_versions", "routine_revert", "unbind_routine"];

/** The capability a capability-gated tool belongs to. */
function capabilityOf(tool: string): Capability {
  const byTool: Record<string, Capability> = {
    wiki_search: "wiki",
    wiki_read: "wiki",
    wiki_list: "wiki",
    wiki_add_lesson: "lessons",
    ...Object.fromEntries(ROUTINE_TOOLS.filter((routineTool) => routineTool !== "call_routine").map((routineTool) => [routineTool, "routines" as const])),
    call_routine: "call",
    list_builtins: "builtins",
    builtin_docs: "builtins",
    builtin_search: "builtins",
    builtin_source: "builtins",
  };
  const capability = byTool[tool];
  if (capability === undefined) throw new Error(`unknown tool ${tool}`);
  return capability;
}
