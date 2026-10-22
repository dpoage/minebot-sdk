// The `minebot body` command: starts a body daemon and keeps it running until SIGINT or SIGTERM.
// Kept apart from src/cli.ts so that a client-only install (the benchmark agent's image) can omit the body.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MilestoneSet } from "../milestones/milestones.ts";
import { RUNTIME_DIR } from "../protocol/index.ts";
import { builtinOffer, parseBodyFlags } from "../client/body-flags.ts";
import { startDaemon } from "./daemon.ts";

export interface BodyCommandInput {
  name: string;
  token: string | undefined;
  /** Raw flag values, as parseArgs produced them. */
  flags: Record<string, string | boolean | undefined>;
}

export async function runBody({ name, token, flags }: BodyCommandInput): Promise<number> {
  const parsed = parseBodyFlags(name, flags);
  const daemon = await startDaemon({
    name,
    username: parsed.username ?? name,
    auth: parsed.auth,
    host: parsed.host,
    port: parsed.port,
    apiHost: parsed.apiHost,
    apiPort: parsed.apiPort,
    token,
    historyFile: parsed.history,
    builtins: builtinOffer(parsed.builtins),
    wikiMode: parsed.wiki,
    wikiDir: parsed.wikiDir,
    lessonsDir: parsed.lessons ?? path.join(RUNTIME_DIR, "lessons"),
    stateDir: parsed.state ?? path.join(RUNTIME_DIR, "state", name),
    milestones: parsed.milestones ? MilestoneSet.parse(JSON.parse(await readFile(parsed.milestones, "utf8"))) : undefined,
    milestonesEnabled: !parsed.noMilestones,
    triggers: !parsed.noReflexes,
    routines: !parsed.noRoutines,
    routinesDir: parsed.routines,
  });
  console.error(`[minebot] body "${name}" API at ${daemon.endpoint.url}; joining ${parsed.host}:${parsed.port}`);
  const stopped = Promise.withResolvers<void>();
  process.once("SIGINT", () => stopped.resolve());
  process.once("SIGTERM", () => stopped.resolve());
  await stopped.promise;
  await daemon.close();
  return 0;
}
