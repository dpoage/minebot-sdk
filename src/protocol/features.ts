// The one capability table. Everything an agent can see is derived from BodyFeatures through
// CAPABILITY_GATES: the daemon's routes, the MCP tools, the CLI usage, the run context,
// the run reference, and the wiki's view. A capability that is off is absent from every
// surface, not hidden behind an error.
import type { WikiMode } from "./types.ts";

/** The optional parts of a body. Everything an agent can see derives from this, so it never learns about a feature its body does not offer. */
export interface BodyFeatures {
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
export const CAPABILITIES = ["wiki", "lessons", "milestones", "reflexes", "routines", "builtins", "call"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The single source of truth for what each capability needs. Each entry is a predicate over
 * BodyFeatures; every surface asks this table instead of re-deriving the answer.
 */
export const CAPABILITY_GATES: Record<Capability, (features: BodyFeatures) => boolean> = {
  wiki: (f) => f.wiki !== "off",
  lessons: (f) => f.wiki === "write",
  milestones: (f) => f.milestones,
  reflexes: (f) => f.reflexes && f.routines,
  routines: (f) => f.routines,
  builtins: (f) => f.builtins.length > 0,
  // Calling is the library's actions (routines) and the shipped routines (builtins): each name is checked by its kind where the call is made.
  call: (f) => f.routines || f.builtins.length > 0,
};

/** Which capabilities a body offers, in CAPABILITIES order. */
export function capabilities(features: BodyFeatures): Record<Capability, boolean> {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, CAPABILITY_GATES[capability](features)])) as Record<Capability, boolean>;
}

/**
 * The members of the context a run's default function receives, in the order of `Object.keys(ctx)`, each
 * with its reference line: the one list the program reference takes its member names and lines from.
 */
function contextMembers(features: BodyFeatures): { name: string; line: string }[] {
  const caps = capabilities(features);
  const members = [
    { name: "log", line: "log(...args): append to the run's output. console.log, info, warn, error and debug append to it too, and still print where the host prints them." },
    { name: "sleep", line: "sleep(ms): resolves after ms; rejects when the run is aborted." },
    { name: "signal", line: "signal: AbortSignal that fires on timeout or stop. Check signal.aborted in long loops." },
    { name: "on", line: "on(event, handler): subscribe to a bot event. When the run ends or is aborted, the body removes the handlers that exist at that moment; one added after that is not kept." },
    { name: "bot", line: 'bot: the mineflayer Bot (https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md). The pathfinder plugin is loaded: use bot.pathfinder.goto(goal), with `import { goals, Movements } from "mineflayer-pathfinder"` and `import { Vec3 } from "vec3"`.' },
    { name: "notes", line: 'notes: your notepad on this body; it survives body restarts and resets of your context. notes.set(key, text), notes.get(key) -> text, notes.list() -> [{ key, text, updated }], notes.delete(key). Keys are lowercase, e.g. "plan" or "places/base".' },
    {
      name: "status",
      line: caps.milestones
        ? "status(): resolves to { deaths, reconnects, milestones }; milestones is progress toward this body's milestones, graded from the server's statistics, or null."
        : "status(): resolves to { deaths, reconnects }.",
    },
  ];
  if (caps.wiki) {
    const lessons = caps.lessons ? ", and lessons that agents wrote" : "";
    const write = caps.lessons ? ", wiki.addLesson({ title, tags, body }) to record what you learned" : "";
    members.push({ name: "wiki", line: `wiki: notes on mechanics, flows, and quirks${lessons}. wiki.search(query, limit?) -> hits, wiki.read(id) -> markdown, wiki.list(section?)${write}.` });
  }
  members.push({ name: "store", line: "store(namespace): a persistent JSON store that survives body restarts and is shared by every run that opens the same namespace (a name of 1-48 lowercase letters, digits, _ and -, starting with a letter; notes and body are the body's own). store(namespace).get(key) -> value, .set(key, value), .delete(key), .keys()." });
  return members;
}

/**
 * Describes the run environment of one body. Shown to agents by the MCP server and the CLI.
 * Lists only the features the body offers, so an agent does not spend turns on locked ones.
 */
