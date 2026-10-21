// The HTTP transport of the body API: auth, request reading, and relaying. The supervisor answers
// the few routes that are its own (health, the event log, waits, stop); every other request is
// forwarded raw to the bot host, which routes, gates by capability, parses, and maps its errors to
// a status. Routes here are data; the daemon supplies them.
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { z } from "zod";

export const MAX_BODY_BYTES = 1024 * 1024;

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

/** A route the supervisor answers itself. */
export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (ctx: RequestContext) => unknown;
}

/** An API request as the bot host receives it: the body is the raw bytes, cut off past MAX_BODY_BYTES. */
export interface ForwardedRequest {
  method: string;
  /** Path and query, as sent. */
  url: string;
  body: Buffer | null;
  tooLarge: boolean;
}

export interface ServerOptions {
  token: string;
  /** The routes the supervisor answers itself. */
  routes: Route[];
  /** Answers every other authenticated request. */
  forward: (request: ForwardedRequest) => Promise<{ status: number; body: unknown }>;
  /** What `GET /health` answers (served without auth): the name and connection state. */
  health: () => unknown;
}

/** Serves the routes over HTTP with bearer auth. Publishes nothing; the daemon owns the endpoint. */
export function serveBodyApi(options: ServerOptions): http.Server {
  const expectedAuth = Buffer.from(`Bearer ${options.token}`);
  return http.createServer((req, res) => {
    handle(req, res)
      .then(({ status, body }) => send(res, status, body))
      .catch((err: unknown) => send(res, err instanceof HttpError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: options.health() };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      throw new HttpError(401, "missing or invalid bearer token");
    }
    const method = req.method ?? "";
    const route = options.routes.find((candidate) => candidate.method === method && candidate.path === url.pathname);
    if (route) return { status: 200, body: await route.handler({ req, res, url, read: () => readJson(req) }) };
    // The host parses the body only when the route it matches reads one, so an unknown route answers 404 whatever the body.
    const raw = method === "POST" || method === "PUT" ? await readRaw(req) : { body: null, tooLarge: false };
    return options.forward({ method, url: req.url ?? "/", ...raw });
  }
}

/** The request body's bytes, up to MAX_BODY_BYTES; a longer body is cut off and flagged. */
async function readRaw(req: http.IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  // http.IncomingMessage yields Buffers when no encoding is set.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { body: Buffer.alloc(0), tooLarge: true };
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), tooLarge: false };
}

export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const { body, tooLarge } = await readRaw(req);
  if (tooLarge) throw new HttpError(413, "request body too large");
  return parseJson(body.toString("utf8"));
}

/** Parses a request body's text; an empty body is `{}`. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
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
