// A stand-in supervisor for host-process.test.ts: forks the real bot host (src/host/main.ts) with
// block-main-thread.ts preloaded, prints the host's pid once it reports it is blocked, then idles
// until it is killed.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostArguments } from "../../../src/protocol/host.ts";

const entry = fileURLToPath(new URL("../../../src/host/main.ts", import.meta.url));
const blocker = new URL("./block-main-thread.ts", import.meta.url).href;
const child = fork(entry, hostArguments(process.pid), { execArgv: [...process.execArgv, "--import", blocker] });
child.once("message", () => {
  console.log(`child ${child.pid}`);
});
setInterval(() => {}, 1000);
