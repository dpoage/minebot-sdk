// Renderers for agent-facing output: program runs, status, notes, wiki hits and pages.
// The CLI and the MCP server share them, so an agent sees the same text through both.
import type { ActionStats, KitInfo, KitSearchHit, KitVersion, Note, RunResult, SearchHit, StatusResponse, TriggerInfo } from "../protocol/index.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Renders a program run for an agent: status line, then logs, then error or result. */
export function formatRun(run: RunResult): string {
  const parts = [`status: ${run.status} (${run.durationMs} ms)`];
  if (run.logs) parts.push(`logs:\n${run.logs}`);
  if (run.error) parts.push(`error:\n${run.error}`);
  if (run.result !== undefined) parts.push(`result:\n${typeof run.result === "string" ? run.result : json(run.result)}`);
  return parts.join("\n\n");
}

/** Renders a status for an agent: counters, then one line per milestone when the body has them. */
export function formatStatus(status: StatusResponse): string {
  const lines = [
    `${status.connected ? "connected" : "disconnected"}; body started ${status.startedAt}; deaths ${status.deaths}; reconnects ${status.reconnects}`,
  ];
  if (status.milestones) {
    lines.push(`milestones: ${Math.round(status.milestones.progress * 100)}% met${status.milestones.reward === 1 ? "; final milestone met" : ""}`);
    for (const m of status.milestones.milestones) {
      lines.push(`  [${m.met ? "x" : " "}] ${m.description} (${m.obtained}/${m.needed})`);
    }
  } else if (status.milestones !== undefined) {
    lines.push(status.milestonesError ? `milestones: unavailable (${status.milestonesError})` : "milestones: none set");
  }
  return lines.join("\n");
}

/** `12 ok / 3 failed`: how often an action succeeded and failed on this body. */
function formatCounts(stats: ActionStats): string {
  return `${stats.ok} ok / ${stats.failed} failed`;
}

/** Renders a kit listing for an agent: one line per kit, its uses, its actions, and how often each action worked. */
export function formatKits(kits: KitInfo[], locked: boolean): string {
  const lines = kits.map((kit) => {
    const uses = kit.uses.length > 0 ? ` (uses ${kit.uses.join(", ")})` : "";
    const author = kit.agent ? ", saved by an agent" : "";
    const head = `${kit.active ? "*" : " "} ${kit.name}${uses}${author}: ${kit.description}\n    kit.${kit.name}.{${kit.actions.join(", ")}}`;
    const ran = Object.entries(kit.stats);
    if (ran.length === 0) return head;
    const counts = `    calls: ${ran.map(([action, stats]) => `${action}: ${formatCounts(stats)}`).join("; ")}`;
    const failures = ran.filter(([, stats]) => stats.lastError).map(([action, stats]) => `    last error of ${action}: ${stats.lastError!.split("\n")[0]}`);
    return [head, counts, ...failures].join("\n");
  });
  if (locked) lines.push("\nkits are locked on this body");
  return lines.join("\n");
}

/** Renders kit search hits, best first: the call, what it does, and whether it is active and how often it worked. */
export function formatKitHits(hits: KitSearchHit[]): string {
  return hits
    .map((hit) => {
      const name = hit.action === undefined ? hit.kit : `kit.${hit.kit}.${hit.action}`;
      const notes = [hit.active ? "active" : "not active", ...(hit.stats ? [formatCounts(hit.stats)] : [])].join(", ");
      return `${name} [${notes}]\n  ${hit.text}`;
    })
    .join("\n");
}

/** Renders the saved versions of an agent kit, one per line. */
export function formatKitVersions(name: string, versions: KitVersion[]): string {
  return versions
    .map((v) => `${name} v${v.version}${v.current ? " (current)" : ""}  ${v.savedAt}  by ${v.savedBy}${v.revertedFrom === undefined ? "" : `  (revert of v${v.revertedFrom})`}`)
    .join("\n");
}

/** Renders a trigger listing: one header line per trigger, then what it did since the body started. */
export function formatTriggers(triggers: TriggerInfo[]): string {
  return triggers
    .map((t) => {
      const filters = [t.from && `from ${t.from}`, t.match && `match /${t.match}/`, t.when && `when ${t.when}`, t.preempt && "preempts", t.priority !== 0 && `priority ${t.priority}`]
        .filter(Boolean)
        .join("; ");
      const state = t.enabled ? "on" : `off: ${t.disabledReason ?? "disabled"}`;
      const last = t.lastStatus ? `; last ${t.lastStatus}${t.lastError ? ` (${t.lastError.split("\n")[0]})` : ""}` : "";
      return `${t.name}  [${state}]  on ${t.on.join(", ")}${filters ? `; ${filters}` : ""}\n  cooldown ${t.cooldownMs} ms, timeout ${t.timeoutMs} ms; fired ${t.fired} times${last}`;
    })
    .join("\n");
}

/** Renders a note listing, one header line per note. */
export function formatNotes(notes: Note[]): string {
  return notes.map((n) => `## ${n.key} (${n.updated})\n${n.text}`).join("\n\n");
}

/** Renders wiki search hits, one per line with a snippet. */
export function formatHits(hits: SearchHit[]): string {
  return hits.map((h) => `${h.id} [${h.status}] ${h.title}\n  ${h.snippet}`).join("\n");
}
