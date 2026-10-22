// The usage text of the `minebot` command, built from what the body offers: the capability
// table decides which commands and options an agent reads about.
import { existsSync } from "node:fs";
import { CAPABILITY_GATES, type BodyFeatures } from "../protocol/index.ts";

/** A client-only install leaves out the body modules, and with it the `body` command. Looks for the daemon with this file's own extension: `.ts` from source, `.js` from a build. */
export const HAS_BODY = existsSync(new URL(`../body/daemon${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url));

/** What the usage text shows when no body can be asked: everything on an install that can start bodies, nothing optional otherwise. */
const EVERYTHING: BodyFeatures = { wiki: "write", lessons: true, milestones: true, reflexes: true, routines: true, builtins: ["move"] };
const NOTHING: BodyFeatures = { wiki: "off", lessons: false, milestones: false, reflexes: false, routines: false, builtins: [] };

/**
 * The usage text for a body that offers `features`, or for no body when `features` is null.
 * An agent reads only about the commands it can use. `operatorFlags` is the body flags' help
 * block, supplied by the CLI when the install can start bodies.
 */
export function usageFor(features: BodyFeatures | null, hasBody = HAS_BODY, operatorFlags: readonly string[] = []): string {
  const f = features ?? (hasBody ? EVERYTHING : NOTHING);
  const caps = { wiki: CAPABILITY_GATES.wiki(f), lessons: CAPABILITY_GATES.lessons(f), milestones: CAPABILITY_GATES.milestones(f), reflexes: CAPABILITY_GATES.reflexes(f), routines: CAPABILITY_GATES.routines(f), builtins: CAPABILITY_GATES.builtins(f), call: CAPABILITY_GATES.call(f) };
  // Starting a body is for whoever runs it. A body that answers is already running, and its agent has no use for the flags.
  const operator = hasBody && features === null;
  const commands = [
    ...(operator ? ["  body                 Start a body daemon and connect it to a server (foreground)."] : []),
    "  init [dir]           Scaffold a TypeScript authoring workspace in dir (default: the current directory).",
    "  list                 List running bodies.",
    "  observe              Print the body's observation as JSON. --brief prints one short line.",
    `  status               Print deaths and reconnects${caps.milestones ? ", and progress toward the body's milestones" : ""}.`,
    ...(caps.milestones ? [`  milestones           Print the body's milestones. "milestones set <file>" replaces them; "milestones clear" removes them.`] : []),
    `  notes                List the body's notes. "notes get <key>", "notes set <key> [text]" (text from stdin`,
    `                       when omitted), "notes rm <key>". Notes persist across body restarts.`,
    `  run [file]           Run a module (TypeScript or JavaScript) from a file, or from stdin when file is omitted or "-"; the body strips its types.`,
    `                       The result is its default export; a function is called with ctx and --args (a JSON object).`,
    ...(caps.routines
      ? [
          `  routines             List the saved routines (TypeScript modules the body runs by name) and what is bound to them. "routines save <file...>"`,
          `                       saves each .ts or .js file under its file name without the extension (a routine imports another as ./<name>.ts; list the`,
          `                       modules a routine imports first, so its type check finds them), "routines source|versions <name>", "routines revert <name> <n>".`,
          `  bind action <name> <routine>   Bind a name to a saved routine; "call" runs it.`,
          ...(caps.reflexes
            ? [
                `  bind reflex <name> <routine> --on <a,b>   Run a saved routine on its own when an event arrives, as (ctx, { event }); binding it again`,
                `                       enables it (options --from, --match, --when, --cooldown, --timeout, --priority, --preempt).`,
              ]
            : []),
          `  unbind <name>        Remove a binding${caps.reflexes ? "; also a stored entry the body skipped at start and reported as reflex_error, if unbind accepts its name (otherwise its reflex_error names the file to edit)" : ""}.`,
        ]
      : []),
    // Calls are served wherever the body has actions or built-ins; the line says which names it takes.
    ...(caps.call
      ? [
          caps.routines
            ? `  call <name>          Call the routine bound to name as an action${caps.builtins ? ", or a built-in as <module>.<routine> with no bind" : ""}; --args <json> are its arguments. Prints and exits like run.`
            : "  call <module>.<routine>   Call a built-in routine; --args <json> are its arguments. Prints and exits like run.",
        ]
      : []),
    ...(caps.builtins
      ? [
          "  builtins             List the built-in routine modules, their uses, and how often each built-in routine worked on this body.",
          "  builtins docs [module...]  Print the reference for built-in modules: call shapes, arguments, returns (default: every offered module).",
          "  builtins search <query>  Find built-in routines by what they do, e.g. \"collect logs\" (--limit <n>, default 5).",
          "  builtins source <module>  Print a built-in module's source file.",
        ]
      : []),
    "  stop                 Abort the running program.",
    "  events               Print buffered events as JSON.",
    "  wait                 Block until a matching event arrives (chat, nightfall, a death, a hostile nearby, low health...), then print it.",
    "  chat <message>       Send a chat message.",
    "  types                Print TypeScript declarations for the program globals of this body (--out <file> writes them); `tsc` then checks what you write.",
    ...(caps.wiki
      ? [
          `  wiki search <query>  Search the wiki (game mechanics, flows, quirks${caps.lessons ? ", and agents' lessons" : ""}).`,
          `  wiki read <page>     Print a wiki page, e.g. "quirks/drops-fall-out-of-reach".`,
          "  wiki list [section]  List wiki pages, optionally in one section.",
          ...(caps.lessons ? ["  wiki lesson          Add a lesson; the body text comes from stdin. Needs --title; --tags a,b is optional."] : []),
        ]
      : []),
    "  mcp                  Serve the body as MCP tools over stdio: the core tools, or every tool with --tools full.",
    "  api                  Print how a run works and what its context (ctx) holds on this body.",
  ];
  const options = [
    `  --bot <name>         Body name (default: $MINEBOT_BOT or "bot"). Ignored when $MINEBOT_URL is set.`,
    ...(operator ? operatorFlags : []),
    "  run:    --args <json>, --timeout <ms>",
    "  wait:   --types <a,b>, --from <name>, --match <regex>, --since <seq>, --timeout <ms>; prints \"timed out\" on timeout",
    ...(caps.call ? ["  call:   --args <json>, --timeout <ms>"] : []),
    "  events: --since <seq>",
    ...(caps.wiki ? ["  wiki:   --limit <n> (search results, default 5)"] : []),
    ...(caps.builtins ? ["  builtins: --limit <n> (search results, default 5)"] : []),
  ];
  return `Usage: minebot <command> [options]

Commands:
${commands.join("\n")}

Options:
${options.join("\n")}

Environment:
  MINEBOT_URL, MINEBOT_TOKEN   Reach a body at this URL instead of looking it up by name.${operator ? `
                               For "body", MINEBOT_TOKEN sets the API token (required off loopback).` : ""}`;
}
