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
  /** Reflexes are not turned off. The agent can bind them only where the body also has routines (`CAPABILITY_GATES.reflexes`). */
  reflexes: boolean;
  /** The body keeps a routine library: modules the agent saves, binds to names, and calls. */
  routines: boolean;
  /** The built-in routine modules the body offers (the closure of its `--builtins` over each module's `uses`); empty when it offers none. */
  builtins: string[];
}

/** Every optional capability a body can offer. */
export const CAPABILITIES = ["kits", "kitSwitching", "agentKits", "wiki", "lessons", "milestones", "reflexes", "routines", "builtins"] as const;
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
  reflexes: (f) => f.reflexes && f.routines,
  routines: (f) => f.routines,
  builtins: (f) => f.builtins.length > 0,
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
    "- on(event, handler): subscribe to a bot event. When the program ends or is aborted, the body removes the handlers that exist at that moment.",
    "- setTimeout / setInterval and their clear functions: when the program ends or is aborted, the body clears the timers that exist at that moment.",
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
  if (caps.wiki) {
    const lessons = caps.lessons ? ", and lessons that agents wrote" : "";
    const write = caps.lessons ? ", wiki.addLesson({ title, tags, body }) to record what you learned" : "";
    globals.push(`- wiki: notes on mechanics, flows, and quirks${lessons}. wiki.search(query, limit?) -> hits, wiki.read(id) -> markdown, wiki.list(section?)${write}.`);
  }
  // The routine-related sections: the library's, then the built-ins' (each only where the body offers it).
  const routines = `${caps.routines ? `\n\n${routinesDoc(features)}` : ""}${caps.builtins ? `\n\n${builtinsDoc(features)}` : ""}`;
  return `A program is the body of an async JavaScript function. It runs inside the body, against a live Mineflayer bot. require() and import() are not available.

Globals:
${globals.join("\n")}

The value you return is sent back as the result. On timeout or stop, the body halts pathfinding, digging and movement, clears the timers that exist at that moment, and removes the on() handlers that exist at that moment. If the program does not end within 5 seconds of the abort, the body kills the bot host and restarts it, also when the program blocks the host with synchronous code; the restart reconnects as the same player. Check signal.aborted in long loops so the program ends in time.${routines}`;
}

/** The routines section of the program reference, for a body that offers them. */
function routinesDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const members = ["bot", "log", "sleep", "signal", "on", "notes", "status", ...(caps.kits ? ["kit"] : []), ...(caps.wiki ? ["wiki"] : [])];
  const reflexes = caps.reflexes
    ? `\n- Reflexes: POST /bind { kind: "reflex", name, routine, on: ["hurt"], when?, from?, match?, cooldownMs?, timeoutMs?, preempt?, priority?, enabled? } binds a routine to events. The routine's default export is called as (ctx, { event }) with the event { seq, type, time, data }; \`when\` is a JavaScript expression over \`event\` and \`bot\` that must be truthy; \`from\` and \`match\` filter chat as waits do; a reflex cannot listen to reflex_* events. Defaults: cooldownMs 1000, timeoutMs 30000, enabled true, preempt false, priority 0. A firing waits until no run is active; with preempt: true it stops the running run first (a higher priority wins, and a reflex never stops a running reflex of equal or higher priority). The body records reflex_fired and reflex_finished events for it, and a reflex that fails 3 times in a row disables itself (reflex_disabled; bind it again to re-enable it). A name belongs to one binding at a time (409 otherwise), and a body keeps at most 50 reflexes. A stored entry that cannot be loaded as a reflex (one saved before reflexes, say) is reported as a reflex_error event each time the bot host starts, keeps its name and counts toward the limit until POST /unbind removes it; an entry under a name POST /unbind does not accept cannot be unbound, and its reflex_error names the file to edit instead. GET /bindings lists a reflex with what it has done since the body started; POST /unbind removes it.`
    : "";
  return `Routines: a routine is a TypeScript module saved in this body's library, run by name instead of as program text. Its default export is a function (ctx, args) => result, usually \`export default defineRoutine({ description?, args?, returns? }, async (ctx, args) => result)\` with \`import { defineRoutine, z } from "minebot-sdk/routine"\`; args and returns are optional zod schemas that validate a call, and absent args are {}. Unlike a program it is a real module that uses \`import\` (\`require\` does not work): it can import Node built-ins, the packages this body ships (mineflayer, mineflayer-pathfinder, vec3, minecraft-data, prismarine-*, zod), \`minebot-sdk/<subpath>\` such as minebot-sdk/routine (bare \`minebot-sdk\` does not resolve), and other saved routines by file name (\`import { helper } from "./helper.ts"\`; save the imported routine first).
- ctx has exactly: ${members.join(", ")}. status() resolves like the program global; the other members are the program globals of the same name, and ctx.on, ctx.sleep and ctx.signal end with the call. A timer or bot.on listener that the routine makes itself outlives the call, and a timer that throws after the call has ended restarts the bot host.
- Library over HTTP: GET /routines, GET /routines/source?name=, POST /routines/save { name, source } (answers the routine and the type check of its source, which does not stop the save; a source is limited to 128 KiB), GET /routines/versions?name=, POST /routines/revert { name, version }. Routine and binding names are 1-48 lowercase letters, digits, _ and -, starting with a letter.
- Bindings: POST /bind { kind: "action", name, routine } names a saved routine for calling (the same name replaces it); GET /bindings lists them; POST /unbind { name } removes one. Bindings persist across body restarts.${reflexes}
- POST /call { name, args?, timeoutMs? } calls the routine bound to name with the JSON args and answers like /run: status, result (the routine's return value), error, logs. A call is a run: one at a time with programs, stopped by /stop, ended by its timeout.`;
}

/** The built-in routines section of the program reference, for a body that offers any. How to import and call them is told only where the body also has routines. */
function builtinsDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const example = features.builtins.includes("move") ? ", e.g. move.to" : "";
  const use = caps.routines
    ? ` A routine imports a module (import * as <module> from "minebot-sdk/routines/<module>") and calls its routines as <module>.<routine>(ctx, { ... }); POST /call { name: "<module>.<routine>"${example}, args?, timeoutMs? } calls one as a run, with no bind, and answers like any call.`
    : "";
  return `Built-in routines: ${features.builtins.join(", ")}. Reference: minebot builtins docs [module...] (GET /builtins/docs?names=), minebot builtins search <query> (GET /builtins/search?q=), minebot builtins source <module> (GET /builtins/source?name=); GET /builtins lists the modules with how often each built-in routine succeeded and failed on this body.${use}`;
}

