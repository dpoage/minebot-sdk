// The `minebot body` flags: one module owns the parse rows, the validation schema, and the
// operator help text. Nothing else re-declares a body flag.
import path from "node:path";
import { z } from "zod";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, RUNTIME_DIR } from "../protocol/index.ts";

/** The parseArgs rows for `minebot body`; cli.ts merges them into its option set. */
export const BODY_FLAG_OPTIONS = {
  username: { type: "string" },
  auth: { type: "string", default: "offline" },
  host: { type: "string", default: DEFAULT_SERVER_HOST },
  port: { type: "string", default: String(DEFAULT_SERVER_PORT) },
  "api-host": { type: "string", default: "127.0.0.1" },
  "api-port": { type: "string", default: "0" },
  history: { type: "string" },
  kits: { type: "string" },
  "lock-kits": { type: "boolean", default: false },
  builtins: { type: "string" },
  wiki: { type: "string", default: "read" },
  "wiki-dir": { type: "string" },
  lessons: { type: "string" },
  state: { type: "string" },
  milestones: { type: "string" },
  "no-milestones": { type: "boolean", default: false },
  "agent-kits": { type: "string" },
  "no-agent-kits": { type: "boolean", default: false },
  "no-reflexes": { type: "boolean", default: false },
  routines: { type: "string" },
  "no-routines": { type: "boolean", default: false },
} as const;

/** The same flags as a schema: what a validated body command looks like. */
export const BodyFlags = z
  .object({
    username: z.string().optional(),
    auth: z.enum(["offline", "microsoft"]),
    host: z.string(),
    port: z.coerce.number().int().positive(),
    apiHost: z.string(),
    apiPort: z.coerce.number().int().nonnegative(),
    history: z.string().optional(),
    kits: z.string().optional(),
    lockKits: z.boolean(),
    builtins: z.string().optional(),
    wiki: z.enum(["off", "read", "write"]),
    wikiDir: z.string().optional(),
    lessons: z.string().optional(),
    state: z.string().optional(),
    milestones: z.string().optional(),
    noMilestones: z.boolean(),
    agentKits: z.string().optional(),
    noAgentKits: z.boolean(),
    noReflexes: z.boolean(),
    routines: z.string().optional(),
    noRoutines: z.boolean(),
  })
  .refine((flags) => !(flags.milestones && flags.noMilestones), { message: "--milestones and --no-milestones cannot be combined" })
  .refine((flags) => !(flags.agentKits && flags.noAgentKits), { message: "--agent-kits and --no-agent-kits cannot be combined" })
  .refine((flags) => !(flags.routines && flags.noRoutines), { message: "--routines and --no-routines cannot be combined" })
  .refine((flags) => flags.builtins === undefined || flags.builtins === "none" || (builtinOffer(flags.builtins)!.length > 0 && !builtinOffer(flags.builtins)!.includes("none")), {
    message: '--builtins takes module names separated by commas, or "none" alone',
  });

export type BodyFlags = z.infer<typeof BodyFlags>;

/** The built-in modules `--builtins` lists, which the host closes over their uses: undefined (flag absent) offers every module, `none` offers none. */
export function builtinOffer(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value === "none" ? [] : value.split(",").map((name) => name.trim()).filter(Boolean);
}

/** The help lines for the operator flags, shown by `minebot --help` on an install with a body. */
export const OPERATOR_FLAG_HELP = [
  "  body:   --username <name> (default: the body name), --host <host> (default " + DEFAULT_SERVER_HOST + "),",
  `          --port <port> (default ${DEFAULT_SERVER_PORT}), --api-host <host> (default 127.0.0.1),`,
  "          --auth <offline|microsoft> (default offline; microsoft signs in with a device code on first start",
  "          and caches tokens in <state>/auth; the in-game name is the account's, and --username keys the cache),",
  "          --api-port <port> (default 0, a free port), --history <file> (append each program run as JSON),",
  "          --kits <a,b> (kits the body offers; default: every built-in kit), --lock-kits (fix the active set),",
  "          --builtins <a,b|none> (built-in routine modules the body offers, with the modules they use; default: every built-in module),",
  "          --no-agent-kits (agents cannot save their own kits), --agent-kits <dir> (default <state>/agent-kits),",
  "          --wiki <off|read|write> (default read; write lets the agent add lessons),",
  "          --wiki-dir <dir> (curated pages; default the repository's wiki/),",
  `          --lessons <dir> (default ${path.join(RUNTIME_DIR, "lessons")}),`,
  `          --state <dir> (notes, milestones, reflexes, bindings, kit stores, agent kits, routines; default ${path.join(RUNTIME_DIR, "state", "<bot>")}),`,
  "          --milestones <file> (milestones JSON; replaces the stored set),",
  "          --no-milestones (no milestones: the agent cannot read, set, or grade them),",
  "          --no-reflexes (the agent cannot bind reflexes: routines that run when an event arrives),",
  "          --no-routines (no routines: the agent cannot save, bind, or call modules), --routines <dir> (default <state>/routines; \"\" turns routines off),",
];

/** Parses and validates raw flag values (already through parseArgs) into a body command. */
export function parseBodyFlags(name: string, values: Record<string, string | boolean | undefined>): BodyFlags {
  return BodyFlags.parse({
    username: values.username,
    auth: values.auth,
    host: values.host,
    port: values.port,
    apiHost: values["api-host"],
    apiPort: values["api-port"],
    history: values.history,
    kits: values.kits,
    lockKits: values["lock-kits"],
    builtins: values.builtins,
    wiki: values.wiki,
    wikiDir: values["wiki-dir"],
    lessons: values.lessons,
    state: values.state,
    milestones: values.milestones,
    noMilestones: values["no-milestones"],
    agentKits: values["agent-kits"],
    noAgentKits: values["no-agent-kits"],
    noReflexes: values["no-reflexes"],
    routines: values.routines,
    noRoutines: values["no-routines"],
  });
}
