// Serves one body's API as MCP tools over stdio. The body endpoint is re-read per call, so body restarts are fine.
//
// The default `core` tool set is what an agent needs to drive a body through programs: observe,
// run, stop, wait, events, and the references. Everything else (notes, status, chat, kit and wiki
// management) is a program global, so `core` leaves those tools out; `full` serves them
// as tools too. Tools for optional features exist only while the body offers the feature, so an
// agent does not learn about features its body lacks. `toolPlan` derives the gated tool set from
// the capability table; the same function is what the capability test turns against every feature.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BindingName,
  type BindInput,
  capabilities,
  CallInput,
  ChatInput,
  DEFAULT_TIMEOUT_MS,
  type BodyFeatures,
  LessonInput,
  MAX_TIMEOUT_MS,
  NoteKey,
  NoteText,
  ReflexInput,
  RevertKitInput,
  RevertRoutineInput,
  RoutineName,
  RoutineSource,
  UnbindInput,
  TryKitInput,
  WaitInput,
} from "../protocol/index.ts";
import { formatBound, formatHits, formatKitHits, formatKitVersions, formatLibrary, formatNotes, formatRevertedRoutine, formatRoutineVersions, formatRun, formatSavedRoutine, formatStatus } from "./render.ts";
import { BodyClient } from "./client.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (value: unknown) => JSON.stringify(value, null, 2);

const API_DOC_FALLBACK = "Call the api_reference tool for the globals available to programs.";

/** Which tools `minebot mcp` serves: the core set, or every tool. */
export const TOOL_SETS = ["core", "full"] as const;
export type ToolSet = (typeof TOOL_SETS)[number];

/** The tools of the core set. Programs reach everything else through their globals. */
const CORE_TOOLS: Readonly<Record<string, true>> = { observe: true, run_program: true, stop_program: true, wait_for: true, get_events: true, api_reference: true, kit_docs: true, call_routine: true, bind_routine: true };

