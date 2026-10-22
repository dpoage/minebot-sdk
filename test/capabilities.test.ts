import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { TOOL_SETS, toolPlan } from "../src/client/mcp.ts";
import { usageFor } from "../src/client/usage.ts";
import { CAPABILITIES, capabilities, CAPABILITY_GATES, programApiDoc, type BodyFeatures, type Capability } from "../src/protocol/index.ts";
import { wikiView } from "../src/wiki/access.ts";

/** A body with every capability on: the baseline to switch one off. */
const EVERYTHING: BodyFeatures = { kits: ["move", "gatherer"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true };

/** Words an agent must not see when the capability is off. */
const FORBIDDEN_WORDS: Record<Capability, RegExp> = {
  kits: /\bkits?\b|\bkit\./i,
  kitSwitching: /kits\.use|kits use|use_kits|swap the active kits/i,
  agentKits: /kits\.save|kits\.remove|kits\.source|kits\.try|kits\.versions|kits\.revert|kit_save|kit_remove|kit_source|kit_try|kit_versions|kit_revert|kits save|kits rm|kits source|kits try|kits versions|kits revert|agent kits|agentKits|your own kit|save.*kit source/i,
  wiki: /\bwiki\b|\blessons?\b/i,
  lessons: /\blearned\b|add a lesson|wiki lesson|wiki_add_lesson|addLesson/i,
  milestones: /\bmilestones?\b|minebot milestones|body's milestones/i,
  reflexes: /\breflexes?\b|reflex_|--no-reflexes|\btriggers?\b|trigger_|--no-triggers/i,
  routines: /\broutines?\b|call_routine|bind_routine|--no-routines|\/bind\b|\/call\b|defineRoutine/i,
};

function withOff(capability: Capability): BodyFeatures {
  const features = { ...EVERYTHING };
  switch (capability) {
    case "kits":
      features.kits = [];
      features.kitsLocked = true;
      break;
    case "kitSwitching":
      features.kitsLocked = true;
      break;
    case "agentKits":
      features.agentKits = false;
      break;
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
  }
  return features;
}

describe("the capability table", () => {
  it("derives every capability from BodyFeatures through the gates", () => {
    assert.deepEqual(capabilities(EVERYTHING), {
      kits: true,
      kitSwitching: true,
      agentKits: true,
      wiki: true,
      lessons: true,
      milestones: true,
      reflexes: true,
      routines: true,
    });
    assert.deepEqual(CAPABILITIES, ["kits", "kitSwitching", "agentKits", "wiki", "lessons", "milestones", "reflexes", "routines"]);
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
      // kit_docs, call_routine and bind_routine are the gated tools in the core set (test/mcp.test.ts checks the whole list).
      const capsNow = capabilities(features);
      for (const toolSet of TOOL_SETS) {
        for (const [tool, entry] of Object.entries(toolPlan(features, toolSet))) {
          const served = capsNow[capabilityOf(tool)] && (toolSet === "full" || CORE_GATED_TOOLS.includes(tool));
          assert.equal(entry.enabled, served, `${tool} enabled state wrong with ${capability} off in the ${toolSet} set`);
          if (entry.enabled) assert.doesNotMatch(entry.description, forbidden, `enabled tool ${tool} description leaks ${capability}`);
        }
      }

      // The wiki's view of the body: the gated features map straight onto it.
      const view = wikiView(features);
      if (capability === "kits" || capability === "milestones" || capability === "agentKits" || capability === "reflexes" || capability === "routines") {
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
    assert.ok(gated.some((match) => match[1] === "/kits"), "kit routes are gated");
    assert.ok(gated.some((match) => match[1]!.startsWith("/wiki/")), "wiki routes are gated");
    assert.ok(!routes.some((match) => match[1]!.startsWith("/triggers")), "no route of the code triggers is left");
    // The CLI's feature commands come from the same gates.
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    assert.match(cli, /const FEATURE_COMMANDS: Record<string, \(features: BodyFeatures\) => boolean> = \{\s*kits: CAPABILITY_GATES\.kits,\s*wiki: CAPABILITY_GATES\.wiki,\s*milestones: CAPABILITY_GATES\.milestones,\s*routines: CAPABILITY_GATES\.routines,\s*bind: CAPABILITY_GATES\.routines,\s*unbind: CAPABILITY_GATES\.routines,\s*call: CAPABILITY_GATES\.routines,\s*\};/);
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
        assert.equal(toolPlan(withOff("routines"), toolSet)[tool]!.enabled, false, `${tool} must be off without routines`);
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
      ["POST", "/call"],
    ] as const;
    for (const [method, path] of routineRoutes) {
      assert.match(daemon, new RegExp(`method: "${method}",\\s*path: "${path}",\\s*capability: "routines",`), `${method} ${path} must name the routines capability`);
    }
  });

  it("describes routines in the program reference exactly when the body offers them, and lists only the ctx members it offers", () => {
    assert.match(programApiDoc(EVERYTHING), /Routines: /);
    assert.doesNotMatch(programApiDoc(withOff("routines")), /Routines: /);
    const members = (features: BodyFeatures) => /ctx has exactly: ([^.]*)\./.exec(programApiDoc(features))?.[1];
    assert.equal(members(EVERYTHING), "bot, log, sleep, signal, on, notes, status, kit, wiki");
    assert.equal(members(withOff("kits")), "bot, log, sleep, signal, on, notes, status, wiki");
    assert.equal(members(withOff("wiki")), "bot, log, sleep, signal, on, notes, status, kit");
    assert.equal(members({ ...withOff("kits"), wiki: "off", lessons: false }), "bot, log, sleep, signal, on, notes, status");
  });

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
const CORE_GATED_TOOLS = ["kit_docs", "call_routine", "bind_routine"];
const ROUTINE_TOOLS = ["call_routine", "bind_routine", "list_routines", "routine_save", "routine_source", "routine_versions", "routine_revert", "unbind_routine"];

/** The capability a capability-gated tool belongs to. */
function capabilityOf(tool: string): Capability {
  const byTool: Record<string, Capability> = {
    list_kits: "kits",
    kit_docs: "kits",
    kit_search: "kits",
    use_kits: "kitSwitching",
    kit_save: "agentKits",
    kit_remove: "agentKits",
    kit_source: "agentKits",
    kit_try: "agentKits",
    kit_versions: "agentKits",
    kit_revert: "agentKits",
    wiki_search: "wiki",
    wiki_read: "wiki",
    wiki_list: "wiki",
    wiki_add_lesson: "lessons",
    ...Object.fromEntries(ROUTINE_TOOLS.map((routineTool) => [routineTool, "routines" as const])),
  };
  const capability = byTool[tool];
  if (capability === undefined) throw new Error(`unknown tool ${tool}`);
  return capability;
}
