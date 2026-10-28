// The run check must not stall the host's event loop: the compiler runs in another process, so a body
// keeps answering while a run is checked. A child process measures the loop's delay with
// `monitorEventLoopDelay` (enabled 10 s before the check, and 1 s before the warm one), for a cold check
// (the first of a process, which opens the compiler) and a warm one: the histogram's max stays under
// 100 ms in both. A check that compiled on the host thread would block it for seconds.
//
// The delays are real time on purpose: event-loop delay IS wall clock, so there is nothing to fake.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type { TypeCheck } from "../src/protocol/index.ts";

interface Measured {
  cold: TypeCheck;
  warm: TypeCheck;
  coldMaxMs: number;
  warmMaxMs: number;
  elapsedMs: number;
}

const script = (typecheck: string) => `
import { mkdtempSync, rmSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { closeRunCheck, typeCheckRun } from ${JSON.stringify(typecheck)};
const started = Date.now();
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
const dir = mkdtempSync(path.join(tmpdir(), "minebot-run-check-delay-"));
const source = "export default async (ctx) => ctx.bot.selectItem(null);\\n";
// The monitor has been enabled for 10 s when the cold check starts, and stays enabled throughout.
while (Date.now() - started < 10_000) await pause(100);
histogram.reset();
const cold = await typeCheckRun(dir, source);
const coldMaxMs = histogram.max / 1e6;
await pause(1000);
histogram.reset();
const warm = await typeCheckRun(dir, source);
const warmMaxMs = histogram.max / 1e6;
histogram.disable();
rmSync(dir, { recursive: true, force: true });
// The compiler child would keep this process alive past the report.
await closeRunCheck();
console.log(JSON.stringify({ cold, warm, coldMaxMs, warmMaxMs, elapsedMs: Date.now() - started }));
`;

describe("the run check's cost to the host's event loop", () => {
  it("stays under 100 ms of delay, cold and warm", { timeout: 180_000 }, async () => {
    const typecheck = new URL("../src/host/typecheck.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=minebot-sdk:source", "--input-type=module", "--eval", script(typecheck)], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const measured = JSON.parse(stdout.trim().split("\n").at(-1)!) as Measured;
    assert.ok(measured.coldMaxMs < 100, `cold check delayed the loop by ${measured.coldMaxMs} ms`);
    assert.ok(measured.warmMaxMs < 100, `warm check delayed the loop by ${measured.warmMaxMs} ms`);
    // Both checks answered (an environment without typescript would skip and measure nothing).
    assert.equal(measured.cold.status, "failed", JSON.stringify(measured));
    assert.equal(measured.warm.status, "failed", JSON.stringify(measured));
  });
});
