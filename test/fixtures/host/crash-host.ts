// The real bot host with a fake player (fake-bot-host.ts), plus a death from host code that no run
// and no routine has anything to do with: a request for `/crash?mode=throw` (or `mode=reject`) makes
// the host throw from a timer 100 ms later (or reject a promise nobody handles). The real host
// answers the request itself, as for any unknown route.
import type { ToHost } from "../../../src/protocol/host.ts";
import "./fake-bot-host.ts";

process.on("message", (message: ToHost) => {
  if (message.kind !== "request" || !message.url.startsWith("/crash?")) return;
  const mode = new URL(message.url, "http://host").searchParams.get("mode");
  setTimeout(() => {
    if (mode === "throw") throw new Error("host code failed outside any run");
    void Promise.reject(new Error("host promise rejected outside any run"));
  }, 100);
});