/** The description of every capability-gated tool, and whether it is served, by capability state and tool set: one place, reused by apply() and the tests. */
export function toolPlan(features: BodyFeatures, toolSet: ToolSet): Record<string, { enabled: boolean; description: string }> {
  const caps = capabilities(features);
  const plan: Record<string, { enabled: boolean; description: string }> = {
    list_kits: {
      enabled: caps.kits,
      description: "Kits (libraries of actions callable as kit.<kit>.<action>({ ... }) in programs), their uses and actions, which are active, and how often each action succeeded and failed on this body (stats).",
    },
    kit_docs: {
      enabled: caps.kits,
      description: "Reference for kit actions: call shape, arguments with types and defaults, and return values.",
    },
    use_kits: {
      enabled: caps.kitSwitching,
      description: "Replace the active kits, e.g. ['gatherer', 'crafter']. Used kits are added automatically. Takes effect for the next kit call.",
    },
    kit_save: {
      enabled: caps.agentKits,
      description:
        "Save your own kit as TypeScript source: `import { defineKit, action, z } from \"minebot-sdk/kit\";` (the only import allowed; it also exports nameMatcher, Position, goals and the other helpers that the built-in kits rely on), then `export default defineKit({ name, description, uses }, { actionName: action({ doc, args, returns, run }) })`; `returns` is a zod schema of what the action returns, checked on every call. Start from kit_source of a built-in kit, and check it with kit_try first. Nothing is written when the source is rejected. The answer includes `typeCheck`: type errors in the source, which do not stop the save; fix them and save again. Saving over a kit keeps the old source (kit_versions).",
    },
    kit_remove: {
      enabled: caps.agentKits,
      description: "Delete a kit you saved. Built-in kits cannot be removed.",
    },
    kit_source: {
      enabled: caps.agentKits,
      description: "Print a kit's source file: a built-in kit (the model for writing your own) or a saved one.",
    },
    kit_search: {
      enabled: caps.kits,
      description: "Find kits and actions by what they do: ranks the kits this body offers by name, description, and action docs, e.g. 'collect logs'. Each hit says whether the kit is active and how often the action worked on this body.",
    },
    kit_try: {
      enabled: caps.agentKits,
      description:
        "Run one action of kit source once without saving it: compiles and audits the source like kit_save, calls the action with args against the live body, and returns the result or the error. Type errors in the source appear in the logs; they do not stop the run. Nothing is written. Try a kit here before you save it.",
    },
    kit_versions: {
      enabled: caps.agentKits,
      description: "List the saved versions of a kit you wrote: number, time, and which body saved it. Saving over a kit keeps the old source.",
    },
    kit_revert: {
      enabled: caps.agentKits,
      description: "Save an earlier version of a kit again, as a new version. Validated like kit_save.",
    },
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
      enabled: caps.routines,
      description:
        "Call an action: a saved routine that bind_routine bound to a name, with JSON args. Blocks until the routine returns, fails, or times out, and answers like run_program: status, logs, error or result. One run at a time, programs included.",
    },
    bind_routine: {
      enabled: caps.routines,
      description: caps.reflexes
        ? "Bind a name to a saved routine (a TypeScript module in this body's routine library). kind \"action\": call_routine runs it by name with JSON args. kind \"reflex\": the body calls the routine on its own whenever an event of the types in `on` arrives (hurt, chat, night, ...), narrowed by when, from, and match, and limited by cooldown_ms, timeout_ms, preempt, priority, and enabled; the routine is called as (ctx, { event }) with event { seq, type, time, data }. A reflex cannot listen to reflex_* events. A reflex that fails 3 times in a row disables itself; bind it again to enable it. Pass `source` to save the module as <routine>.ts and bind it in one call; a refused bind leaves the saved module. Bindings are kept on the body and survive restarts."
        : "Bind a name to a saved routine (a TypeScript module in this body's routine library) as an action: call_routine runs it by name with JSON args. Pass `source` to save the module as <routine>.ts and bind it in one call; a refused bind leaves the saved module. Bindings are kept on the body and survive restarts.",
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
        "Save a routine: a TypeScript module whose default export is a function (ctx, args) => result, usually `export default defineRoutine({ description?, args?, returns? }, async (ctx, args) => result)` with `import { defineRoutine, z } from \"minebot-sdk/routine\"`. Use `import`; `require` does not work. It may import Node built-ins, the packages this body ships (mineflayer, mineflayer-pathfinder, vec3, minecraft-data, prismarine-*, zod), `minebot-sdk/<subpath>` (bare `minebot-sdk` does not resolve), and other saved routines by file name (`./helper.ts`; save the imported routine first). The answer includes the type check of the source, which does not stop the save; fix the errors and save again. Saving over a routine keeps the old source (routine_versions). Bind it with bind_routine to call it.",
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

  const call = async (fn: (client: BodyClient) => Promise<string>): Promise<ToolResult> => {
    await sync();
    try {
      return { content: [{ type: "text", text: await fn(await BodyClient.connect(bodyName)) }] };
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
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
    `Run a JavaScript program that controls the Minecraft player "${bodyName}". Blocks until the program returns, fails, or times out. Only one program runs at a time.\n\n${apiDoc}`;
  const runProgram = server.registerTool(
    "run_program",
    {
      description: runDescription(API_DOC_FALLBACK),
      inputSchema: {
        code: z.string().describe("Body of an async function. Use `return` to send a value back."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`Abort the program after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      },
    },
    ({ code, timeout_ms }) => call(async (c) => formatRun(await c.run(code, timeout_ms))),
  );

  server.registerTool(
    "api_reference",
    { description: "The globals available to programs on this body.", inputSchema: {} },
    () => call(async (c) => (await c.apiDoc()).doc),
  );

  server.registerTool(
    "stop_program",
    { description: "Abort the running program and halt movement, pathfinding and digging.", inputSchema: {} },
    () => call(async (c) => json(await c.stop())),
  );

  server.registerTool(
    "get_events",
    {
      description:
        "Events since a cursor: chat, whispers, system messages, damage, deaths, respawns, players joining or leaving, disconnects, and what the player did or noticed (item_picked_up, block_broken, block_placed, item_crafted, hostile_near, low_health, low_food). Pass the returned `next` as `since` on the next call.",
      inputSchema: {
        since: z.number().int().nonnegative().optional().describe("Cursor from a previous call. Omit for all buffered events."),
      },
    },
    ({ since }) => call(async (c) => json(await c.events(since))),
  );

  const sendChat = server.registerTool(
    "send_chat",
    {
      description: "Send a public chat message (or a command such as /msg) as the player.",
      inputSchema: { message: ChatInput.shape.message },
    },
    ({ message }) => call(async (c) => json(await c.chat(message))),
  );

  server.registerTool(
    "wait_for",
    {
      description:
        "The cheap way to idle until something happens: blocks until an event that matches arrives, then returns it. Cheaper than polling get_events or looping sleep in a program: nothing runs until the event lands. Waits for any event type (chat, whisper, system, hurt, death, night, day, hostile_near when a hostile creature comes within 16 blocks, low_health below 8, low_food below 6, item_picked_up, block_broken, ...) or filters it.",
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
  const listKits = server.registerTool("list_kits", { description: "", inputSchema: {} }, () => call(async (c) => json(await c.kits())));
  const kitDocs = server.registerTool(
    "kit_docs",
    { description: "", inputSchema: { kits: z.array(z.string().min(1)).optional().describe("Kit names; omit for the active kits") } },
    ({ kits }) => call(async (c) => (await c.kitDocs(kits ?? [])).docs),
  );
  const useKits = server.registerTool(
    "use_kits",
    { description: "", inputSchema: { kits: z.array(z.string().min(1)).describe("Kit names") } },
    ({ kits }) => call(async (c) => json((await c.useKits(kits)).active)),
  );
  const kitSave = server.registerTool(
    "kit_save",
    { description: "", inputSchema: { source: z.string().min(1).max(128 * 1024).describe("TypeScript source: an import from \"minebot-sdk/kit\", then export default defineKit({ ... }, { ... })") } },
    ({ source }) => call(async (c) => json(await c.saveKit(source))),
  );
  const kitRemove = server.registerTool(
    "kit_remove",
    { description: "", inputSchema: { name: z.string().min(1).describe("The saved kit to delete") } },
    ({ name }) => call(async (c) => json(await c.removeKit(name))),
  );
  const kitSource = server.registerTool(
    "kit_source",
    { description: "", inputSchema: { name: z.string().min(1).describe("A kit name") } },
    ({ name }) => call(async (c) => (await c.kitSource(name)).source),
  );
  const kitSearch = server.registerTool(
    "kit_search",
    {
      description: "",
      inputSchema: { query: z.string().min(1).describe("Words to look for, e.g. 'collect logs' or 'walk to'"), limit: z.number().int().positive().max(20).optional() },
    },
    ({ query, limit }) =>
      call(async (c) => {
        const { hits } = await c.searchKits(query, limit);
        return hits.length === 0 ? "no matching kits" : formatKitHits(hits);
      }),
  );
  const kitTry = server.registerTool(
    "kit_try",
    {
      description: "",
      inputSchema: {
        source: TryKitInput.shape.source.describe("TypeScript source: an import from \"minebot-sdk/kit\", then export default defineKit({ ... }, { ... })"),
        action: TryKitInput.shape.action.describe("The action to run"),
        args: TryKitInput.shape.args.describe("The action's argument object"),
        timeout_ms: TryKitInput.shape.timeoutMs.describe(`Abort after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      },
    },
    ({ source, action, args, timeout_ms }) => call(async (c) => formatRun(await c.tryKit(source, action, args, timeout_ms))),
  );
  const kitVersions = server.registerTool(
    "kit_versions",
    { description: "", inputSchema: { name: z.string().min(1).describe("The saved kit") } },
    ({ name }) => call(async (c) => formatKitVersions(name, (await c.kitVersions(name)).versions)),
  );
  const kitRevert = server.registerTool(
    "kit_revert",
    { description: "", inputSchema: { name: z.string().min(1).describe("The saved kit"), version: RevertKitInput.shape.version.describe("A version from kit_versions") } },
    ({ name, version }) => call(async (c) => json(await c.revertKit(name, version))),
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
    ({ section }) => call(async (c) => (await c.wikiList(section)).pages.map((p) => `${p.id} [${p.status}] ${p.title}`).join("\n")),
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
  const callRoutine = server.registerTool(
    "call_routine",
    {
      description: "",
      inputSchema: {
        name: BindingName.describe("The name of an action, as bound by bind_routine"),
        args: CallInput.shape.args.describe("The routine's arguments: a JSON object. Default {}."),
        timeout_ms: CallInput.shape.timeoutMs.describe(`Abort the call after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
      },
    },
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
      list_kits: listKits,
      kit_docs: kitDocs,
      use_kits: useKits,
      kit_save: kitSave,
      kit_remove: kitRemove,
      kit_source: kitSource,
      kit_search: kitSearch,
      kit_try: kitTry,
      kit_versions: kitVersions,
      kit_revert: kitRevert,
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
    status.update({
      description: capabilities(features).milestones
        ? "Deaths and reconnects since the body started, and progress toward this body's milestones (graded from the server's statistics)."
        : "Deaths and reconnects since the body started.",
    });
    runProgram.update({ description: runDescription(apiDoc) });
  }

  for (const tool of [listKits, kitDocs, useKits, kitSave, kitRemove, kitSource, kitSearch, kitTry, kitVersions, kitRevert, wikiSearch, wikiRead, wikiList, addLesson, callRoutine, bindRoutine, listRoutines, routineSave, routineSource, routineVersions, routineRevert, unbindRoutine]) tool.disable();
  // Ungated tools outside the core set: programs have notes, status(), and bot.chat.
  if (toolSet !== "full") for (const tool of [status, notesList, notesSet, notesDelete, sendChat]) tool.disable();
  await sync();
  await server.connect(new StdioServerTransport());
}
