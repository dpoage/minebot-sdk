// The body API as the bot host serves it: the route table (each route names the capability it
// belongs to, so a feature the body lacks answers like an unknown route), query and body parsing,
// and the mapping from what a handler throws to an HTTP status. The supervisor forwards every
// request that is not its own here, raw, and relays the answer.
import { z } from "zod";
import { BusyError } from "../program/runner.ts";
import {
  BindInput,
  BuiltinDocsQuery,
  BuiltinSearchQuery,
  BuiltinSourceQuery,
  CallInput,
  capabilities,
  ChatInput,
  LessonInput,
  MilestonesInput,
  NoteInput,
  NoteKey,
  ObserveQuery,
  programApiDoc,
  RevertRoutineInput,
  RoutineSourceQuery,
  RoutineVersionsQuery,
  RunInput,
  SaveRoutineInput,
  UnbindInput,
  WikiListQuery,
  WikiPageQuery,
  WikiSearchQuery,
  type Capability,
  type SaveRoutineResponse,
} from "../protocol/index.ts";
import { HttpError, parse, parseBody } from "../protocol/request.ts";
import { WikiDisabledError, WikiPageNotFoundError } from "../wiki/wiki.ts";
import type { Body, RunRecorder } from "./body.ts";
import { NotConnectedError } from "./connection.ts";
import { NoteLimitError } from "../notes.ts";
import type { Bindings } from "./bindings.ts";
import { BindingInvalidError } from "./bindings.ts";
import { RoutineSourceError, type RoutineLibrary } from "./routines/library.ts";
import type { Builtins } from "./routines/builtins.ts";
import { RoutineNotFoundError } from "./routines/loader.ts";
import { NameConflictError, TriggerInvalidError, TriggerLimitError } from "./triggers.ts";

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
  if (err instanceof BusyError || err instanceof NoteLimitError || err instanceof TriggerLimitError || err instanceof NameConflictError) return 409;
  if (err instanceof RoutineNotFoundError) return 404;
  if (err instanceof TriggerInvalidError || err instanceof BindingInvalidError) return 400;
  if (err instanceof NotConnectedError) return 503;
  if (err instanceof WikiDisabledError) return 403;
  if (err instanceof WikiPageNotFoundError) return 404;
  if (err instanceof z.ZodError || err instanceof RoutineSourceError) return 400;
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
  builtins: Builtins;
  recorder: RunRecorder;
  /** Absent on a body without routines, whose routine routes are never served. */
  routines?: RoutineRouteDeps;
}

/** The routes the host answers: every route of the body API except health, events, waits, and stop, which the supervisor answers. */
export function bodyRoutes({ body, builtins, recorder, routines }: RouteDeps): Route[] {
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
      // A run is a call of module code: recorded like one, with the source as its code and the args it was given on the history line.
      method: "POST",
      path: "/run",
      handler: async ({ read, requestId }) => {
        const { code, args, timeoutMs } = parse(RunInput, await read());
        return recorder.record({ code, timeoutMs, requestId, ...(args !== undefined && { extra: { args } }) }, () => body.run(code, args, timeoutMs));
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
    { method: "GET", path: "/builtins", capability: "builtins", handler: () => ({ builtins: builtins.list() }) },
    {
      method: "GET",
      path: "/builtins/docs",
      capability: "builtins",
      handler: async ({ url }) => {
        const { names } = parse(BuiltinDocsQuery, Object.fromEntries(url.searchParams));
        try {
          return { docs: builtins.docs(names ? names.split(",").filter(Boolean) : []) };
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      method: "GET",
      path: "/builtins/search",
      capability: "builtins",
      handler: async ({ url }) => {
        const { q, limit } = parse(BuiltinSearchQuery, Object.fromEntries(url.searchParams));
        return { hits: builtins.search(q, limit) };
      },
    },
    {
      method: "GET",
      path: "/builtins/source",
      capability: "builtins",
      handler: async ({ url }) => {
        const { name } = parse(BuiltinSourceQuery, Object.fromEntries(url.searchParams));
        const source = builtins.source(name);
        if (source === undefined) throw new HttpError(404, `no built-in module "${name}"`);
        return { name, source };
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
      // A call is a run: recorded like a program, with the action and its routine and args on the history line; a built-in's line has its call name and args.
      // Served when the body has actions or built-ins; each name is checked by its kind.
      method: "POST",
      path: "/call",
      capability: "call",
      handler: async ({ read, requestId }) => {
        const { name, args, timeoutMs } = parse(CallInput, await read());
        // A name with a dot is a built-in's; it is never a binding.
        if (name.includes(".")) {
          if (builtins.routine(name) === undefined) throw new HttpError(404, `no built-in routine "${name}"`);
          return recorder.record({ code: "", timeoutMs, requestId, extra: { call: { name, args } } }, () => body.callBuiltin(name, args, timeoutMs));
        }
        if (!routines) throw new HttpError(404, `no action named "${name}": this body has no routine library; built-in routines are called as <module>.<routine>`);
        const binding = routines.bindings.action(name);
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
