// Serves one body's API as MCP tools over stdio. The body endpoint is re-read per call, so body restarts are fine.
//
// The default `core` tool set is what an agent needs to drive a body through runs: observe, run,
// stop, wait, events, a finished run's outcome (get_run), chat, and the references. send_chat is core
// although a run's ctx has bot.chat: while another run holds the slot a new run is refused, but chat is not.
// Everything else (status, note deletion, wiki management) is a ctx member, so `core` leaves those
// tools out; `full` serves them as tools too. Notes are core: writing one must not cost the run slot.
// Tools for optional features exist only while the body offers the feature, so an agent does not
// learn about features its body lacks. `toolPlan` derives the gated tool set from the capability
// table; the same function is what the capability test turns against every feature.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BindingName,
  BuiltinCallName,
  type BindInput,
  capabilities,
  type Capability,
  CallInput,
  ChatInput,
  DEFAULT_TIMEOUT_MS,
  KEPT_RUNS,
  type BodyFeatures,
  LessonInput,
  MAX_TIMEOUT_MS,
  NoteKey,
  NoteText,
  ReflexInput,
  RevertRoutineInput,
  RoutineName,
  RoutineSource,
  RunInput,
  UnbindInput,
  WaitInput,
} from "../protocol/index.ts";
import { formatBound, formatBuiltinHits, formatBuiltins, formatHits, formatLibrary, formatNotes, formatRevertedRoutine, formatRoutineVersions, formatRun, formatSavedRoutine, formatStatus } from "./render.ts";
import { BodyClient } from "./client.ts";
import { Digest } from "./digest.ts";
import { eventTypesFor } from "../protocol/event-types.ts";
import { isReflexEvent } from "../protocol/event-filter.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * The one sentence listing the event types a body with these features can push. `triggerable` drops
 * the reflex_* types, which a reflex may not listen to, for the reflex binding's description.
 */
function eventTypesLine(features: BodyFeatures, triggerable = false): string {
  const types = eventTypesFor(capabilities(features).reflexes).filter((type) => !triggerable || !isReflexEvent(type));
  return `Event types: ${types.join(", ")}.`;
}

/** What the event tools say before the body's features are known: the types every body can push. */
const DEFAULT_EVENT_TYPES_LINE = `Event types: ${eventTypesFor(false).join(", ")}.`;

const GET_EVENTS_DESCRIPTION = (types: string) =>
  `The body's event log, oldest first. Without \`since\` it returns the newest \`limit\` events; with \`since\` (a \`next\` or \`latest\` from an earlier answer) the oldest events after it. Every answer names the log's \`latest\` seq, and \`next\` goes into the next call's \`since\`. ${types}`;

const WAIT_FOR_DESCRIPTION = (types: string) =>
  `The cheap way to idle until something happens: blocks until an event that matches arrives, then returns it. Cheaper than polling get_events or looping sleep in a program: nothing runs until the event lands. Waits for any event type or filters it; a wait whose types are exactly one of day or night (repeated or not) answers at once while that phase already holds, including right after the body joined in it. ${types}`;

const API_DOC_FALLBACK = "Call the api_reference tool for how a run works and what ctx holds.";

/** Which tools `minebot mcp` serves: the core set, or every tool. */
export const TOOL_SETS = ["core", "full"] as const;
export type ToolSet = (typeof TOOL_SETS)[number];

/** The tools of the core set. A run reaches everything else through its context (`ctx`). */
const CORE_TOOLS: Readonly<Record<string, true>> = {
  observe: true,
  run_program: true,
  stop_program: true,
  wait_for: true,
  get_events: true,
  get_run: true,
  api_reference: true,
  builtin_docs: true,
  builtin_search: true,
  call_routine: true,
  bind_routine: true,
  notes_list: true,
  notes_set: true,
};

/** Which kinds of name a call takes: an action's (the body has routines) and a built-in's (it has built-ins). */
export type CallKinds = Pick<Record<Capability, boolean>, "routines" | "builtins">;

/** What `call_routine` takes as `name` on a body: the names of the kinds it can call, and no other. */
export function callNameSchema({ routines, builtins }: CallKinds): z.ZodType<string> {
  if (routines && builtins) return CallInput.shape.name.describe("The name of an action, as bound by bind_routine, or of a built-in routine: <module>.<routine>, e.g. move.to");
  if (builtins) return BuiltinCallName.describe("The name of a built-in routine: <module>.<routine>, e.g. move.to");
  return BindingName.describe("The name of an action, as bound by bind_routine");
}

