// The HTTP transport of the body API: auth, request reading, routing over a table of routes,
// and the error-to-status mapping. Routes are data; the daemon supplies them, each naming the
// capability it belongs to, so a feature the body lacks answers like any unknown route.
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import type { Capability } from "../protocol/index.ts";
import { NotConnectedError } from "../host/connection.ts";
import { NoteLimitError } from "../host/notes.ts";
import { TriggerInvalidError, TriggerLimitError, TriggerNotFoundError } from "../host/triggers.ts";
import { BusyError } from "../program/runner.ts";
import { WikiDisabledError, WikiPageNotFoundError } from "../wiki/wiki.ts";
import { KitSourceError } from "../kit/agent.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** The parsed request body (POST/PUT). */
  read(): Promise<unknown>;
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

/** HTTP status for an error thrown while handling a request. */
export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof BusyError || err instanceof NoteLimitError || err instanceof TriggerLimitError) return 409;
  if (err instanceof TriggerNotFoundError) return 404;
  if (err instanceof TriggerInvalidError) return 400;
  if (err instanceof NotConnectedError) return 503;
  if (err instanceof WikiDisabledError) return 403;
  if (err instanceof WikiPageNotFoundError) return 404;
  if (err instanceof z.ZodError || err instanceof KitSourceError) return 400;
  return 500;
}

export interface ServerOptions {
  token: string;
  routes: Route[];
  /** What `GET /health` answers (served without auth): the name and connection state. */
  health: () => unknown;
  /** Which capabilities the body offers right now; routes of the others answer 404. */
  offered: (capability: Capability) => boolean;
  /** Called with every request that reaches routing, for the event log. */
  onNotFound?: (method: string, path: string) => void;
}

/** Serves the routes over HTTP with bearer auth. Publishes nothing; the daemon owns the endpoint. */
export function serveBodyApi(options: ServerOptions): http.Server {
  const expectedAuth = Buffer.from(`Bearer ${options.token}`);
  return http.createServer((req, res) => {
    handle(req, res)
      .then((payload) => send(res, 200, payload))
      .catch((err: unknown) => send(res, statusFor(err), { error: err instanceof Error ? err.message : String(err) }));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return options.health();
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      throw new HttpError(401, "missing or invalid bearer token");
    }
    const route = match(req.method ?? "", url.pathname);
    if (!route) {
      options.onNotFound?.(req.method ?? "", url.pathname);
      throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    }
    return route.handler({ req, res, url, read: () => readJson(req) });
  }

  function match(method: string, pathname: string): Route | undefined {
    for (const route of options.routes) {
      if (route.method !== method) continue;
      if (route.capability && !options.offered(route.capability)) continue;
      if (route.pattern ? route.pattern.test(pathname) : route.path === pathname) return route;
    }
    return undefined;
  }
}

export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // http.IncomingMessage yields Buffers when no encoding is set.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

export function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload ?? null);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}
