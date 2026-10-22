// Renderers for agent-facing output: program runs, status, notes, wiki hits and pages, routines and their bindings.
// The CLI and the MCP server share them, so an agent sees the same text through both.
import type { ActionStats, BindingInfo, BindResponse, BuiltinInfo, BuiltinSearchHit, KitInfo, KitSearchHit, KitTypeCheck, KitVersion, Note, ReflexBindingInfo, RoutineInfo, RoutineVersion, RunResult, SaveRoutineResponse, SearchHit, StatusResponse } from "../protocol/index.ts";

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

/** Renders the built-in modules an agent may use: one line per module, its uses, its routines, and how often each routine worked. */
export function formatBuiltins(builtins: BuiltinInfo[]): string {
  return builtins
    .map((module) => {
      const uses = module.uses.length > 0 ? ` (uses ${module.uses.join(", ")})` : "";
      const head = `${module.name}${uses}: ${module.description}\n    ${module.name}.{${module.routines.join(", ")}}`;
      const ran = Object.entries(module.stats);
      if (ran.length === 0) return head;
      const counts = `    calls: ${ran.map(([routine, stats]) => `${routine}: ${formatCounts(stats)}`).join("; ")}`;
      const failures = ran.filter(([, stats]) => stats.lastError).map(([routine, stats]) => `    last error of ${routine}: ${stats.lastError!.split("\n")[0]}`);
      return [head, counts, ...failures].join("\n");
    })
    .join("\n");
}

/** Renders built-in search hits, best first: the routine's call name, what it does, and how often it worked. */
export function formatBuiltinHits(hits: BuiltinSearchHit[]): string {
  return hits
    .map((hit) => {
      const name = hit.routine === undefined ? hit.module : `${hit.module}.${hit.routine}`;
      return `${name}${hit.stats ? ` [${formatCounts(hit.stats)}]` : ""}\n  ${hit.text}`;
    })
    .join("\n");
}

/** Renders the saved versions of an agent kit, one per line. */
export function formatKitVersions(name: string, versions: KitVersion[]): string {
  return versions
    .map((v) => `${name} v${v.version}${v.current ? " (current)" : ""}  ${v.savedAt}  by ${v.savedBy}${v.revertedFrom === undefined ? "" : `  (revert of v${v.revertedFrom})`}`)
    .join("\n");
}

/** Renders a reflex: when it fires, its state, its limits, and what it has done since the body started. */
function formatFiring(head: string, t: ReflexBindingInfo): string {
  const filters = [t.from && `from ${t.from}`, t.match && `match /${t.match}/`, t.when && `when ${t.when}`, t.preempt && "preempts", t.priority !== 0 && `priority ${t.priority}`]
    .filter(Boolean)
    .join("; ");
  const state = t.enabled ? "on" : `off: ${t.disabledReason ?? "disabled"}`;
  const last = t.lastStatus ? `; last ${t.lastStatus}${t.lastError ? ` (${t.lastError.split("\n")[0]})` : ""}` : "";
  return `${head}  [${state}]  on ${t.on.join(", ")}${filters ? `; ${filters}` : ""}\n  cooldown ${t.cooldownMs} ms, timeout ${t.timeoutMs} ms; fired ${t.fired} times${last}`;
}

/** `act  v3  2026-10-21T...`: a routine, its saved version, and when it was saved. */
function formatRoutine(routine: RoutineInfo): string {
  return routine.version === undefined ? `${routine.name}  (not saved through the library)` : `${routine.name}  v${routine.version}  ${routine.savedAt}`;
}

/** The routine library, one line per routine. */
function formatRoutines(routines: RoutineInfo[]): string {
  return routines.length === 0 ? "no routines" : routines.map(formatRoutine).join("\n");
}

/** Renders the saved versions of a routine, one per line: the same as for an agent kit. */
export function formatRoutineVersions(name: string, versions: RoutineVersion[]): string {
  return versions.length === 0 ? `no saved versions of ${name}` : formatKitVersions(name, versions);
}

/** Bindings: an action on one line, a reflex with its filters, limits, and what it has done since the body started. */
function formatBindings(bindings: BindingInfo[]): string {
  return bindings.length === 0
    ? "no bindings"
    : bindings.map((b) => (b.kind === "action" ? `${b.name}  action of ${b.routine}` : formatFiring(`${b.name}  reflex of ${b.routine}`, b))).join("\n");
}

/** Renders the routine library and the bindings over it: what an agent reads to see what it can call and what runs on its own. */
export function formatLibrary(routines: RoutineInfo[], bindings: BindingInfo[]): string {
  return `routines:\n${formatRoutines(routines)}\n\nbindings:\n${formatBindings(bindings)}`;
}

/** Renders the type check of a routine's source: the verdict, then one line per error. */
function formatTypeCheck(check: KitTypeCheck): string {
  if (check.status === "passed") return "type check: passed";
  if (check.status === "skipped") return `type check: skipped (${check.reason})`;
  return `type check: failed\n${check.errors.map((error) => `  ${error}`).join("\n")}`;
}

/** Renders a saved routine and the type check of its source, which did not stop the save. */
export function formatSavedRoutine({ routine, typeCheck }: SaveRoutineResponse): string {
  return `saved ${formatRoutine(routine)}\n${formatTypeCheck(typeCheck)}`;
}

/** Renders a routine after a revert: the new version holds the earlier source. */
export function formatRevertedRoutine(routine: RoutineInfo): string {
  return `reverted ${formatRoutine(routine)}`;
}

/** Renders a binding as the body stored it, and whether it replaced one of the same name. */
export function formatBound({ binding, replaced }: BindResponse): string {
  return `${replaced ? "replaced" : "bound"} ${formatBindings([binding])}`;
}

/** Renders a note listing, one header line per note. */
export function formatNotes(notes: Note[]): string {
  return notes.map((n) => `## ${n.key} (${n.updated})\n${n.text}`).join("\n\n");
}

/** Renders wiki search hits, one per line with a snippet. */
export function formatHits(hits: SearchHit[]): string {
  return hits.map((h) => `${h.id} [${h.status}] ${h.title}\n  ${h.snippet}`).join("\n");
}