/** The description of every capability-gated tool, and whether it is served, by capability state and tool set: one place, reused by apply() and the tests. */
export function toolPlan(features: BodyFeatures, toolSet: ToolSet): Record<string, { enabled: boolean; description: string }> {
  const caps = capabilities(features);
  const plan: Record<string, { enabled: boolean; description: string }> = {
    wiki_search: {
      enabled: caps.wiki,
      description: `Search the wiki: verified notes on game mechanics, step-by-step flows, and known quirks of this Minecraft version and bot library${caps.lessons ? ", plus lessons other agents wrote" : ""}. Search before guessing how something works.`,
    },
    wiki_read: {
      enabled: caps.wiki,
      description: "Read a wiki page by id, e.g. 'quirks/drops-fall-out-of-reach'.",
    },
    wiki_list: {
      enabled: caps.wiki,
      description: `List wiki pages, optionally in one section: mechanics, flows, quirks, reference, minebot${caps.lessons ? ", lessons" : ""}.`,
    },
    wiki_add_lesson: {
      enabled: caps.lessons,
      description: "Record a lesson you verified in game (a mechanic, a pitfall, a working approach) so other agents can find it. Lessons are marked unreviewed.",
    },
    call_routine: {
      enabled: caps.call,
      description: `${
        caps.routines
          ? `Call an action: a saved routine that bind_routine bound to a name, with JSON args${caps.builtins ? ", or a built-in routine by its <module>.<routine> name (e.g. move.to), which needs no bind" : ""}`
          : "Call a built-in routine by its <module>.<routine> name (e.g. move.to), with JSON args"
      }. Blocks until the call returns, fails, or times out, and answers like run_program: status, logs, error or result. One run at a time, runs included.`,
    },
    list_builtins: {
      enabled: caps.builtins,
      description: "The built-in routine modules this body offers, their uses, and how often each built-in routine that has run on this body succeeded and failed (stats).",
    },
    builtin_docs: {
      enabled: caps.builtins,
      description: `Reference for built-in routines: call shape (<module>.<routine>(ctx, { ... })), arguments with types and defaults, and return values. Omit modules for every offered module.${caps.routines ? " A routine imports a module (minebot-sdk/routines/<module>) and calls its routines; call_routine calls one by its <module>.<routine> name." : ""}`,
    },
    builtin_search: {
      enabled: caps.builtins,
      description: "Find built-in routines by what they do, e.g. 'collect logs': ranks the built-in routines and their modules by name, description, and argument names. A hit for a built-in routine that has run on this body says how often it worked.",
    },
    builtin_source: {
      enabled: caps.builtins,
      description: "Print a built-in module's source file.",
    },
    bind_routine: {
      enabled: caps.routines,
      description: caps.reflexes
        ? `Bind a name to a saved routine (a TypeScript module in this body's routine library). kind "action": call_routine runs it by name with JSON args. kind "reflex": the body calls the routine on its own whenever an event of the types in \`on\` arrives, narrowed by when, from, and match, and limited by cooldown_ms, timeout_ms, preempt, priority, and enabled; the routine is called as (ctx, { event }) with event { seq, type, time, data }. A reflex that fails 3 times in a row disables itself; bind it again to enable it. Pass \`source\` to save the module as <routine>.ts and bind it in one call; a refused bind leaves the saved module. Bindings are kept on the body and survive restarts. ${eventTypesLine(features, true)}`
        : `Bind a name to a saved routine (a TypeScript module in this body's routine library) as an action: call_routine runs it by name with JSON args. Pass \`source\` to save the module as <routine>.ts and bind it in one call; a refused bind leaves the saved module. Bindings are kept on the body and survive restarts. ${eventTypesLine(features)}`,
    },
    list_routines: {
      enabled: caps.routines,
      description: caps.reflexes
        ? "The saved routines with their versions, and the names bound to them: actions, and reflexes with how often each ran since the body started and how the last run ended."
        : "The saved routines with their versions, and the names bound to them as actions.",
    },
    routine_save: {
      enabled: caps.routines,
      description:
        "Save a routine: a TypeScript module whose default export is a function (ctx, args) => result, usually `export default defineRoutine({ description?, args?, returns? }, async (ctx, args) => result)` with `import { defineRoutine, z } from \"minebot-sdk/routine\"`. Write `import`; `require` works too, for the packages and Node built-ins below. It may import Node built-ins, the packages this body ships (mineflayer, mineflayer-pathfinder, vec3, minecraft-data, prismarine-*, zod), `minebot-sdk/<subpath>` (bare `minebot-sdk` does not resolve), and other saved routines by file name (`./helper.ts`; save the imported routine first). The answer includes the type check of the source, which does not stop the save; fix the errors and save again. Saving over a routine keeps the old source (routine_versions). Bind it with bind_routine to call it.",
    },
    routine_source: {
      enabled: caps.routines,
      description: "Print a saved routine's source.",
    },
    routine_versions: {
      enabled: caps.routines,
      description: "List the saved versions of a routine: number, time, and which body saved it.",
    },
    routine_revert: {
      enabled: caps.routines,
      description: "Save an earlier version of a routine again, as a new version.",
    },
    unbind_routine: {
      enabled: caps.routines,
      description: caps.reflexes
        ? "Remove a binding: the action stops being callable, or the reflex stops firing. A stored entry that the body skipped at start and reported as reflex_error is removed by its name too, which frees the name, when the name is one this tool accepts (1-48 lowercase letters, digits, and . _ -, starting with a letter or digit); any other such entry cannot be removed here, and its reflex_error names the file to edit instead. The saved routine stays."
        : "Remove a binding: the action stops being callable. The saved routine stays.",
    },
  };
  for (const [name, entry] of Object.entries(plan)) entry.enabled &&= toolSet === "full" || Object.hasOwn(CORE_TOOLS, name);
  return plan;
}

