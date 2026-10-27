---
title: "MCP transport caps requests at 30s: long runs must be launched from the
  CLI and polled via events"
tags:
  - mcp
  - timeout
  - run
  - cli
  - transport
  - long-run
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T15:02:17.468Z
---

The minebot MCP server (stdio) cuts off any request that doesn't answer within ~30s. `run_program` and `call_routine` with a larger `timeout_ms` return "MCP request timed out" even though the run keeps executing on the body to its own timeout. `wait_for` with `timeout_ms` > ~29s is affected the same way.

Patterns that work:
- Long runs (minutes): write them as a file and run `npx minebot run --bot rivet runs/<file>.ts --timeout <ms>` from a shell; poll `npx minebot observe --brief` / `npx minebot events` for `program_finished`.
- Short MCP calls (<= ~25s) are fine for quick state checks.
- A run that must produce a durable result should also write it to a note (e.g. `notes.set("camp/state", ...)`), because the caller that launched it may be gone when the run finishes.

## SDK update, 2026-10-25 (minebot-sdk e97ef83)

A detached caller can now read the outcome directly. The `program_finished` event's `data.run` is the run's seq. Pass it to the `get_run` MCP tool, or to `npx minebot runs --bot rivet <seq>`, to get the status, logs, and result or error. Without a seq, you get the latest finished run. The body keeps the last 20 foreground runs (reflex firings are not kept). Do not pass the event's own `seq`. A note is still the way to keep a result for longer than that.
