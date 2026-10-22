// The usage text of the `minebot` command, built from what the body offers: the capability
// table decides which commands and options an agent reads about.
import { existsSync } from "node:fs";
import { CAPABILITY_GATES, type BodyFeatures } from "../protocol/index.ts";

/** A client-only install leaves out the body modules, and with it the `body` command. Looks for the daemon with this file's own extension: `.ts` from source, `.js` from a build. */
export const HAS_BODY = existsSync(new URL(`../body/daemon${import.meta.url.slice(import.meta.url.lastIndexOf("."))}`, import.meta.url));

/** What the usage text shows when no body can be asked: everything on an install that can start bodies, nothing optional otherwise. */
const EVERYTHING: BodyFeatures = { kits: ["move"], kitsLocked: false, agentKits: true, wiki: "write", lessons: true, milestones: true, triggers: true, routines: true };
const NOTHING: BodyFeatures = { kits: [], kitsLocked: true, agentKits: false, wiki: "off", lessons: false, milestones: false, triggers: false, routines: false };

/**
 * The usage text for a body that offers `features`, or for no body when `features` is null.
 * An agent reads only about the commands it can use. `operatorFlags` is the body flags' help
 * block, supplied by the CLI when the install can start bodies.
 */
export function usageFor(features: BodyFeatures | null, hasBody = HAS_BODY, operatorFlags: readonly string[] = []): string {
  const f = features ?? (hasBody ? EVERYTHING : NOTHING);
  const caps = { kits: CAPABILITY_GATES.kits(f), kitSwitching: CAPABILITY_GATES.kitSwitching(f), agentKits: CAPABILITY_GATES.agentKits(f), wiki: CAPABILITY_GATES.wiki(f), lessons: CAPABILITY_GATES.lessons(f), milestones: CAPABILITY_GATES.milestones(f), triggers: CAPABILITY_GATES.triggers(f) };
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
    `  run [file]           Run a program from a file, or from stdin when file is omitted or "-". A .ts file has its types stripped first.`,
    ...(caps.triggers
      ? [
          `  triggers             List the body's triggers: programs that run when an event arrives. "triggers add <name> --on <a,b> [file]"`,
          `                       saves one (program from stdin when file is omitted; options --from, --match, --when, --cooldown, --timeout,`,
          `                       --priority, --preempt), "triggers rm|enable|disable <name>".`,
        ]
      : []),
    "  stop                 Abort the running program.",
    "  events               Print buffered events as JSON.",
    "  wait                 Block until a matching event arrives (chat, nightfall, a death, a hostile nearby, low health...), then print it.",
    "  chat <message>       Send a chat message.",
    `  types                Print TypeScript declarations for the program globals${caps.kits ? " and kits" : ""} of this body (--out <file> writes them); \`tsc\` then checks what you write.`,
    ...(caps.kits
      ? [
          "  kits                 List kits, their uses, and their actions, marking the active ones.",
          ...(caps.kitSwitching ? ["  kits use <kit...>    Replace the active kits (used kits are added)."] : []),
          "  kits docs [kit...]   Print the action reference for kits (default: the active kits).",
          "  kits search <query>  Find kits and actions by what they do, e.g. \"collect logs\" (--limit <n>, default 5).",
        ]
      : []),
    ...(caps.agentKits
      ? [
          "  kits save [file]     Save an agent kit from a TypeScript file (stdin when omitted).",
          "  kits rm <kit>        Delete a saved agent kit.",
          "  kits source <kit>    Print a kit's source: a built-in kit's file, or a saved one.",
          "  kits try [file]      Run one action of kit source once without saving it: --action <name> [--args <json>] [--timeout <ms>].",
          "  kits versions <kit>  List the saved versions of an agent kit.",
          "  kits revert <kit> <n>  Save version n of an agent kit again, as a new version.",
        ]
      : []),
    ...(caps.wiki
      ? [
          `  wiki search <query>  Search the wiki (game mechanics, flows, quirks${caps.lessons ? ", and agents' lessons" : ""}).`,
          `  wiki read <page>     Print a wiki page, e.g. "quirks/drops-fall-out-of-reach".`,
          "  wiki list [section]  List wiki pages, optionally in one section.",
          ...(caps.lessons ? ["  wiki lesson          Add a lesson; the body text comes from stdin. Needs --title; --tags a,b is optional."] : []),
        ]
      : []),
    "  mcp                  Serve the body as MCP tools over stdio: the core tools, or every tool with --tools full.",
    "  api                  Print the program environment reference.",
  ];
  const options = [
    `  --bot <name>         Body name (default: $MINEBOT_BOT or "bot"). Ignored when $MINEBOT_URL is set.`,
    ...(operator ? operatorFlags : []),
    "  run:    --timeout <ms>",
    "  wait:   --types <a,b>, --from <name>, --match <regex>, --since <seq>, --timeout <ms>; prints \"timed out\" on timeout",
    "  events: --since <seq>",
    ...(caps.wiki ? ["  wiki:   --limit <n> (search results, default 5)"] : []),
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