/**
 * The event tools' descriptions for a body with these features: each lists exactly the event types
 * that body can push, and bind_routine lists only the types a reflex may listen to.
 */
export function eventToolDescriptions(features: BodyFeatures): { wait_for: string; get_events: string; bind_routine: string } {
  return {
    wait_for: WAIT_FOR_DESCRIPTION(eventTypesLine(features)),
    get_events: GET_EVENTS_DESCRIPTION(eventTypesLine(features)),
    bind_routine: toolPlan(features, "full").bind_routine!.description,
  };
}

/** Serves one body's API as MCP tools over stdio. */
export async function serveMcp(bodyName: string, toolSet: ToolSet): Promise<void> {
  const server = new McpServer({ name: `minebot-${bodyName}`, version: "0.1.0" });

  let known: string | undefined;
  const sync = async (): Promise<void> => {
    let features: BodyFeatures;
    let apiDoc: string;
    try {
      const client = await BodyClient.connect(bodyName);
      [features, { doc: apiDoc }] = await Promise.all([client.features(), client.apiDoc()]);
    } catch {
      return; // Body not up: keep what the last answer allowed.
    }
    const answer = json([features, apiDoc]);
    if (answer === known) return;
    known = answer;
    apply(features, apiDoc);
  };

  // The first line of every response: the high-signal events logged since the previous one (see digest.ts).
  const digest = new Digest(() => BodyClient.connect(bodyName));

  const call = async (fn: (client: BodyClient) => Promise<string>): Promise<ToolResult> => {
    await sync();
    await digest.start();
    let result: ToolResult;
    try {
      result = { content: [{ type: "text", text: await fn(await BodyClient.connect(bodyName)) }] };
    } catch (err) {
      result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
    // Read after the tool ran, so a run's own deaths are in its response.
    const line = await digest.take();
    if (line) result.content[0]!.text = `${line}\n${result.content[0]!.text}`;
    return result;
  };

  server.registerTool(
    "observe",
    {
      description: `Snapshot of the Minecraft player "${bodyName}" as one line: position, health, food, time, whether the sky is open, held item, inventory, nearby creatures, and program state. Pass full: true for the complete JSON.`,
      inputSchema: { full: z.boolean().optional().describe("Return the complete observation as JSON") },
    },
    ({ full }) => call(async (c) => (full ? json(await c.observe()) : await c.brief())),
  );

  const status = server.registerTool(
    "status",
    { description: "Deaths and reconnects since the body started.", inputSchema: {} },
    () => call(async (c) => formatStatus(await c.status())),
  );

  const notesList = server.registerTool(
    "notes_list",
    {
      description:
        "Your notes on this body: a persistent notepad that survives body restarts and resets of your context. Keep your plan, progress, and important places here, and read them when you start or lose track.",
      inputSchema: {},
    },
    () =>
      call(async (c) => {
        const { notes } = await c.notes();
        return notes.length === 0 ? "no notes" : formatNotes(notes);
      }),
  );

  const notesSet = server.registerTool(
    "notes_set",
    {
      description: 'Create or replace a note. Keys: 1-64 lowercase letters, digits, and . _ / -, e.g. "plan" or "places/base".',
      inputSchema: { key: NoteKey, text: NoteText },
    },
    ({ key, text }) => call(async (c) => json(await c.setNote(key, text))),
  );

  const notesDelete = server.registerTool(
    "notes_delete",
    { description: "Delete a note.", inputSchema: { key: NoteKey } },
    ({ key }) => call(async (c) => json(await c.deleteNote(key))),
  );

  const runDescription = (apiDoc: string) =>
    `Run a TypeScript or JavaScript module that controls the Minecraft player "${bodyName}": its default export is the result (a function is called with ctx and args). Blocks until the run returns, fails, or times out. Only one run at a time.\n\n${apiDoc}`;
  const runProgram = server.registerTool(
    "run_program",
    {
      description: runDescription(API_DOC_FALLBACK),
      inputSchema: {
        code: z.string().describe("A module. Write the result as `export default <value>` or `export default async (ctx, args) => <value>`; a `return` statement outside a function is a syntax error."),
        args: RunInput.shape.args.describe("A JSON object passed to the default function as args. Default {}."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`Abort the run after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      },
    },
    ({ code, args, timeout_ms }) => call(async (c) => formatRun(await c.run(code, args, timeout_ms))),
  );

  server.registerTool(
    "api_reference",
    { description: "How a run works and what its context (ctx) holds on this body.", inputSchema: {} },
    () => call(async (c) => (await c.apiDoc()).doc),
  );

  server.registerTool(
    "stop_program",
    { description: "Abort the current run and halt movement, pathfinding and digging.", inputSchema: {} },
    () => call(async (c) => json(await c.stop())),
  );

  const getEvents = server.registerTool(
    "get_events",
    {
      description: GET_EVENTS_DESCRIPTION(DEFAULT_EVENT_TYPES_LINE),
      inputSchema: {
        since: z.number().int().nonnegative().optional().describe("Cursor from a previous answer (`next`): return only events after it. Omit for the newest events."),
        limit: z.number().int().min(1).max(1000).optional().describe("At most this many events, 1-1000. Default 200."),
      },
    },
    ({ since, limit }) => call(async (c) => json(await c.events(since, limit))),
  );

  server.registerTool(
    "get_run",
    {
      description: `What a run ended with — status, logs, and error or result — after the fact, named by its seq and, for a call, its name: the run whose program_finished event carries this seq in its run field, or the most recent finished run without one. Answers like run_program. The body keeps the last ${KEPT_RUNS} finished runs; a detached caller (a timeout, a killed CLI) reads its run's outcome here instead of re-running it.`,
      inputSchema: {
        seq: z.number().int().positive().optional().describe("The run's seq: the run field of its program_finished event (the event's own seq is not it). Omit for the most recent finished run."),
      },
    },
    ({ seq }) => call(async (c) => formatRun(await c.runs(seq))),
  );

  // The limit comes from ChatInput, the schema POST /chat validates with, so the whisper check and the
  // text below cannot drift from it.
  const CHAT_LIMIT = ChatInput.shape.message.maxLength!;

  server.registerTool(
    "send_chat",
    {
      description:
        "Speak as the player: a public chat `message`, or a whisper to one player by passing `to`. Works while a run is in progress: run_program and call_routine are refused with a busy error then, but send_chat is not. Without `to` a `message` that starts with / is sent as a command; with `to` the whisper is `/msg <to> <message>`, so a leading / is whispered literally and runs no command. Whispering a player who is not online still answers sent; the server's 'No player was found' reply arrives as a system event (see get_events, wait_for).",
      inputSchema: {
        message: ChatInput.shape.message.describe(
          `What to say: 1-${CHAT_LIMIT} characters without \`to\`, and a leading / sends it as a command, e.g. /time set day. With \`to\` the text is whispered as-is — a leading / stays text and runs no command — and must leave room for \`/msg <to> \`: at most ${CHAT_LIMIT} minus that prefix's length, e.g. ${CHAT_LIMIT - 12} characters for a 6-character name.`,
        ),
        to: z.string().optional().describe("A player's name (1-16 of letters, digits, and _): whisper so only that player sees the message, sent as /msg. Omit to speak publicly."),
      },
    },
    ({ message, to }) =>
      call(async (c) => {
        if (to === undefined) return json(await c.chat(message));
        // The client composes the whisper as a /msg chat; POST /chat sees plain chat.
        if (!/^[A-Za-z0-9_]{1,16}$/.test(to)) {
          throw new Error(`to must be a Minecraft player name: 1-16 of letters, digits, and _, e.g. "ana_1" (got ${JSON.stringify(to)})`);
        }
        const prefix = `/msg ${to} `;
        if (prefix.length + message.length > CHAT_LIMIT) {
          throw new Error(
            `"${prefix}" is ${prefix.length} characters, so with Minecraft's ${CHAT_LIMIT}-character chat limit the longest message you can whisper to ${to} is ${CHAT_LIMIT - prefix.length} characters; this message is ${message.length}. Nothing was sent.`,
          );
        }
        return json(await c.chat(prefix + message));
      }),
  );

  const waitFor = server.registerTool(
    "wait_for",
    {
      description: WAIT_FOR_DESCRIPTION(DEFAULT_EVENT_TYPES_LINE),
      inputSchema: {
        types: WaitInput.shape.types.describe("Event types, e.g. ['chat'] or ['night', 'day']; any of them matches."),
        from: WaitInput.shape.from.describe("Only chat or whisper events sent by this player."),
        match: WaitInput.shape.match.describe("Case-insensitive regular expression over chat, whisper, and system messages."),
        since: WaitInput.shape.since.describe("Cursor from a previous wait. Omit to wait only for events after now."),
        timeout_ms: WaitInput.shape.timeoutMs.describe(`Give up after this many milliseconds; the answer is then "timed out". Default ${DEFAULT_TIMEOUT_MS}.`),
      },
    },
    ({ types, from, match, since, timeout_ms }) =>
      call(async (c) => {
        const waited = await c.wait({ types, from, match, since, timeoutMs: timeout_ms });
        return waited.event ? json(waited.event) : "timed out";
      }),
  );

  // Tools of optional features. Each starts disabled; `apply` enables the ones the body offers.
  const listBuiltins = server.registerTool("list_builtins", { description: "", inputSchema: {} }, () => call(async (c) => formatBuiltins((await c.builtins()).builtins)));
  const builtinDocs = server.registerTool(
    "builtin_docs",
    { description: "", inputSchema: { modules: z.array(z.string().min(1)).optional().describe("Built-in module names; omit for every offered module") } },
    ({ modules }) => call(async (c) => (await c.builtinDocs(modules ?? [])).docs),
  );
  const builtinSearch = server.registerTool(
    "builtin_search",
    {
      description: "",
      inputSchema: { query: z.string().min(1).describe("Words to look for, e.g. 'collect logs' or 'walk to'"), limit: z.number().int().positive().max(20).optional() },
    },
    ({ query, limit }) =>
      call(async (c) => {
        const { hits } = await c.searchBuiltins(query, limit);
        return hits.length === 0 ? "no matching built-ins" : formatBuiltinHits(hits);
      }),
  );
  const builtinSource = server.registerTool(
    "builtin_source",
    { description: "", inputSchema: { name: z.string().min(1).describe("A built-in module's name") } },
    ({ name }) => call(async (c) => (await c.builtinSource(name)).source),
  );
  const wikiSearch = server.registerTool(
    "wiki_search",
    {
      description: "",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for, e.g. 'iron ore pickaxe' or 'drops pickup'"),
        limit: z.number().int().positive().max(20).optional(),
      },
    },
    ({ query, limit }) =>
      call(async (c) => {
        const { hits } = await c.wikiSearch(query, limit);
        return hits.length === 0 ? "no matching pages" : formatHits(hits);
      }),
  );
  const wikiRead = server.registerTool(
    "wiki_read",
    { description: "", inputSchema: { id: z.string().min(1) } },
    ({ id }) => call(async (c) => (await c.wikiRead(id)).text),
  );
  const wikiList = server.registerTool(
    "wiki_list",
    { description: "", inputSchema: { section: z.string().optional() } },
    ({ section }) => call(async (c) => (await c.wikiList(section)).pages.map((p) => `${p.id} [${p.status}] ${p.title}${p.stale ? ` ${p.stale}` : ""}`).join("\n")),
  );
  const addLesson = server.registerTool(
    "wiki_add_lesson",
    {
      description: "",
      inputSchema: {
        title: LessonInput.shape.title,
        tags: LessonInput.shape.tags,
        body: LessonInput.shape.body.describe("Markdown: what happens, how you confirmed it, what to do"),
      },
    },
    ({ title, tags, body }) => call(async (c) => json(await c.addLesson({ title, tags, body }))),
  );

  const routineName = (description: string) => RoutineName.describe(description);
  const callArguments = {
    args: CallInput.shape.args.describe("The call's arguments: a JSON object. Default {}."),
    timeout_ms: CallInput.shape.timeoutMs.describe(`Abort the call after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
  };
  const callParams = (caps: CallKinds) => ({ name: callNameSchema(caps), ...callArguments });
  const callRoutine = server.registerTool(
    "call_routine",
    { description: "", inputSchema: callParams({ routines: true, builtins: false }) },
    ({ name, args, timeout_ms }) => call(async (c) => formatRun(await c.call(name, args, timeout_ms))),
  );
  const actionBinding = {
    kind: z.enum(["action"]).describe("action: call_routine runs it by name."),
    name: BindingName.describe("The binding's name: what call_routine takes for an action. 1-48 lowercase letters, digits, _ and -."),
    routine: routineName("The saved routine to bind"),
    source: RoutineSource.optional().describe("TypeScript source of the routine's module: saved as <routine>.ts first, then bound. Omit to bind a routine that is already saved."),
  };
  const reflexBinding = {
    ...actionBinding,
    kind: z.enum(["action", "reflex"]).describe("action: call_routine runs it by name. reflex: the body calls it when an event arrives (needs `on`)."),
    on: ReflexInput.shape.on.optional().describe("Reflex only. Event types that fire it, e.g. ['hurt'] or ['chat']; any of them matches."),
    when: ReflexInput.shape.when.describe("Reflex only. JavaScript expression over `event` and `bot` that must be truthy, e.g. event.data.health < 8."),
    from: ReflexInput.shape.from.describe("Reflex only. Only chat or whisper events sent by this player."),
    match: ReflexInput.shape.match.describe("Reflex only. Case-insensitive regular expression over chat, whisper, and system messages."),
    // The body applies the defaults, so an omitted field stays omitted here.
    cooldown_ms: ReflexInput.shape.cooldownMs.removeDefault().optional().describe("Reflex only. Minimum time between two firings. Default 1000."),
    timeout_ms: ReflexInput.shape.timeoutMs.removeDefault().optional().describe("Reflex only. Abort a run after this many milliseconds. Default 30000."),
    preempt: ReflexInput.shape.preempt.removeDefault().optional().describe("Reflex only. Stop the running program instead of waiting for it. Default false."),
    priority: ReflexInput.shape.priority.removeDefault().optional().describe("Reflex only. Waiting reflexes run highest first; a preempting one never stops a running one of equal or higher priority. Default 0."),
    enabled: ReflexInput.shape.enabled.removeDefault().optional().describe("Reflex only. Default true."),
  };
  const bindRoutine = server.registerTool(
    "bind_routine",
    { description: "", inputSchema: reflexBinding },
    ({ kind, name, routine, source, on, cooldown_ms, timeout_ms, ...reflex }) =>
      call(async (c) => {
        // A malformed request is refused before the save, so it changes nothing.
        let request: z.input<typeof BindInput>;
        if (kind === "reflex") {
          if (on === undefined) throw new Error('kind "reflex" needs on: the event types that fire it');
          request = { kind, name, routine, on, ...reflex, cooldownMs: cooldown_ms, timeoutMs: timeout_ms };
        } else {
          if ([on, cooldown_ms, timeout_ms, ...Object.values(reflex)].some((value) => value !== undefined)) {
            throw new Error('on, when, from, match, cooldown_ms, timeout_ms, preempt, priority and enabled only apply to kind "reflex"');
          }
          request = { kind, name, routine };
        }
        const saved = source === undefined ? undefined : await c.saveRoutine(routine, source);
        let bound;
        try {
          bound = await c.bind(request);
        } catch (err) {
          // The save stands: the agent fixes the binding and binds again, without the source.
          throw saved ? new Error(`${err instanceof Error ? err.message : String(err)}\nThe module "${routine}" was saved; the binding was not made.`) : err;
        }
        return [saved && formatSavedRoutine(saved), formatBound(bound)].filter(Boolean).join("\n");
      }),
  );
  const listRoutines = server.registerTool("list_routines", { description: "", inputSchema: {} }, () =>
    call(async (c) => {
      const [{ routines }, { bindings }] = await Promise.all([c.routines(), c.bindings()]);
      return formatLibrary(routines, bindings);
    }),
  );
  const routineSave = server.registerTool(
    "routine_save",
    { description: "", inputSchema: { name: routineName("The routine's name: its file name in the library, and what other routines import. 1-48 lowercase letters, digits, _ and -."), source: RoutineSource.describe("TypeScript source of the module") } },
    ({ name, source }) => call(async (c) => formatSavedRoutine(await c.saveRoutine(name, source))),
  );
  const routineSource = server.registerTool(
    "routine_source",
    { description: "", inputSchema: { name: routineName("A saved routine") } },
    ({ name }) => call(async (c) => (await c.routineSource(name)).source),
  );
  const routineVersions = server.registerTool(
    "routine_versions",
    { description: "", inputSchema: { name: routineName("A saved routine") } },
    ({ name }) => call(async (c) => formatRoutineVersions(name, (await c.routineVersions(name)).versions)),
  );
  const routineRevert = server.registerTool(
    "routine_revert",
    { description: "", inputSchema: { name: routineName("A saved routine"), version: RevertRoutineInput.shape.version.describe("A version from routine_versions") } },
    ({ name, version }) => call(async (c) => formatRevertedRoutine((await c.revertRoutine(name, version)).routine)),
  );
  const unbindRoutine = server.registerTool(
    "unbind_routine",
    { description: "", inputSchema: { name: UnbindInput.shape.name.describe("The binding to remove, or the name of a stored entry the body reported as reflex_error, if that name fits this pattern") } },
    ({ name }) => call(async (c) => json(await c.unbind(name))),
  );

  const setEnabled = (tool: RegisteredTool, on: boolean) => (on ? tool.enable() : tool.disable());
  function apply(features: BodyFeatures, apiDoc: string): void {
    const plan = toolPlan(features, toolSet);
    const tools: Record<string, RegisteredTool> = {
      list_builtins: listBuiltins,
      builtin_docs: builtinDocs,
      builtin_search: builtinSearch,
      builtin_source: builtinSource,
      wiki_search: wikiSearch,
      wiki_read: wikiRead,
      wiki_list: wikiList,
      wiki_add_lesson: addLesson,
      call_routine: callRoutine,
      bind_routine: bindRoutine,
      list_routines: listRoutines,
      routine_save: routineSave,
      routine_source: routineSource,
      routine_versions: routineVersions,
      routine_revert: routineRevert,
      unbind_routine: unbindRoutine,
    };
    for (const [name, tool] of Object.entries(tools)) {
      setEnabled(tool, plan[name]!.enabled);
      tool.update({ description: plan[name]!.description });
    }
    // A body without reflexes offers the action kind and none of the reflex fields.
    bindRoutine.update({ paramsSchema: capabilities(features).reflexes ? reflexBinding : actionBinding });
    callRoutine.update({ paramsSchema: callParams(capabilities(features)) });
    status.update({
      description: capabilities(features).milestones
        ? "Deaths and reconnects since the body started, and progress toward this body's milestones (graded from the server's statistics)."
        : "Deaths and reconnects since the body started.",
    });
    runProgram.update({ description: runDescription(apiDoc) });
    const eventTools = eventToolDescriptions(features);
    getEvents.update({ description: eventTools.get_events });
    waitFor.update({ description: eventTools.wait_for });
  }

  for (const tool of [listBuiltins, builtinDocs, builtinSearch, builtinSource, wikiSearch, wikiRead, wikiList, addLesson, callRoutine, bindRoutine, listRoutines, routineSave, routineSource, routineVersions, routineRevert, unbindRoutine]) tool.disable();
  // Ungated tools outside the core set: a run's context has status() and notes_delete.
  if (toolSet !== "full") for (const tool of [status, notesDelete]) tool.disable();
  await sync();
  await server.connect(new StdioServerTransport());
}
