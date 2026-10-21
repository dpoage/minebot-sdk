// Ends the host when its supervisor is gone. A program can block the host's main thread, and then
// the IPC channel is never read and its closing is never seen; a worker thread notices the
// supervisor's death anyway and kills the process. It does nothing else.
import { Worker } from "node:worker_threads";

const POLL_MS = 250;

/** Kills this process once its parent is no longer `supervisorPid` (the supervisor died and the host was re-parented). */
export function watchSupervisor(supervisorPid: number): void {
  new Worker(`setInterval(() => { if (process.ppid !== ${supervisorPid}) process.kill(process.pid, "SIGKILL"); }, ${POLL_MS});`, { eval: true }).unref();
}
