// The body API as the bot host serves it: the route table (each route names the capability it
// belongs to, so a feature the body lacks answers like an unknown route), query and body parsing,
// and the mapping from what a handler throws to an HTTP status. The supervisor forwards every
// request that is not its own here, raw, and relays the answer.
import { z } from "zod";
import { KitLockedError, type KitHost } from "../kit/kit.ts";
import type { KitLibrary } from "../kit/library.ts";
import { KitSourceError } from "../kit/agent.ts";
import { BusyError } from "../program/runner.ts";
import {
  BindInput,
  CallInput,
  capabilities,
  ChatInput,
  KitDocsQuery,
  KitSearchQuery,
  KitSourceQuery,
  KitVersionsQuery,
  LessonInput,
  MilestonesInput,
  NoteInput,
  NoteKey,
  ObserveQuery,
  programApiDoc,
  RemoveKitInput,
  RevertKitInput,
  RemoveTriggerInput,
  RevertRoutineInput,
  RoutineSourceQuery,
  RoutineVersionsQuery,
  RunInput,
  SaveKitInput,
  SaveRoutineInput,
  TriggerEnabledInput,
  TryKitInput,
  UnbindInput,
  UseKitsInput,
  WikiListQuery,
  WikiPageQuery,
  WikiSearchQuery,
  type Capability,
  type KitInfo,
  type KitsResponse,
  type SaveKitResponse,
  type SaveRoutineResponse,
  type TriggersResponse,
} from "../protocol/index.ts";
import { HttpError, parse, parseBody } from "../protocol/request.ts";
import { WikiDisabledError, WikiPageNotFoundError } from "../wiki/wiki.ts";
import type { Body, RunRecorder } from "./body.ts";
import { NotConnectedError } from "./connection.ts";
import { NoteLimitError } from "../notes.ts";
import type { Bindings } from "./bindings.ts";
import { BindingConflictError } from "./bindings.ts";
import { RoutineSourceError, type RoutineLibrary } from "./routines/library.ts";
import { RoutineNotFoundError } from "./routines/loader.ts";
import { TriggerInvalidError, TriggerLimitError, TriggerNotFoundError } from "./triggers.ts";

export interface RequestContext {
  url: URL;
  /** The parsed request body (POST/PUT); throws a 413 or 400 only when a handler asks for it. */
  read(): Promise<unknown>;
  /** The id the supervisor gave the request; a run it starts is reported with it, so the supervisor can answer it if this host is killed. */
  requestId: number;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** The capability this route belongs to; absent means every body serves it. */
  capability?: Capability;
  /** Path parameters, for the `/notes/:key` shape. */
  pattern?: RegExp;
  handler: (ctx: RequestContext) => unknown;
}

/** One API request as the supervisor forwards it: the body is the raw text, cut off when it was too large. */
export interface ApiRequest {
  id: number;
  method: string;
  /** Path and query, as sent. */
  url: string;
  body: string | null;
  tooLarge: boolean;
}

/** HTTP status for an error thrown while handling a request. */
export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof BusyError || err instanceof NoteLimitError || err instanceof TriggerLimitError || err instanceof BindingConflictError) return 409;
  if (err instanceof TriggerNotFoundError || err instanceof RoutineNotFoundError) return 404;
  if (err instanceof TriggerInvalidError) return 400;
  if (err instanceof NotConnectedError) return 503;
  if (err instanceof WikiDisabledError) return 403;
  if (err instanceof WikiPageNotFoundError) return 404;
  if (err instanceof z.ZodError || err instanceof KitSourceError || err instanceof RoutineSourceError) return 400;
  return 500;
}

