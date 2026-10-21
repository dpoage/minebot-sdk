// A stand-in supervisor for host-process.test.ts: forks blocked-host.ts, prints its pid once the
// host reports it is blocked, then idles until it is killed.
import { fork } from "node:child_process";

const child = fork(new URL("./blocked-host.ts", import.meta.url).pathname, [String(process.pid)]);
child.once("message", () => {
  console.log(`child ${child.pid}`);
});
setInterval(() => {}, 1000);
