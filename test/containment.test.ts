// What ProgramRunner does with an error that reaches the process while a run's code is active (or just
// ended), the halt at every end, and the explain hook (seam C1). The runner runs in a process of its own
// (fixtures/host/containment-runner.ts) with the host's handlers wired to `runner.contain`; the host
// itself, over the real supervisor, is test/containment-host.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { before, describe, it } from "node:test";
import { NOT_AWAITED } from "../src/program/runner.ts";

interface Outcome {
  status: string;
  result?: unknown;
  error?: string;
  logs: string;
  hung?: true;
}

let report: { outcomes: Record<string, Outcome>; halts: Record<string, number>; crashes: string[]; explained: Record<string, string[]> };

before(() => {
  const script = path.join(import.meta.dirname, "fixtures", "host", "containment-runner.ts");
  const child = spawnSync(process.execPath, ["--conditions=minebot-sdk:source", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  report = JSON.parse(child.stdout);
});

const outcome = (name: string): Outcome => report.outcomes[name]!;
const lines = (name: string): string[] => (outcome(name).error ?? "").split("\n");

describe("a run's code is active when an error reaches the process", () => {
  it("(P1.1) a throw in a timer ends the run with status error: the message, then the frame it was thrown from", () => {
    const run = outcome("timer-throw");
    assert.equal(run.status, "error");
    assert.equal(lines("timer-throw")[0], "Error: timer boom");
    assert.match(lines("timer-throw")[1]!, /^\s+at .*containment-runner\.ts:\d+:\d+/, "the top frame is named, though no frame is inside the run's source directory");
    assert.equal(report.crashes.filter((crash) => crash.includes("timer boom")).length, 0, "the error was given to no crash");
  });

  it("(P1.2) a rejection nothing awaits ends the run with status error: its message and the missing await", () => {
    const run = outcome("rejection-active");
    assert.equal(run.status, "error");
    assert.equal(lines("rejection-active")[0], `Error: rejected while active${NOT_AWAITED}`);
    assert.equal(lines("rejection-active")[0], "Error: rejected while active - this promise was not awaited; add await before the call");
  });

  it("an exception does not say await: only a rejection does", () => {
    assert.ok(!(outcome("timer-throw").error ?? "").includes("not awaited"));
  });
});

describe("a run is containable for one macrotask after its program settled", () => {
  it("(P1.2) a rejection dispatched as the run ends turns an ok run into an error, without its result", () => {
    const run = outcome("rejection-after-ok");
    assert.equal(run.status, "error");
    assert.equal(run.result, undefined);
    assert.equal(lines("rejection-after-ok")[0], `Error: rejected after ok${NOT_AWAITED}`);
  });

  it("(P1.2) a run's own error stays first; the rejection follows as a line", () => {
    const [first, ...rest] = lines("rejection-after-own-error");
    assert.equal(outcome("rejection-after-own-error").status, "error");
    assert.equal(first, "Error: own error");
    assert.ok(rest.includes(`Error: rejected before the throw${NOT_AWAITED}`), JSON.stringify(rest));
  });

  it("a sleep the program left unawaited, which its end rejects, ends it with an error naming the missing await", () => {
    const run = outcome("unawaited-sleep");
    assert.equal(run.status, "error");
    assert.ok((run.error ?? "").includes(NOT_AWAITED), String(run.error));
  });

  it("an error that arrives after the macrotask is no run's: the process handler gets it back (a crash in the host), and the run was ok", () => {
    assert.equal(outcome("rejection-later-than-window").status, "ok");
    assert.equal(outcome("exception-after-end").status, "ok");
    assert.deepEqual(report.crashes, ["rejection: Error: rejected too late", "exception: Error: thrown after the run ended"]);
  });

  it("a program in its grace after a stop is containable: its status stays stopped and the error is added", () => {
    const stopped = outcome("exception-in-grace");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.hung, undefined);
    assert.equal(lines("exception-in-grace")[0], "Error: thrown in the grace");
  });
});

describe("the body is halted at every end of a run (mb-mf5)", () => {
  for (const name of ["halt-ok", "halt-error", "halt-timeout", "halt-stopped"]) {
    it(`${name}: once`, () => assert.equal(report.halts[name], 1));
  }

  it("a contained end halts once, synchronously inside contain, and not again at its end", () => {
    assert.equal(report.halts["timer-throw"], 1);
    assert.equal(report.halts["rejection-active"], 1);
  });

  it("an unawaited call that the halt cancels ends its run with status error naming the missing await", () => {
    const run = outcome("halt-cancels-unawaited-call");
    assert.equal(run.status, "error");
    assert.equal(lines("halt-cancels-unawaited-call")[0], `Error: The goal was changed before it could be completed!${NOT_AWAITED}`);
    assert.equal(lines("halt-cancels-unawaited-call")[0], "Error: The goal was changed before it could be completed! - this promise was not awaited; add await before the call");
  });
});

describe("explain (C1) is called once for every run that ends with status error", () => {
  it("(P1.4) a program's throw: with the thrown value; its line is the error's last", () => {
    assert.deepEqual(report.explained["explain-thrown"], ["Error: program threw"]);
    const [first, ...rest] = lines("explain-thrown");
    assert.equal(first, "Error: program threw");
    assert.equal(rest.at(-1), "hint: first thing to try");
  });

  it("(P1.4) a contained error: with the error the process handler got", () => {
    assert.deepEqual(report.explained["explain-contained"], ["Error: timer threw"]);
    assert.equal(lines("explain-contained").at(-1), "hint: contained");
  });

  it("(P1.4) an ok run turned into an error by a rejection: with the rejection", () => {
    assert.deepEqual(report.explained["explain-after-rejection"], ["Error: not awaited"]);
    assert.equal(lines("explain-after-rejection").at(-1), "hint: rejection");
  });

  it("(P1.4) an error with a rejection added: once, with the first error; the explanation follows the added line", () => {
    assert.deepEqual(report.explained["explain-own-error-plus-rejection"], ["Error: first"]);
    const all = lines("explain-own-error-plus-rejection");
    assert.equal(all[0], "Error: first");
    assert.equal(all.at(-1), "hint: last");
    assert.ok(all.includes(`Error: second${NOT_AWAITED}`));
  });

  it("(P1.4) a throwing explain is ignored: the run ends with its error unchanged", () => {
    assert.deepEqual(report.explained["explain-throws"], ["Error: program threw"]);
    assert.equal(outcome("explain-throws").status, "error");
    assert.equal(lines("explain-throws")[0], "Error: program threw");
    assert.ok(!(outcome("explain-throws").error ?? "").includes("explain failed"));
  });

  it("nothing is appended for an explanation that is empty", () => {
    assert.deepEqual(report.explained["explain-empty"], ["Error: program threw"]);
    assert.equal(outcome("explain-empty").error?.endsWith("\n"), false);
  });

  it("it is not called for an end that is not an error: ok, stopped, timeout", () => {
    assert.deepEqual([report.explained["explain-ok"], report.explained["explain-stopped"], report.explained["explain-timeout"]], [[], [], []]);
    assert.deepEqual([outcome("explain-ok").status, outcome("explain-stopped").status, outcome("explain-timeout").status], ["ok", "stopped", "timeout"]);
  });
});
