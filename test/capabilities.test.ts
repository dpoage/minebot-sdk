import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { TOOL_SETS, toolPlan } from "../src/client/mcp.ts";
import { usageFor } from "../src/client/usage.ts";
import { CAPABILITIES, capabilities, CAPABILITY_GATES, programApiDoc, type BodyFeatures, type Capability } from "../src/protocol/index.ts";
import { wikiView } from "../src/wiki/access.ts";

/** A body with every capability on: the baseline to switch one off. */
const EVERYTHING: BodyFeatures = { kits: ["move", "gatherer"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true };

/** Words an agent must not see when the capability is off. */
const FORBIDDEN_WORDS: Record<Capability, RegExp> = {
  kits: /\bkits?\b|\bkit\./i,
  kitSwitching: /kits\.use|kits use|use_kits|swap the active kits/i,
  agentKits: /kits\.save|kits\.remove|kits\.source|kits\.try|kits\.versions|kits\.revert|kit_save|kit_remove|kit_source|kit_try|kit_versions|kit_revert|kits save|kits rm|kits source|kits try|kits versions|kits revert|agent kits|agentKits|your own kit|save.*kit source/i,
  wiki: /\bwiki\b|\blessons?\b/i,
  lessons: /\blearned\b|add a lesson|wiki lesson|wiki_add_lesson|addLesson/i,
  milestones: /\bmilestones?\b|minebot milestones|body's milestones/i,
  triggers: /\btriggers?\b|trigger_|--no-triggers/i,
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
    case "triggers":
      features.triggers = false;
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
      triggers: true,
    });
    assert.deepEqual(CAPABILITIES, ["kits", "kitSwitching", "agentKits", "wiki", "lessons", "milestones", "triggers"]);
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
      // kit_docs is the one gated tool in the core set (test/mcp.test.ts checks the whole list).
      const capsNow = capabilities(features);
      for (const toolSet of TOOL_SETS) {
        for (const [tool, entry] of Object.entries(toolPlan(features, toolSet))) {
          const served = capsNow[capabilityOf(tool)] && (toolSet === "full" || tool === "kit_docs");
          assert.equal(entry.enabled, served, `${tool} enabled state wrong with ${capability} off in the ${toolSet} set`);
          if (entry.enabled) assert.doesNotMatch(entry.description, forbidden, `enabled tool ${tool} description leaks ${capability}`);
        }
      }

      // The wiki's view of the body: the gated features map straight onto it.
      const view = wikiView(features);
      if (capability === "kits" || capability === "milestones" || capability === "agentKits" || capability === "triggers") {
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
    const daemon = readFileSync(new URL("../src/body/daemon.ts", import.meta.url), "utf8");
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
    assert.ok(gated.some((match) => match[1]!.startsWith("/triggers")), "trigger routes are gated");
    // The CLI's feature commands come from the same gates.
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    assert.match(cli, /const FEATURE_COMMANDS: Record<string, \(features: BodyFeatures\) => boolean> = \{\s*kits: CAPABILITY_GATES\.kits,\s*wiki: CAPABILITY_GATES\.wiki,\s*milestones: CAPABILITY_GATES\.milestones,\s*triggers: CAPABILITY_GATES\.triggers,\s*\};/);
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
    trigger_add: "triggers",
    trigger_list: "triggers",
    trigger_remove: "triggers",
    trigger_set_enabled: "triggers",
  };
  const capability = byTool[tool];
  if (capability === undefined) throw new Error(`unknown tool ${tool}`);
  return capability;
}
