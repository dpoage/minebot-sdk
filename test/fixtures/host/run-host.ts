// A bot host for host-process.test.ts: the real RunReporter over the real channel, with no world.
// After `start` it records two runs, one that produces a result and one that throws before it
// does, and reports how each ended as a `recorded` event.
import type { FromHost, ToHost } from "../../../src/protocol/host.ts";
import type { RunResult } from "../../../src/protocol/index.ts";
import { RunReporter } from "../../../src/host/channel.ts";

const send = (message: FromHost) => process.send!(message);
const reporter = new RunReporter({ send, stop: () => false, running: () => false });

async function record(name: string, execute: () => Promise<RunResult>): Promise<void> {
  try {
    const result = await reporter.record({ code: "return 1;" }, execute);
    send({ kind: "event", type: "recorded", data: { name, status: result.status } });
  } catch (err) {
    send({ kind: "event", type: "recorded", data: { name, error: err instanceof Error ? err.message : String(err) } });
  }
}

process.on("message", async (message: ToHost) => {
  switch (message.kind) {
    case "init":
      send({ kind: "ready" });
      return;
    case "start":
      await record("result", async () => ({ status: "ok", result: 1, logs: "", durationMs: 0 }));
      await record("thrown", async () => {
        throw new Error("the body is not connected");
      });
      return;
    case "run_ack":
      reporter.acknowledge(message.runId, message.error);
      return;
    case "shutdown":
      process.exit(0);
  }
});
