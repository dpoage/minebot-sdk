// Client for one body daemon. Uses node:http because programs can hold a request open for many minutes.
import { readFile } from "node:fs/promises";
import http from "node:http";
import { text } from "node:stream/consumers";
import type { z } from "zod";
import {
  EndpointSchema,
  endpointFile,
  type BindInput,
  type BindingsResponse,
  type BindResponse,
  type BuiltinSearchHit,
  type BuiltinsResponse,
  type BodyFeatures,
  type Endpoint,
  type KitSearchHit,
  type KitVersion,
  type EventsResponse,
  type KitSchemasResponse,
  type KitsResponse,
  type MilestoneSet,
  type Note,
  type Observation,
  type PageSummary,
  type RevertRoutineResponse,
  type RoutinesResponse,
  type RoutineSourceResponse,
  type RoutineVersionsResponse,
  type RunResult,
  type SaveRoutineResponse,
  type SaveKitResponse,
  type KitInfo,
  type SearchHit,
  type StatusResponse,
  type UnbindResponse,
  type WaitRequest,
  type WaitResponse,
  type WikiMode,
  type WikiPage,
} from "../protocol/index.ts";

export class BodyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What a client needs to reach a body. */
export type BodyAddress = Pick<Endpoint, "name" | "url" | "token">;

export class BodyClient {
  readonly endpoint: BodyAddress;

  constructor(endpoint: BodyAddress) {
    this.endpoint = endpoint;
  }

  /**
   * Finds a body. `MINEBOT_URL` and `MINEBOT_TOKEN` take precedence (a body in another container);
   * otherwise reads the endpoint file a local body publishes under `.minebot/`.
   */
  static async connect(name: string): Promise<BodyClient> {
    const url = process.env.MINEBOT_URL;
    if (url) return new BodyClient({ name: url, url, token: process.env.MINEBOT_TOKEN ?? "" });
    const file = endpointFile(name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      throw new Error(`no running body named "${name}" (missing ${file}); start one with: minebot body --bot ${name}`);
    }
    return new BodyClient(EndpointSchema.parse(JSON.parse(raw)));
  }

  observe(): Promise<Observation> {
    return this.#request("GET", "/observe");
  }

