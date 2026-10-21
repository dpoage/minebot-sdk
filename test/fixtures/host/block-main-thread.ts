// Preloaded (`--import`) into the real bot host by parent-process.ts. Once the host's entry has run
// its top level (it listens for the supervisor's messages by then), reports "blocked" and takes the
// main thread for good, as a program that never yields does.
const poll = setInterval(() => {
  if (process.listenerCount("message") === 0) return;
  clearInterval(poll);
  process.send!("blocked");
  // Give the message time to be written before the loop takes the thread.
  setTimeout(() => {
    for (;;);
  }, 50);
}, 10);
