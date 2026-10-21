// The one capability table. Everything an agent can see is derived from BodyFeatures through
// CAPABILITY_GATES: the daemon's routes, the MCP tools, the CLI usage, the program globals,
// the program reference, and the wiki's view. A capability that is off is absent from every
// surface, not hidden behind an error.
import type { WikiMode } from "./types.ts";

/** The optional parts of a body. Everything an agent can see derives from this, so it never learns about a feature its body does not offer. */
export interface BodyFeatures {
  /** Kits that are active. */
  kits: string[];
  /** Whether the active kits are fixed. */
  kitsLocked: boolean;
  /** Whether agents may save and remove their own kits. */
  agentKits: boolean;
  wiki: WikiMode;
  /** Agents' lessons are part of the wiki: the body can write them, or some exist. */
  lessons: boolean;
  /** Milestones can be read, set, and graded. */
  milestones: boolean;
  /** The agent can register triggers: programs the body runs when an event arrives. */
  triggers: boolean;
}

/** Every optional capability a body can offer. */
export const CAPABILITIES = ["kits", "kitSwitching", "agentKits", "wiki", "lessons", "milestones", "triggers"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The single source of truth for what each capability needs. Each entry is a predicate over
 * BodyFeatures; every surface asks this table instead of re-deriving the answer.
 */
export const CAPABILITY_GATES: Record<Capability, (features: BodyFeatures) => boolean> = {
  kits: kitsOffered,
  kitSwitching: (f) => kitsOffered(f) && !f.kitsLocked,
  agentKits: (f) => f.agentKits && kitsOffered(f),
  wiki: (f) => f.wiki !== "off",
  lessons: (f) => f.wiki === "write",
  milestones: (f) => f.milestones,
  triggers: (f) => f.triggers,
};

/** Which capabilities a body offers, in CAPABILITIES order. */
export function capabilities(features: BodyFeatures): Record<Capability, boolean> {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, CAPABILITY_GATES[capability](features)])) as Record<Capability, boolean>;
}

/** Kits are part of the body: some are active, or the active set can change. */
export function kitsOffered(features: Pick<BodyFeatures, "kits" | "kitsLocked">): boolean {
  return features.kits.length > 0 || !features.kitsLocked;
}

/**
 * Describes the program environment of one body. Shown to agents by the MCP server and the CLI.
 * Lists only the features the body offers, so an agent does not spend turns on locked ones.
 */
export function programApiDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const globals = [
    "- bot: the mineflayer Bot (https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md). The pathfinder plugin is loaded: use bot.pathfinder.goto(goal).",
    "- goals, Movements: from mineflayer-pathfinder. Example: await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1)).",
    "- Vec3: the vec3 constructor.",
    "- log(...args) / console.log(...args): append to the program output.",
    "- sleep(ms): resolves after ms; rejects when the program is aborted.",
    "- signal: AbortSignal that fires on timeout or stop. Check signal.aborted in long loops.",
    "- on(event, handler): subscribe to a bot event. When the program ends or is aborted, the body removes the handlers that exist at that moment; a handler registered afterward stays.",
    "- setTimeout / setInterval and their clear functions: when the program ends or is aborted, the body clears the timers that exist at that moment; a timer created afterward keeps running.",
    "- globalThis: persists between programs. A restart of the body clears it, and so does a restart of the bot host, the process that runs programs. The bot host restarts after a crash, and when the body kills it for a program that does not stop. Store helpers and state on it.",
    '- notes: your notepad on this body; it survives body restarts and resets of your context. notes.set(key, text), notes.get(key) -> text, notes.list() -> [{ key, text, updated }], notes.delete(key). Keys are lowercase, e.g. "plan" or "places/base".',
    caps.milestones
      ? "- status(): resolves to { deaths, reconnects, milestones }; milestones is progress toward this body's milestones, graded from the server's statistics, or null."
      : "- status(): resolves to { deaths, reconnects }.",
  ];
  if (caps.kits) {
    const example = features.kits.includes("move") ? ', e.g. await kit.move.to({ position: [x, y, z] })' : "";
    globals.push(
      `- kit: the active kits' actions, namespaced by kit (${features.kits.join(", ")})${example}. Every action takes one object argument and validates it.`,
    );
    const switching = caps.kitSwitching ? ', kits.use("gatherer") to swap the active kits' : "";
    globals.push(
      `- kits: kits.active, kits.available() (each kit lists how often its actions succeeded and failed on this body), kits.search(query, limit?) to find kits and actions by what they do, kits.docs(...names) for the action reference${switching}.`,
    );
  }
  if (caps.agentKits) {
    globals.push(
      "- kits.save(source), kits.remove(name), kits.source(name): write, delete, and read agent kits — TypeScript files in the same shape as the built-ins: `import { defineKit, action, z } from \"minebot-sdk/kit\";` (the only import allowed; it also exports the helpers the built-ins use, such as nameMatcher, Position, goals) then one `export default defineKit({ name, description, uses }, { actionName: action({ doc, args, returns, run }) })` (or `export const <name> = defineKit(...)`, as the built-ins are written; other exports are ignored); run `kits.source(\"move\")` and read `minebot api` for an example. kits.save returns the kit with `typeCheck`: the type errors of the source, which do not stop the save. kits.try(source, { action, args }) compiles and audits the source like a save, runs that one action once, and returns its result or throws its error; type errors go to the log; nothing is saved. Saving over a kit keeps the old source: kits.versions(name) lists the versions, kits.revert(name, version) saves one again.",
    );
  }
  if (caps.triggers) {
    globals.push(
      "- triggers: reflexes the body runs when an event arrives; they persist across body restarts. triggers.add({ name, on: ['hurt'], run: '<program source>', when?, from?, match?, cooldownMs?, timeoutMs?, preempt?, priority?, enabled? }) saves one (the same name replaces it), triggers.remove(name), triggers.enable(name), triggers.disable(name), triggers.list(). `run` is a program with the usual globals plus `event` ({ seq, type, data }); `when` is a JavaScript expression over `event` and `bot` that must be truthy; `from` and `match` filter chat as waits do. A trigger waits until no program is running; with preempt: true it stops the running program first (a higher priority wins). The body records trigger_fired and trigger_finished events, and disables a trigger that fails 3 times in a row (trigger_disabled).",
    );
  }
  if (caps.wiki) {
    const lessons = caps.lessons ? ", and lessons that agents wrote" : "";
    const write = caps.lessons ? ", wiki.addLesson({ title, tags, body }) to record what you learned" : "";
    globals.push(`- wiki: notes on mechanics, flows, and quirks${lessons}. wiki.search(query, limit?) -> hits, wiki.read(id) -> markdown, wiki.list(section?)${write}.`);
  }
  return `A program is the body of an async JavaScript function. It runs inside the body, against a live Mineflayer bot. require() and import() are not available.

Globals:
${globals.join("\n")}

The value you return is sent back as the result. On timeout or stop, the body halts pathfinding, digging and movement, clears the timers that exist at that moment, and removes the on() handlers that exist at that moment. If the program does not end, the body can kill the bot host and restart it; the restart reconnects as the same player. A program that blocks the host with synchronous code after it catches the abort can run on without being killed. Check signal.aborted in long loops so the program ends in time.`;
}