export function programApiDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const members = contextMembers(features);
  const library = caps.routines
    ? ` It can also import the library's modules by file name (\`import { helper } from "./helper.ts"\`: the module as saved when the run starts); any other relative path or URL is refused.`
    : " This body has no library of saved modules, so a relative import fails.";
  const sdk = caps.routines ? " such as minebot-sdk/routine" : "";
  const slot = caps.reflexes ? "runs, calls and reflex firings" : "runs and calls";
  // The routine-related sections: the library's, then the built-ins' (each only where the body offers it).
  const routines = `${caps.routines ? `\n\n${routinesDoc(features)}` : ""}${caps.builtins ? `\n\n${builtinsDoc(features)}` : ""}`;
  return `A run is a TypeScript or JavaScript module (types are stripped, not checked) that the body evaluates inside the bot host, against a live Mineflayer bot, afresh each time. Its result is its default export: \`export default async (ctx, args) => result\` is called with the run's context and the run's args (a JSON object, {} when none) and its awaited return is the result; any other default export is the result itself (awaited); a module without a default export has no result. A \`return\` statement outside a function is a syntax error, so the module cannot end with one. The result is sent back as JSON.

It can import Node's core modules (\`node:fs\`, \`node:os\`), the packages this body ships (mineflayer, mineflayer-pathfinder, vec3, minecraft-data, prismarine-*, zod), and \`minebot-sdk/<subpath>\`${sdk} (bare \`minebot-sdk\` does not resolve); require() of a package or a core module works too.${library}

ctx, the default function's first argument, has exactly: ${members.map((member) => member.name).join(", ")}.
${members.map((member) => `- ${member.line}`).join("\n")}

One run at a time: ${slot} share one slot. On timeout or stop, the body halts pathfinding, digging and movement, ctx.sleep rejects, and the on() handlers that exist at that moment are removed. A timer or bot.on listener that you make yourself outlives the run, and one that throws after the run has ended restarts the bot host. If the run does not end within 5 seconds of the abort, the body kills the bot host and restarts it, also when the run blocks the host with synchronous code; the restart reconnects as the same player. Check ctx.signal.aborted in long loops so the run ends in time. globalThis is the host's: it persists between runs until the bot host restarts (after a crash, or when the body kills it for a run that does not stop).${routines}`;
}

/** The routines section of the program reference, for a body that offers them. */
function routinesDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const reflexes = caps.reflexes
    ? `\n- Reflexes: POST /bind { kind: "reflex", name, routine, on: ["hurt"], when?, from?, match?, cooldownMs?, timeoutMs?, preempt?, priority?, enabled? } binds a routine to events. The routine's default export is called as (ctx, { event }) with the event { seq, type, time, data }; \`when\` is a JavaScript expression over \`event\` and \`bot\` that must be truthy; \`from\` and \`match\` filter chat as waits do; a reflex cannot listen to reflex_* events. Defaults: cooldownMs 1000, timeoutMs 30000, enabled true, preempt false, priority 0. A firing waits until no run is active; with preempt: true it stops the running run first (a higher priority wins, and a reflex never stops a running reflex of equal or higher priority). The body records reflex_fired and reflex_finished events for it, and a reflex that fails 3 times in a row disables itself (reflex_disabled; bind it again to re-enable it). A name belongs to one binding at a time (409 otherwise), and a body keeps at most 50 reflexes. A stored entry that cannot be loaded as a reflex (one saved before reflexes, say) is reported as a reflex_error event each time the bot host starts, keeps its name and counts toward the limit until POST /unbind removes it; an entry under a name POST /unbind does not accept cannot be unbound, and its reflex_error names the file to edit instead. GET /bindings lists a reflex with what it has done since the body started; POST /unbind removes it.`
    : "";
  return `Routines: a routine is a TypeScript module saved in this body's library and called by name: a run's default function, kept. Its default export is a function (ctx, args) => result, usually \`export default defineRoutine({ description?, args?, returns? }, async (ctx, args) => result)\` with \`import { defineRoutine, z } from "minebot-sdk/routine"\`; args and returns are optional zod schemas that validate a call, and absent args are {}. It imports what a run does, and other saved routines by file name (\`import { helper } from "./helper.ts"\`; save the imported routine first).
- Library over HTTP: GET /routines, GET /routines/source?name=, POST /routines/save { name, source } (answers the routine and the type check of its source, which does not stop the save; a source is limited to 128 KiB), GET /routines/versions?name=, POST /routines/revert { name, version }. Routine and binding names are 1-48 lowercase letters, digits, _ and -, starting with a letter.
- Bindings: POST /bind { kind: "action", name, routine } names a saved routine for calling (the same name replaces it); GET /bindings lists them; POST /unbind { name } removes one. Bindings persist across body restarts.${reflexes}
- POST /call { name, args?, timeoutMs? } calls the routine bound to name with the JSON args and answers like /run: status, result (the routine's return value), error, logs. A call is a run: one at a time with the other runs, stopped by /stop, ended by its timeout.`;
}

/** The built-in routines section of the program reference, for a body that offers any. Importing them is told only where the body also has routines; calling them by name, wherever calls are served. */
function builtinsDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const example = features.builtins.includes("move") ? ", e.g. move.to" : "";
  const imports = caps.routines ? ` A routine imports a module (import * as <module> from "minebot-sdk/routines/<module>") and calls its routines as <module>.<routine>(ctx, { ... }).` : "";
  // Without a library the routines section, which says what a call is, is absent.
  const call = ` POST /call { name: "<module>.<routine>"${example}, args?, timeoutMs? } calls one as a run${caps.routines ? ", with no bind" : ""}, and answers like /run: status, result, error, logs.${caps.routines ? "" : " A call is a run: one at a time with the other runs, stopped by /stop, ended by its timeout."}`;
  return `Built-in routines: ${features.builtins.join(", ")}. Reference: minebot builtins docs [module...] (GET /builtins/docs?names=), minebot builtins search <query> (GET /builtins/search?q=), minebot builtins source <module> (GET /builtins/source?name=); GET /builtins lists the modules with how often each built-in routine succeeded and failed on this body.${imports}${call}`;
}

