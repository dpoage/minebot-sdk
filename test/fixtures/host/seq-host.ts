// A bot host for host-process.test.ts: the real HostEvents and Triggers over the real channel,
// with no world. After `start` it pushes one `ping` event; a trigger on `ping` fires when the
// supervisor echoes it back, and reports the seq it fired on through `trigger_fired`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FromHost, ToHost } from "../../../src/protocol/host.ts";
import { HostEvents } from "../../../src/host/channel.ts";
import { Triggers } from "../../../src/host/triggers.ts";
import { JsonStore } from "../../../src/store.ts";

const send = (message: FromHost) => process.send!(message);
const events = new HostEvents(send);

process.on("message", async (message: ToHost) => {
  switch (message.kind) {
    case "init": {
      const triggers = new Triggers({
        store: new JsonStore(path.join(mkdtempSync(path.join(tmpdir(), "minebot-seq-host-")), "triggers.json")),
        events,
        runner: { running: null, stop: () => false },
        connected: () => true,
        bot: () => undefined,
        run: async (_trigger, _event, started) => {
          started();
          return { status: "ok", result: null, logs: "", durationMs: 0 };
        },
        register: async () => {},
      });
      await triggers.add({ name: "on-ping", on: ["ping"], run: "return 1;" });
      send({ kind: "ready" });
      return;
    }
    case "start":
      events.push("ping");
      return;
    case "event":
      events.hear(message.event);
      return;
    case "shutdown":
      process.exit(0);
  }
});
