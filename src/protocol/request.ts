// How the body API reads a request: the size cap on its body, the JSON body rules, schema
// validation, and the error that carries an HTTP status. The supervisor's transport and the bot
// host's routes both answer by these rules. Not re-exported from the protocol index: clients of
// the body API never parse its requests.
import { z } from "zod";

/** The largest request body the API reads. */
export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A request body as read off the wire: its text, and whether it ran past MAX_BODY_BYTES. */
export interface RawBody {
  body: string | null;
  tooLarge: boolean;
}

/** The JSON a request body holds; an empty body is `{}`. Throws a 413 for a body past the cap and a 400 for one that is not JSON. */
export function parseBody({ body, tooLarge }: RawBody): unknown {
  if (tooLarge) throw new HttpError(413, "request body too large");
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

/** `input` as `schema` reads it; throws a 400 with zod's description of what is wrong. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}
