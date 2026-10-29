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
    { name: "bot", line: 'bot: the mineflayer Bot (https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md). The pathfinder plugin is loaded: `import { goals, Vec3 } from "minebot-sdk/routine"`, then `await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))` walks to within 1 block of x, y, z (goto takes a goal instance, not an object).' },
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

/** One row of the facts table: a member agents wrote that does not exist (or is not what they took it for), and the real one. Cells are the reference's text; a wrong cell is never checked against a real bot. */
export interface BotFact {
  wrong: string;
  right: string;
}

/** The members of the Mineflayer fork that agents' runs got wrong, one row per mistake seen in practice. The drift test (test/reference-drift.test.ts) holds every `bot.` member of the right cells to a real bot. */
export const BOT_FACTS: readonly BotFact[] = [
  { wrong: "`bot.entity.health`", right: "`bot.health` (a number)" },
  { wrong: "`block.type`", right: '`block.name` (e.g. "oak_log"; `block.type` is a numeric id)' },
  { wrong: "`bot.entities.values()`, `bot.entities.filter(f)`", right: "`Object.values(bot.entities)` (`bot.entities` is a plain object keyed by id, not a Map or an array)" },
  { wrong: "`bot.inventory.items.filter(f)`", right: "`bot.inventory.items().filter(f)` (`items` is a method)" },
  { wrong: "`bot.selectItem(item)`", right: '`await bot.equip(item, "hand")`' },
  { wrong: "`bot.isRaining()`", right: "`bot.isRaining` (a boolean, not a method)" },
  { wrong: "`bot.daylight()`, `bot.time.moment`", right: "`bot.time.timeOfDay` (ticks, 0-23999) or `bot.time.isDay` (a boolean)" },
  { wrong: "`pos.floored()` on a plain `{ x, y, z }`", right: "`new Vec3(x, y, z).floored()` (only a Vec3 has `.floored()`)" },
  { wrong: "`bot.useOn(entity)`, `bot.interact(entity)`", right: "`await bot.activateEntity(entity)` (use, milk, trade)" },
];

/** One row of the goal table: what an agent wants to do, and the built-in routines (`<module>.<routine>`) that already do it, written as a call (`<module>.<routine>(ctx, { ... })`) where the goal needs args. */
export interface GoalBuiltin {
  goal: string;
  routines: readonly string[];
}

/**
 * The goals agents hand-rolled although a built-in does them, in the order the reference lists them.
 * A row is shown only where the body offers the module of each of its routines (`goalRows`), so the
 * reference never points at a module the body lacks.
 */
export const GOAL_BUILTINS: readonly GoalBuiltin[] = [
  { goal: "sell to or buy from a villager or wandering trader", routines: ["trade.offers", "trade.buy"] },
  { goal: "make tools, or any item you can craft", routines: ["crafter.make"] },
  { goal: "place a block", routines: ["place.place"] },
  { goal: "sleep in a bed", routines: ["survival.sleep"] },
  { goal: "find blocks (ores, logs, water, chests) around you", routines: ["explorer.scan"] },
  { goal: "plan what a craft still needs", routines: ["crafter.plan"] },
  { goal: "sleep as soon as night falls", routines: ["survival.sleep(ctx, { wait: true })"] },
  { goal: "climb out of a pit or hole", routines: ["explorer.surface"] },
  { goal: "mine blocks and collect what drops", routines: ["gatherer.gather"] },
  { goal: "pick up items on the ground", routines: ["gatherer.collectDrops"] },
];

/** The goal rows a body can show: those whose routines are all of modules it offers. */
function goalRows(features: BodyFeatures): GoalBuiltin[] {
  return GOAL_BUILTINS.filter(({ routines }) => routines.every((routine) => features.builtins.includes(routine.slice(0, routine.indexOf(".")))));
}

/**
 * The built-in call the run template makes for a module it can be written against: one that reads
 * state or stops what is not running, so the template runs verbatim, changing nothing, on any body
 * that offers the module. The first entry whose module the body offers wins.
 */