  /** The observation as one short line. */
  async brief(): Promise<string> {
    return (await this.#request<{ brief: string }>("GET", "/observe?brief=1")).brief;
  }

  status(): Promise<StatusResponse> {
    return this.#request("GET", "/status");
  }

  milestones(): Promise<{ milestones: MilestoneSet | null }> {
    return this.#request("GET", "/milestones");
  }

  /** Replaces the body's milestones; null removes them. The body validates the set. */
  setMilestones(milestones: unknown): Promise<{ milestones: MilestoneSet | null }> {
    return this.#request("PUT", "/milestones", { milestones });
  }

  notes(): Promise<{ notes: Note[] }> {
    return this.#request("GET", "/notes");
  }

  note(key: string): Promise<Note> {
    return this.#request("GET", `/notes/${encodeURIComponent(key)}`);
  }

  setNote(key: string, text: string): Promise<Note> {
    return this.#request("PUT", `/notes/${encodeURIComponent(key)}`, { text });
  }

  deleteNote(key: string): Promise<{ deleted: boolean }> {
    return this.#request("DELETE", `/notes/${encodeURIComponent(key)}`);
  }

  run(code: string, timeoutMs?: number): Promise<RunResult> {
    return this.#request("POST", "/run", { code, timeoutMs });
  }

  stop(): Promise<{ stopped: boolean }> {
    return this.#request("POST", "/stop", {});
  }

  events(since = 0, limit = 200): Promise<EventsResponse> {
    return this.#request("GET", `/events?since=${since}&limit=${limit}`);
  }

  /** Blocks until a matching event arrives or the wait times out. */
  wait(filter: WaitRequest): Promise<WaitResponse> {
    return this.#request("POST", "/wait", { ...filter });
  }

  chat(message: string): Promise<{ sent: boolean }> {
    return this.#request("POST", "/chat", { message });
  }

  kits(): Promise<KitsResponse> {
    return this.#request("GET", "/kits");
  }

  /** Replaces the active kits; used kits are added automatically. */
  useKits(names: string[]): Promise<KitsResponse> {
    return this.#request("POST", "/kits", { use: names });
  }

  /** The optional parts this body offers: kits, the wiki, lessons, milestones. */
  features(): Promise<BodyFeatures> {
    return this.#request("GET", "/features");
  }

  /** The program reference for this body: only the features it offers. */
  apiDoc(): Promise<{ doc: string }> {
    return this.#request("GET", "/api");
  }

  /** The action reference for the named kits, or for the active kits when `names` is empty. */
  kitDocs(names: string[] = []): Promise<{ docs: string }> {
    return this.#request("GET", `/kits/docs?names=${encodeURIComponent(names.join(","))}`);
  }

  /** Every listed kit's actions as JSON Schemas; the input of `minebot types`. */
  kitSchemas(): Promise<KitSchemasResponse> {
    return this.#request("GET", "/kits/schemas");
  }

  /** A kit's source: a built-in kit's file, or an agent's saved one. */
  kitSource(name: string): Promise<{ name: string; source: string }> {
    return this.#request("GET", `/kits/source?name=${encodeURIComponent(name)}`);
  }

  /** Validates and saves an agent kit; nothing is written when the source is rejected. */
  saveKit(source: string): Promise<SaveKitResponse> {
    return this.#request("POST", "/kits/save", { source });
  }

  /** Deletes a saved agent kit. */
  removeKit(name: string): Promise<{ removed: string }> {
    return this.#request("POST", "/kits/remove", { name });
  }

  /** Ranks the kits and actions the body lists against a query. */
  searchKits(query: string, limit = 5): Promise<{ hits: KitSearchHit[] }> {
    return this.#request("GET", `/kits/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /** The saved versions of an agent kit, oldest first. */
  kitVersions(name: string): Promise<{ name: string; versions: KitVersion[] }> {
    return this.#request("GET", `/kits/versions?name=${encodeURIComponent(name)}`);
  }

  /** Saves an earlier version of an agent kit again, as a new version. */
  revertKit(name: string, version: number): Promise<KitInfo> {
    return this.#request("POST", "/kits/revert", { name, version });
  }

  /** Runs one action of unsaved kit source once, as a program: the result or the error comes back like any run's. Nothing is saved. */
  tryKit(source: string, action: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<RunResult> {
    return this.#request("POST", "/kits/try", { source, action, args, timeoutMs });
  }

  wikiSearch(query: string, limit = 5): Promise<{ hits: SearchHit[] }> {
    return this.#request("GET", `/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /** A page and its agent-facing rendering. */
  wikiRead(id: string): Promise<{ page: WikiPage; text: string }> {
    return this.#request("GET", `/wiki/page?id=${encodeURIComponent(id)}`);
  }

  wikiList(section?: string): Promise<{ pages: PageSummary[]; mode: WikiMode }> {
    return this.#request("GET", `/wiki/list${section ? `?section=${encodeURIComponent(section)}` : ""}`);
  }

  addLesson(lesson: { title: string; tags?: string[]; body: string }): Promise<PageSummary> {
    return this.#request("POST", "/wiki/lessons", lesson);
  }

  /** The routines saved in the library. */
  routines(): Promise<RoutinesResponse> {
    return this.#request("GET", "/routines");
  }

  /** A saved routine's source. */
  routineSource(name: string): Promise<RoutineSourceResponse> {
    return this.#request("GET", `/routines/source?name=${encodeURIComponent(name)}`);
  }

  /** Saves a routine module under `name` as a new version. The type check of the source comes back with the routine and never blocks the save. */
  saveRoutine(name: string, source: string): Promise<SaveRoutineResponse> {
    return this.#request("POST", "/routines/save", { name, source });
  }

  /** The saved versions of a routine, oldest first. */
  routineVersions(name: string): Promise<RoutineVersionsResponse> {
    return this.#request("GET", `/routines/versions?name=${encodeURIComponent(name)}`);
  }

  /** Saves an earlier version of a routine again, as a new version. */
  revertRoutine(name: string, version: number): Promise<RevertRoutineResponse> {
    return this.#request("POST", "/routines/revert", { name, version });
  }

  /** The names bound to routines: actions, and reflexes with what they have done since the body started. */
  bindings(): Promise<BindingsResponse> {
    return this.#request("GET", "/bindings");
  }

  /** Binds a name to a saved routine, as an action or a reflex; a binding of the same name and kind is replaced. The body checks every field. */
  bind(binding: z.input<typeof BindInput>): Promise<BindResponse> {
    return this.#request("POST", "/bind", binding);
  }

  unbind(name: string): Promise<UnbindResponse> {
    return this.#request("POST", "/unbind", { name });
  }

  /** Calls the action bound to `name`, or the built-in routine `<module>.<routine>`, with `args` as one run: the result or the error comes back like any run's. */
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<RunResult> {
    return this.#request("POST", "/call", { name, args, timeoutMs });
  }

  /** The built-in routine modules the body offers, each with how often its routines succeeded and failed. */
  builtins(): Promise<BuiltinsResponse> {
    return this.#request("GET", "/builtins");
  }

  /** The reference for the named built-in modules, or for every offered module when `names` is empty. */
  builtinDocs(names: string[] = []): Promise<{ docs: string }> {
    return this.#request("GET", `/builtins/docs?names=${encodeURIComponent(names.join(","))}`);
  }

  /** Ranks the offered built-in modules and routines against a query. */
  searchBuiltins(query: string, limit = 5): Promise<{ hits: BuiltinSearchHit[] }> {
    return this.#request("GET", `/builtins/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /** A built-in module's source file, as the package ships it. */
  builtinSource(name: string): Promise<{ name: string; source: string }> {
    return this.#request("GET", `/builtins/source?name=${encodeURIComponent(name)}`);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const response = Promise.withResolvers<http.IncomingMessage>();
    const req = http.request(
      new URL(path, this.endpoint.url),
      {
        method,
        headers: {
          authorization: `Bearer ${this.endpoint.token}`,
          ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
        },
      },
      response.resolve,
    );
    req.on("error", (err) =>
      response.reject(new Error(`cannot reach body "${this.endpoint.name}" at ${this.endpoint.url}: ${err.message}`)),
    );
    req.end(data);

    const res = await response.promise;
    const status = res.statusCode ?? 0;
    const raw = await text(res);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new BodyApiError(status, `non-JSON response: ${raw.slice(0, 200)}`);
    }
    // Responses come from our own daemon, whose 200 payloads match the method's return type.
    if (status === 200) return payload as T;
    const message =
      typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${status}`;
    throw new BodyApiError(status, message);
  }
}
