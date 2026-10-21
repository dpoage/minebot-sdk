// A host whose main thread is blocked for good, with the supervisor watch the real host starts.
// Started by parent-process.ts with the parent's pid as its argument.
import { watchSupervisor } from "../../../src/host/supervisor-watch.ts";

watchSupervisor(Number(process.argv[2]));
process.send!("blocked");
// Give the message time to be written before the loop takes the thread.
setTimeout(() => {
  for (;;);
}, 50);