const TEMPLATE_CALLS: readonly { module: string; lines: readonly string[]; result: string }[] = [
  {
    module: "inventory",
    lines: ["const totals = await inventory.list(ctx, {});", "ctx.log(`carrying ${Object.keys(totals).length} item types`);"],
    result: "return { at: here.toArray(), itemTypes: Object.keys(totals).length };",
  },
  {
    module: "sense",
    lines: ['const stone = await sense.find(ctx, { blocks: "stone" });', "ctx.log(`stone in reach: ${stone.length} positions`);"],
    result: "return { at: here.toArray(), stoneNearby: stone.length };",
  },
  {
    module: "move",
    lines: ["await move.stop(ctx, {});", 'ctx.log("stopped any pathfinding");'],
    result: "return { at: here.toArray() };",
  },
];

/**
 * One complete run an agent can copy, change, and send as it is: its imports at the top of the module,
 * above `export default`, then the default function. The built-in call is included only where the body
 * both has routines and offers the module (a built-in import is told only there, as `builtinsDoc`
 * does); the template is complete without it.
 */
function runTemplate(features: BodyFeatures): string {
  const caps = capabilities(features);
  const call = caps.routines ? TEMPLATE_CALLS.find(({ module }) => features.builtins.includes(module)) : undefined;
  const lines = call?.lines ?? ["ctx.log(`standing at ${here.x},${here.y},${here.z}`);"];
  const result = call?.result ?? "return { at: here.toArray() };";
  return [
    'import { Vec3 } from "minebot-sdk/routine";',
    ...(call ? [`import * as ${call.module} from "minebot-sdk/routines/${call.module}";`] : []),
    "",
    "export default async (ctx, args) => {",
    "  const here = new Vec3(ctx.bot.entity.position.x, ctx.bot.entity.position.y, ctx.bot.entity.position.z);",
    ...lines.map((line) => `  ${line}`),
    `  ${result}`,
    "};",
  ].join("\n");
}

/**
 * Describes the run environment of one body. Shown to agents by the MCP server and the CLI.
 * Lists only the features the body offers, so an agent does not spend turns on locked ones.
 */
