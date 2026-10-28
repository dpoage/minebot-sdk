// Runs ProgramRunner in a process of its own with the host's handlers: an uncaught exception or an
// unhandled rejection is given to `runner.contain` as src/host/main.ts gives it, and what the runner
// does not take is recorded (the host would exit there). Prints one JSON object: the outcome of each
// scenario, how often the body was halted in it, and what reached no run. The scenarios are the ones
// test/containment.test.ts asserts on.
import { setTimeout as sleepFor } from "node:timers/promises";
import { ProgramRunner, type RunnerOptions } from "../../../src/program/runner.ts";

const sourceDir = "/nonexistent/routines";
/** Errors `contain` did not take: in the host, each is a crash. */
const crashes: string[] = [];
let runner = new ProgramRunner();

process.on("uncaughtException", (err) => {
  if (!runner.contain(err, "exception")) crashes.push(`exception: ${String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  if (!runner.contain(reason, "rejection")) crashes.push(`rejection: ${String(reason)}`);
});

const outcomes: Record<string, unknown> = {};
const halts: Record<string, number> = {};

/** Runs `fn` as the scenario `name` on a runner with `options`, the halts counted under `name` (a `halt` option replaces the count). */
async function scenario(name: string, fn: Parameters<ProgramRunner["call"]>[0], options: RunnerOptions & { timeoutMs?: number; stop?: boolean } = {}): Promise<void> {
  const { timeoutMs, stop, ...runnerOptions } = options;
  halts[name] = 0;
  runner = new ProgramRunner({
    graceMs: 300,
    halt: () => void halts[name]!++,
    ...runnerOptions,
  });
  const pending = runner.call(fn, { sourceDir, timeoutMs });
  if (stop) {
    await sleepFor(20);
    runner.stop();
  }
  const { durationMs: _, ...outcome } = await pending;
  outcomes[name] = outcome;
  // Whatever the run left behind reaches the process after its end was reported.
  await sleepFor(120);
}

await scenario("timer-throw", async ({ sleep }) => {
  setTimeout(() => {
    throw new Error("timer boom");
  }, 10);
  await sleep(5_000);
});

await scenario("rejection-active", async ({ sleep }) => {
  void Promise.reject(new Error("rejected while active"));
  await sleep(5_000);
});

await scenario("rejection-after-ok", async () => {
  void Promise.reject(new Error("rejected after ok"));
  return "returned";
});

await scenario("rejection-after-own-error", async () => {
  void Promise.reject(new Error("rejected before the throw"));
  throw new Error("own error");
});

await scenario("rejection-later-than-window", async () => {
  setTimeout(() => void Promise.reject(new Error("rejected too late")), 40);
  return "returned";
});

await scenario(
  "exception-in-grace",
  async ({ sleep }) => {
    try {
      await sleep(60_000);
    } catch {
      setTimeout(() => {
        throw new Error("thrown in the grace");
      }, 10);
      await sleepFor(60);
    }
  },
  { stop: true },
);

await scenario("unawaited-sleep", async ({ sleep }) => {
  void sleep(5_000);
  return "returned";
});

await scenario("exception-after-end", async () => {
  setTimeout(() => {
    throw new Error("thrown after the run ended");
  }, 40);
  return "returned";
});

// The body is halted once per end, whatever the end.
await scenario("halt-ok", async () => 1);
await scenario("halt-error", async () => {
  throw new Error("own error");
});
await scenario("halt-timeout", async ({ sleep }) => sleep(5_000), { timeoutMs: 30 });
await scenario("halt-stopped", async ({ sleep }) => sleep(5_000), { stop: true });

// A body whose pending call the halt cancels, as a pathfinder's goto rejects when its goal is cleared.
let pending: PromiseWithResolvers<void> | undefined;
await scenario(
  "halt-cancels-unawaited-call",
  async () => {
    pending = Promise.withResolvers<void>();
    void pending.promise;
    return "returned";
  },
  {
    halt: () => {
      pending?.reject(new Error("The goal was changed before it could be completed!"));
      pending = undefined;
    },
  },
);

// explain: once per error end, appended; a throwing explain changes nothing; none for ok, stopped, timeout.
const explained: Record<string, string[]> = {};
async function explaining(name: string, fn: Parameters<ProgramRunner["call"]>[0], explain: (err: unknown) => string | undefined, options: { timeoutMs?: number; stop?: boolean } = {}): Promise<void> {
  const calls: string[] = [];
  await scenario(name, fn, {
    ...options,
    explain: (err) => {
      calls.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      return explain(err);
    },
  });
  explained[name] = calls;
}

await explaining(
  "explain-thrown",
  async () => {
    throw new Error("program threw");
  },
  () => "hint: first thing to try",
);
await explaining(
  "explain-contained",
  async ({ sleep }) => {
    setTimeout(() => {
      throw new Error("timer threw");
    }, 10);
    await sleep(5_000);
  },
  () => "hint: contained",
);
await explaining(
  "explain-after-rejection",
  async () => {
    void Promise.reject(new Error("not awaited"));
    return "returned";
  },
  () => "hint: rejection",
);
await explaining(
  "explain-own-error-plus-rejection",
  async () => {
    void Promise.reject(new Error("second"));
    throw new Error("first");
  },
  () => "hint: last",
);
await explaining(
  "explain-throws",
  async () => {
    throw new Error("program threw");
  },
  () => {
    throw new Error("explain failed");
  },
);
await explaining(
  "explain-empty",
  async () => {
    throw new Error("program threw");
  },
  () => "",
);
await explaining("explain-ok", async () => 1, () => "never");
await explaining("explain-stopped", async ({ sleep }) => sleep(5_000), () => "never", { stop: true });
await explaining("explain-timeout", async ({ sleep }) => sleep(5_000), () => "never", { timeoutMs: 30 });

process.stdout.write(JSON.stringify({ outcomes, halts, crashes, explained }));