/** Answers one request: finds its route among those the body offers, runs it, and maps what it throws to a status. */
export async function serve(routes: Route[], body: Body, request: ApiRequest): Promise<{ status: number; body: unknown }> {
  try {
    const url = new URL(request.url, "http://localhost");
    const offered = capabilities(body.features);
    const route = routes.find((candidate) => {
      if (candidate.method !== request.method) return false;
      if (candidate.capability && !offered[candidate.capability]) return false;
      return candidate.pattern ? candidate.pattern.test(url.pathname) : candidate.path === url.pathname;
    });
    if (!route) throw new HttpError(404, `no route for ${request.method} ${url.pathname}`);
    // The body is read only when the route asks, so an unknown route answers 404 whatever the body holds.
    const read = async (): Promise<unknown> => parseBody(request);
    return { status: 200, body: await route.handler({ url, read, requestId: request.id }) };
  } catch (err) {
    return { status: statusFor(err), body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/** What the routine routes act on, for a body that offers routines. */
export interface RoutineRouteDeps {
  library: RoutineLibrary;
  bindings: Bindings;
  /** Saves a routine and reports the type check of its source. */
  save: (name: string, source: string) => Promise<SaveRoutineResponse>;
}

/** What the routes act on. */
export interface RouteDeps {
  body: Body;
  kits: KitHost;
  library: KitLibrary;
  syncKits: () => void;
  saveKit: (source: string) => Promise<SaveKitResponse>;
  revertKit: (name: string, version: number) => Promise<KitInfo>;
  recorder: RunRecorder;
  /** Absent on a body without routines, whose routine routes are never served. */
  routines?: RoutineRouteDeps;
}

/** The routes the host answers: every route of the body API except health, events, waits, and stop, which the supervisor answers. */
export function bodyRoutes({ body, kits: host, library, syncKits, saveKit, revertKit, recorder, routines }: RouteDeps): Route[] {
  function kitsResponse(): KitsResponse {
    return { kits: host.info(), active: host.active, locked: host.locked };
  }

  function triggersResponse(): TriggersResponse {
    return { triggers: body.triggers?.list() ?? [] };
  }

  return [
    {
      method: "GET",
      path: "/observe",
      handler: async ({ url }) => {
        const { brief } = parse(ObserveQuery, Object.fromEntries(url.searchParams));
        return brief === "1" || brief === "true" ? { brief: body.brief() } : body.observe();
      },
    },
    { method: "GET", path: "/status", handler: () => body.status() },
    { method: "GET", path: "/milestones", capability: "milestones", handler: () => ({ milestones: body.milestones }) },
    {
      method: "PUT",
      path: "/milestones",
      capability: "milestones",
      handler: async ({ read }) => {
        const { milestones } = parse(MilestonesInput, await read());
        body.setMilestones(milestones);
        return { milestones: body.milestones };
      },
    },
    { method: "GET", path: "/notes", handler: () => ({ notes: body.notes.list() }) },
    {
      method: "GET",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url }) => {
        const note = body.notes.get(decodeURIComponent(url.pathname.slice("/notes/".length)));
        if (!note) throw new HttpError(404, `no note "${decodeURIComponent(url.pathname.slice("/notes/".length))}"`);
        return note;
      },
    },
    {
      method: "PUT",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url, read }) => {
        const key = decodeURIComponent(url.pathname.slice("/notes/".length));
        const { text } = parse(NoteInput, await read());
        NoteKey.parse(key);
        return body.notes.set(key, text);
      },
    },
    {
      method: "DELETE",
      path: "/notes/:key",
      pattern: /^\/notes\/(.+)$/,
      handler: async ({ url }) => ({ deleted: body.notes.delete(decodeURIComponent(url.pathname.slice("/notes/".length))) }),
    },
    {
      method: "POST",
      path: "/run",
      handler: async ({ read, requestId }) => {
        const { code, timeoutMs } = parse(RunInput, await read());
        return recorder.record({ code, timeoutMs, requestId }, () => body.run(code, timeoutMs));
      },
    },
    {
      method: "POST",
      path: "/chat",
      handler: async ({ read }) => {
        const { message } = parse(ChatInput, await read());
        body.chat(message);
        return { sent: true };
      },
    },
    { method: "GET", path: "/api", handler: () => ({ doc: programApiDoc(body.features) }) },
    { method: "GET", path: "/features", handler: () => body.features },
    { method: "GET", path: "/kits", capability: "kits", handler: () => (syncKits(), kitsResponse()) },
    {
      method: "POST",
      path: "/kits",
      capability: "kitSwitching",
      handler: async ({ read }) => {
        const { use } = parse(UseKitsInput, await read());
        try {
          host.use(use);
        } catch (err) {
          if (err instanceof KitLockedError) throw new HttpError(403, err.message);
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        return kitsResponse();
      },
    },
    {
      method: "GET",
      path: "/kits/docs",
      capability: "kits",
      handler: async ({ url }) => {
        const { names } = parse(KitDocsQuery, Object.fromEntries(url.searchParams));
        try {
          syncKits();
          return { docs: host.docs(names ? names.split(",").filter(Boolean) : []) };
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: "GET",
      path: "/kits/schemas",
      capability: "kits",
      handler: () => (syncKits(), { kits: host.schemas() }),
    },
    {
      method: "GET",
      path: "/kits/source",
      capability: "agentKits",
      handler: async ({ url }) => {
        const { name } = parse(KitSourceQuery, Object.fromEntries(url.searchParams));
        const source = library.source(name);
        if (source === undefined) throw new HttpError(404, `no kit "${name}"`);
        return { name, source };
      },
    },
    {
      method: "POST",
      path: "/kits/save",
      capability: "agentKits",
      handler: async ({ read }) => saveKit(parse(SaveKitInput, await read()).source),
    },
    {
      method: "POST",
      path: "/kits/remove",
      capability: "agentKits",
      handler: async ({ read }) => {
        const { name } = parse(RemoveKitInput, await read());
        await library.remove(name);
        syncKits();
        return { removed: name };
      },
    },
    {
      method: "GET",
      path: "/kits/search",
      capability: "kits",
      handler: async ({ url }) => {
        const { q, limit } = parse(KitSearchQuery, Object.fromEntries(url.searchParams));
        syncKits();
        return { hits: host.search(q, limit) };
      },
    },
    {
      method: "GET",
      path: "/kits/versions",
      capability: "agentKits",
      handler: async ({ url }) => {
        const { name } = parse(KitVersionsQuery, Object.fromEntries(url.searchParams));
        return { name, versions: await library.versions(name) };
      },
    },
    {
      method: "POST",
      path: "/kits/revert",
      capability: "agentKits",
      handler: async ({ read }) => {
        const { name, version } = parse(RevertKitInput, await read());
        return revertKit(name, version);
      },
    },
    {
      // Runs as a program: the action needs the live bot and the program's scope, and the run is recorded like any other.
      method: "POST",
      path: "/kits/try",
      capability: "agentKits",
      handler: async ({ read, requestId }) => {
        const { source, action, args, timeoutMs } = parse(TryKitInput, await read());
        const code = `return await kits.try(${JSON.stringify(source)}, ${JSON.stringify({ action, args })});`;
        return recorder.record({ code, timeoutMs, requestId }, () => body.run(code, timeoutMs));
      },
    },
    { method: "GET", path: "/triggers", capability: "triggers", handler: () => triggersResponse() },
    {
      method: "POST",
      path: "/triggers",
      capability: "triggers",
      handler: async ({ read }) => body.triggers!.add(await read()),
    },
    {
      method: "POST",
      path: "/triggers/remove",
      capability: "triggers",
      handler: async ({ read }) => {
        const { name } = parse(RemoveTriggerInput, await read());
        if (!body.triggers!.remove(name)) throw new HttpError(404, `no trigger "${name}"`);
        return { removed: name };
      },
    },
    {
      method: "POST",
      path: "/triggers/enabled",
      capability: "triggers",
      handler: async ({ read }) => {
        const { name, enabled } = parse(TriggerEnabledInput, await read());
        return { trigger: body.triggers!.setEnabled(name, enabled) };
      },
    },
    { method: "GET", path: "/routines", capability: "routines", handler: () => ({ routines: routines!.library.list() }) },
    {
      method: "GET",
      path: "/routines/source",
      capability: "routines",
      handler: async ({ url }) => {
        const { name } = parse(RoutineSourceQuery, Object.fromEntries(url.searchParams));
        const source = routines!.library.source(name);
        if (source === undefined) throw new HttpError(404, `no routine "${name}"`);
        return { name, source };
      },
    },
    {
      method: "POST",
      path: "/routines/save",
      capability: "routines",
      handler: async ({ read }) => {
        const { name, source } = parse(SaveRoutineInput, await read());
        return routines!.save(name, source);
      },
    },
    {
      method: "GET",
      path: "/routines/versions",
      capability: "routines",
      handler: async ({ url }) => {
        const { name } = parse(RoutineVersionsQuery, Object.fromEntries(url.searchParams));
        return { name, versions: await routines!.library.versions(name) };
      },
    },
    {
      method: "POST",
      path: "/routines/revert",
      capability: "routines",
      handler: async ({ read }) => {
        const { name, version } = parse(RevertRoutineInput, await read());
        return { routine: await routines!.library.revert(name, version) };
      },
    },
    { method: "GET", path: "/bindings", capability: "routines", handler: () => ({ bindings: routines!.bindings.list() }) },
    {
      method: "POST",
      path: "/bind",
      capability: "routines",
      handler: async ({ read }) => routines!.bindings.bind(parse(BindInput, await read())),
    },
    {
      method: "POST",
      path: "/unbind",
      capability: "routines",
      handler: async ({ read }) => {
        const { name } = parse(UnbindInput, await read());
        if (!routines!.bindings.unbind(name)) throw new HttpError(404, `no binding "${name}"`);
        return { unbound: name };
      },
    },
    {
      // A call is a run: recorded like a program, with the action and its routine and args on the history line.
      method: "POST",
      path: "/call",
      capability: "routines",
      handler: async ({ read, requestId }) => {
        const { name, args, timeoutMs } = parse(CallInput, await read());
        const binding = routines!.bindings.action(name);
        if (!binding) throw new HttpError(404, `no action bound to "${name}"`);
        return recorder.record({ code: "", timeoutMs, requestId, extra: { call: { name, routine: binding.routine, args } } }, () => body.call(binding.routine, args, timeoutMs));
      },
    },
    {
      method: "GET",
      path: "/wiki/search",
      capability: "wiki",
      handler: async ({ url }) => {
        const { q, limit } = parse(WikiSearchQuery, Object.fromEntries(url.searchParams));
        return { hits: body.wiki.search(q, limit) };
      },
    },
    {
      method: "GET",
      path: "/wiki/page",
      capability: "wiki",
      handler: async ({ url }) => {
        const { id } = parse(WikiPageQuery, Object.fromEntries(url.searchParams));
        return body.wiki.readFormatted(id);
      },
    },
    {
      method: "GET",
      path: "/wiki/list",
      capability: "wiki",
      handler: async ({ url }) => {
        const { section } = parse(WikiListQuery, Object.fromEntries(url.searchParams));
        return { pages: body.wiki.list(section), mode: body.wiki.mode };
      },
    },
    {
      method: "POST",
      path: "/wiki/lessons",
      capability: "lessons",
      handler: async ({ read }) => body.wiki.addLesson(parse(LessonInput, await read())),
    },
  ];
}
