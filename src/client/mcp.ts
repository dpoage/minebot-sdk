// Serves one body's API as MCP tools over stdio. The body endpoint is re-read per call, so body restarts are fine.
//
// Tools for optional features exist only while the body offers the feature, so an agent does not
// learn about features its body lacks. `toolPlan` derives the whole tool set from the capability
// table; the same function is what the capability test turns against every feature.
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  capabilities,
  ChatInput,
  DEFAULT_TIMEOUT_MS,
  type BodyFeatures,
  LessonInput,
  MAX_TIMEOUT_MS,
  NoteKey,
  NoteText,
  RevertKitInput,
  TriggerInput,
  TriggerName,
  TryKitInput,
  WaitInput,
} from "../protocol/index.ts";
import { formatHits, formatKitHits, formatKitVersions, formatNotes, formatRun, formatStatus, formatTriggers } from "./render.ts";
import { BodyClient } from "./client.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (value: unknown) => JSON.stringify(value, null, 2);

const API_DOC_FALLBACK = "Call the api_reference tool for the globals available to programs.";

/** The description of every capability-gated tool, by capability state: one place, reused by apply() and the tests. */
export function toolPlan(features: BodyFeatures): Record<string, { enabled: boolean; description: string }> {
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
        "Save your own kit as TypeScript source: `import { defineKit, action, z } from \"minebot-sdk/kit\";` (the only import allowed; it also exports nameMatcher, Position, goals and the other helpers that the built-in kits rely on), then `export default defineKit({ name, description, uses }, { actionName: action({ doc, args, returns, run }) })`; `returns` is a zod schema of what the action returns, checked on every call. Start from kit_source of a built-in kit, and check it with kit_try first. Nothing is written when the source is rejected. Saving over a kit keeps the old source (kit_versions).",
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
        "Run one action of kit source once without saving it: compiles and audits the source like kit_save, calls the action with args against the live body, and returns the result or the error. Nothing is written. Try a kit here before you save it.",
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
    trigger_add: {
      enabled: caps.triggers,
      description:
        "Install a reflex: a program the body runs on its own whenever an event of the given types arrives (hurt, chat, night, ...), for example eating when food is low. The program has the same globals as run_program plus `event`. Waits for the running program to finish unless preempt is true. Saved on the body, so it survives restarts; a trigger with the same name is replaced. A trigger that fails 3 times in a row disables itself.",
    },
    trigger_list: {
      enabled: caps.triggers,
      description: "Your triggers: what fires them, whether they are on, how often they ran since the body started, and how the last run ended.",
    },
    trigger_remove: {
      enabled: caps.triggers,
      description: "Delete a trigger.",
    },
    trigger_set_enabled: {
      enabled: caps.triggers,
      description: "Turn a trigger on or off without deleting it. Turning it on again clears a self-disable.",
    },
  };
  return plan;
}

/** Serves one body's API as MCP tools over stdio. */
export async function serveMcp(bodyName: string): Promise<void> {
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

  server.registerTool(
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

  server.registerTool(
    "notes_set",
    {
      description: 'Create or replace a note. Keys: 1-64 lowercase letters, digits, and . _ / -, e.g. "plan" or "places/base".',
      inputSchema: { key: NoteKey, text: NoteText },
    },
    ({ key, text }) => call(async (c) => json(await c.setNote(key, text))),
  );

  server.registerTool(
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

  server.registerTool(
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

  const triggerAdd = server.registerTool(
    "trigger_add",
    {
      description: "",
      inputSchema: {
        name: TriggerName,
        on: TriggerInput.shape.on.describe("Event types that fire it, e.g. ['hurt'] or ['chat']; any of them matches."),
        run: TriggerInput.shape.run.describe("Program source: the body of an async function, with `event` ({ seq, type, data }) in scope."),
        when: TriggerInput.shape.when.describe("JavaScript expression over `event` and `bot` that must be truthy, e.g. event.data.health < 8."),
        from: TriggerInput.shape.from.describe("Only chat or whisper events sent by this player."),
        match: TriggerInput.shape.match.describe("Case-insensitive regular expression over chat, whisper, and system messages."),
        cooldown_ms: TriggerInput.shape.cooldownMs.describe("Minimum time between two firings. Default 1000."),
        timeout_ms: TriggerInput.shape.timeoutMs.describe("Abort the run after this many milliseconds. Default 30000."),
        preempt: TriggerInput.shape.preempt.describe("Stop the running program instead of waiting for it. Default false."),
        priority: TriggerInput.shape.priority.describe("Waiting triggers run highest first; a preempting trigger never stops a running trigger of equal or higher priority. Default 0."),
        enabled: TriggerInput.shape.enabled,
      },
    },
    ({ cooldown_ms, timeout_ms, ...trigger }) =>
      call(async (c) => {
        const { trigger: saved, replaced } = await c.addTrigger({ ...trigger, cooldownMs: cooldown_ms, timeoutMs: timeout_ms });
        return `${replaced ? "replaced" : "saved"} trigger\n${formatTriggers([saved])}`;
      }),
  );
  const triggerList = server.registerTool("trigger_list", { description: "", inputSchema: {} }, () =>
    call(async (c) => {
      const { triggers } = await c.triggers();
      return triggers.length === 0 ? "no triggers" : formatTriggers(triggers);
    }),
  );
  const triggerRemove = server.registerTool("trigger_remove", { description: "", inputSchema: { name: TriggerName } }, ({ name }) =>
    call(async (c) => json(await c.removeTrigger(name))),
  );
  const triggerSetEnabled = server.registerTool(
    "trigger_set_enabled",
    { description: "", inputSchema: { name: TriggerName, enabled: z.boolean() } },
    ({ name, enabled }) => call(async (c) => formatTriggers([(await c.setTriggerEnabled(name, enabled)).trigger])),
  );

  const setEnabled = (tool: RegisteredTool, on: boolean) => (on ? tool.enable() : tool.disable());
  function apply(features: BodyFeatures, apiDoc: string): void {
    const plan = toolPlan(features);
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
      trigger_add: triggerAdd,
      trigger_list: triggerList,
      trigger_remove: triggerRemove,
      trigger_set_enabled: triggerSetEnabled,
    };
    for (const [name, tool] of Object.entries(tools)) {
      setEnabled(tool, plan[name]!.enabled);
      tool.update({ description: plan[name]!.description });
    }
    status.update({
      description: capabilities(features).milestones
        ? "Deaths and reconnects since the body started, and progress toward this body's milestones (graded from the server's statistics)."
        : "Deaths and reconnects since the body started.",
    });
    runProgram.update({ description: runDescription(apiDoc) });
  }

  for (const tool of [listKits, kitDocs, useKits, kitSave, kitRemove, kitSource, kitSearch, kitTry, kitVersions, kitRevert, wikiSearch, wikiRead, wikiList, addLesson, triggerAdd, triggerList, triggerRemove, triggerSetEnabled]) tool.disable();
  await sync();
  await server.connect(new StdioServerTransport());
}
