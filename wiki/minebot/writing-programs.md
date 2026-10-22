---
title: How to write programs that work
tags: [program, run, minebot, strategy, debugging, helpers, globalThis, timeout, verify]
verified_by: "practices from the Gemini 4 Argon dragon run (arXiv 2610.22319) and minebot's own oracle and demo runs"
---

A program is the body of an async function that runs against the live bot. These practices made long runs succeed:

1. **Observe first.** Start with `minebot observe` or a short program that returns what you need to know: inventory, nearby blocks, position.
2. **Keep programs short.** Do one step per program, return its result, and read the result before you write the next one.
3. **Verify, do not assume.** Compare the inventory before and after. A call that returns without an error can still have had no effect.
4. **Reuse helpers.** Store working functions on `globalThis`; they persist between programs. Fix a helper once instead of rewriting it.
5. **Bound every wait.** Pass `--timeout` and put time limits on moves and digs. See `quirks/pathfinding-needs-a-timeout`.
6. **Log progress.** `log(...)` inside loops shows how far a program got when it fails.
7. **Check `signal.aborted`** in long loops, so that `minebot stop` and timeouts end them.
8. **Search the wiki on surprises.** Search for the error text: `minebot wiki search "<error words>"`.

<!-- kits -->
When kits are active, prefer a kit action over raw Mineflayer code: `await kit.gatherer.gather({ blocks: "*_log", count: 4 })`. Run `minebot kits docs` for the full list with argument types.
<!-- /kits -->

<!-- routines -->
When you run the same code again and again, or it needs `import`, save it as a routine and call it by name. See `minebot/routines`.
<!-- /routines -->
