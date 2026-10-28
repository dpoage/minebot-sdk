// Replays a body's recorded history through the run check (`typeCheckRun`): every run's `code` is checked
// against the routine library the runs were written for, and the refusals are counted by how each run
// really ended. The refusal set (typecheck-run.ts) was chosen by this measurement: a run that ended ok and
// the check refuses is a run the check would have stopped for nothing, so those are the ones to read.
//
//   node --conditions=minebot-sdk:source scripts/replay-run-check.ts <history.jsonl> <routines dir> [out.json]
//
// The history is the body's program history (`--history`): one JSON object per line, with `code` on the
// lines that were runs and `status` the run's real end. A run is named by its line in the file: `seq` is
// the body's own counter and repeats across the sessions a history holds. `out.json` holds one record per
// run for reading afterwards; the summary goes to stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { closeRunCheck, typeCheckRun } from "../src/host/typecheck.ts";
import type { TypeCheck } from "../src/protocol/index.ts";

interface HistoryRecord {
  seq: number;
  code?: string | null;
  status?: string;
  result?: unknown;
  error?: unknown;
}

interface Answer {
  /** The run's line in the history file (1-based): its identity, unlike `seq`. */
  line: number;
  seq: number;
  status: string;
  ms: number;
  check: TypeCheck;
  result?: string;
}

const [history, routines, out] = process.argv.slice(2);
if (!history || !routines) {
  console.error("usage: replay-run-check.ts <history.jsonl> <routines dir> [out.json]");
  process.exit(2);
}

const records = readFileSync(history, "utf8")
  .split("\n")
  .flatMap((text, index) => {
    if (text.trim() === "") return [];
    const record = JSON.parse(text) as HistoryRecord;
    return typeof record.code === "string" && record.code !== "" ? [{ line: index + 1, record }] : [];
  });

const answers: Answer[] = [];
for (const { line, record } of records) {
  const started = Date.now();
  const check = await typeCheckRun(routines, record.code!, { budgetMs: 120_000 });
  answers.push({ line, seq: record.seq, status: record.status ?? "unknown", ms: Date.now() - started, check, result: JSON.stringify(record.result ?? record.error ?? "").slice(0, 160) });
}
if (out !== undefined) writeFileSync(out, JSON.stringify(answers, null, 1));
// The warm checker's compiler child would otherwise keep this process alive.
await closeRunCheck();

const refused = answers.filter((answer) => answer.check.status === "failed");
const skipped = answers.filter((answer) => answer.check.status === "skipped");
const statuses = [...new Set(answers.map((answer) => answer.status))].sort();
console.log(`runs ${answers.length} refused ${refused.length} skipped ${skipped.length}`);
for (const status of statuses) {
  const of = answers.filter((answer) => answer.status === status);
  const bad = of.filter((answer) => answer.check.status === "failed");
  console.log(`${status}: refused ${bad.length} of ${of.length}`);
}
const named = (answer: Answer) => `#${answer.line} (seq ${answer.seq})`;
console.log(`ok-run refusals: ${refused.filter((answer) => answer.status === "ok").map(named).join(" ") || "none"}`);
for (const answer of refused.filter((answer) => answer.status === "ok")) {
  const errors = answer.check.status === "failed" ? answer.check.errors : [];
  console.log(`  ${named(answer)}: ${errors.join(" | ").replace(/\n/g, " / ")}`);
}
const reasons: Record<string, number> = {};
for (const answer of skipped) {
  const reason = answer.check.status === "skipped" ? answer.check.reason : "";
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}
for (const [reason, count] of Object.entries(reasons)) console.log(`skipped ${count}: ${reason}`);