export function programApiDoc(features: BodyFeatures): string {
  const caps = capabilities(features);
  const members = contextMembers(features);
  const library = caps.routines
    ? ` It can also import the library's modules by file name (\`import { helper } from "./helper.ts"\`, with or without a query or fragment after the name: the module as saved when the run starts); importing an absolute path, a \`file:\` URL, or a relative path to anything but a module of the library fails.`
    : " This body has no library of saved modules, so a relative import fails.";
  const facts = BOT_FACTS.map(({ wrong, right }) => `| ${wrong} | ${right} |`).join("\n");
  const slot = caps.reflexes ? "runs, calls and reflex firings" : "runs and calls";
  // What a wrong argument can be a call of, named only as far as the body's capabilities allow: the import
  // path is told only where a routine library can import it, and a built-in only where one is offered.
  const callee = caps.builtins && caps.routines ? "the bot or a module under `minebot-sdk/routines/`" : caps.builtins ? "the bot or a built-in routine" : "the bot";
  // The routine-related sections: the library's, then the built-ins' (each only where the body offers it).
  const routines = `${caps.routines ? `\n\n${routinesDoc(features)}` : ""}${caps.builtins ? `\n\n${builtinsDoc(features)}` : ""}`;
  return `A run is a TypeScript or JavaScript module that the body type-checks, then evaluates inside the bot host, against a live Mineflayer bot, afresh each time. Its result is its default export: \`export default async (ctx, args) => result\` is called with the run's context and the run's args (a JSON object, {} when none) and its awaited return is the result; any other default export is the result itself (awaited); a module without a default export has no result. A \`return\` statement outside a function is a syntax error, so the module cannot end with one. The result is sent back as JSON.

The type check runs before the run starts. A run with errors that would make it fail when it runs (such as a name that is not defined, a call of a member that does not exist, the wrong number of arguments, or a block-scoped name used before its declaration) does not start: its status is error and the errors are listed, each with its line and column; fix them and run again. A wrong argument stops the run only where the call is to ${callee} and the runtime enforces the type: a value that may be absent where the parameter takes the value, a string where the parameter names an event or a control state, and a callback whose parameters differ do not stop it. The check knows the bot only as a direct call on \`bot\` or \`ctx.bot\`: an aliased receiver (\`const b = ctx.bot\`), an optional call (\`ctx.bot.craft?.(...)\`) and element access (\`ctx.bot["craft"](...)\`) are checked as ordinary function calls and do not stop the run. Other type errors do not stop a run; a member you only read (not call) does not either, and the run's log names the real member when one is known. Where the body cannot load TypeScript the check is skipped, and the run's log says so with one line, \`type check skipped: <reason>\`.

It imports the authoring helpers from \`minebot-sdk/routine\` (\`import { goals, Movements, Vec3, z } from "minebot-sdk/routine"\`), and can import Node's core modules (\`node:fs\`, \`node:os\`), the packages this body ships (mineflayer, mineflayer-pathfinder, vec3, minecraft-data, prismarine-*, zod), and \`minebot-sdk/<subpath>\` (bare \`minebot-sdk\` does not resolve); require() of a package or a core module works too.${library}

A complete run, to copy and change:

\`\`\`ts
${runTemplate(features)}
\`\`\`

ctx, the default function's first argument, has exactly: ${members.map((member) => member.name).join(", ")}.
${members.map((member) => `- ${member.line}`).join("\n")}

Members of the bot that agents get wrong (the right column is what exists on this bot):

| wrong | right |
| --- | --- |
${facts}

One run at a time: ${slot} share one slot. On timeout or stop, the body halts pathfinding, digging and movement, ctx.sleep rejects, and the body removes the run's ctx.on handlers and the listeners it added to ctx.bot. A listener you add to ctx.bot belongs to the run: the body removes it at every end, and one that throws ends the run with that error, not the host. A timer that you make yourself outlives the run, and one that throws after the run has ended restarts the bot host. A listener that must outlive the run goes on the bot itself, unscopedBot(ctx.bot) from minebot-sdk/routine: removing it is yours to do, and one that throws after the run has ended restarts the bot host, because nothing contains it. If the run does not end within 5 seconds of the abort, the body kills the bot host and restarts it, also when the run blocks the host with synchronous code; the restart reconnects as the same player. Check ctx.signal.aborted in long loops so the run ends in time. globalThis is the host's: it persists between runs until the bot host restarts (after a crash, or when the body kills it for a run that does not stop).${routines}`;
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
  const imports = caps.routines ? ` A routine imports a module (import * as <module> from "minebot-sdk/routines/<module>") and calls its routines as await <module>.<routine>(ctx, { ... }).` : "";
  // Without a library the routines section, which says what a call is, is absent.
  const call = ` POST /call { name: "<module>.<routine>"${example}, args?, timeoutMs? } calls one as a run${caps.routines ? ", with no bind" : ""}, and answers like /run: status, result, error, logs.${caps.routines ? "" : " A call is a run: one at a time with the other runs, stopped by /stop, ended by its timeout."}`;
  const rows = goalRows(features);
  const goals =
    rows.length === 0
      ? ""
      : `\n\nBefore you write it yourself, a built-in routine of this body already does it:\n\n| to | call |\n| --- | --- |\n${rows.map(({ goal, routines }) => `| ${goal} | ${routines.map((routine) => `\`${routine}\``).join(", ")} |`).join("\n")}`;
  return `Built-in routines: ${features.builtins.join(", ")}. Reference: minebot builtins docs [module...] (GET /builtins/docs?names=), minebot builtins search <query> (GET /builtins/search?q=), minebot builtins source <module> (GET /builtins/source?name=); GET /builtins lists the modules with how often each built-in routine that has run succeeded and failed on this body.${imports}${call}${goals}`;
}

