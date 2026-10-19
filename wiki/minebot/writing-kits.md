---
title: Try, save, and revert your own kit
tags: [kits, agent kits, defineKit, action, try, save, revert, versions, search, stats, authoring]
requires: [agentKits]
verified_by: "smoke-tested on the 26.1 dev server, 2026-10-19"
mc_version: "26.1"
---

Write a kit when you repeat the same steps in program after program. Search first: another kit may already do it. Then try your source against the live body before you save it. A saved kit stays, so a mistake costs more than a failed try.

## Find a kit that already does it

```js
return kits.search("collect logs");
```

`kits.search(query, limit?)` ranks the kits and actions this body offers by name, kit description, and action doc. Each hit names the kit or the call, says whether the kit is active, and shows how often the action worked on this body. From the terminal: `minebot kits search "collect logs"`.

## Write it

A kit is one file: `export default defineKit({ name, description, uses, actions })`, with `action({ doc, args, run })` for each action. `defineKit`, `action`, and `z` are globals; the source cannot import anything. `uses` names the kits `run` calls through `ctx.kits`; `ctx` also holds `bot`, `log`, `sleep`, `signal`, `on`, `within`, and `store`, a JSON store that only this kit reads. Print a built-in kit with `kits.source("move")` and start from it. Write each `doc` to say what the action does and what it returns, because `kits.search` and `kits.docs()` show it.

## Try it first

```js
const source = notes.get("kits/woodcutter");
return kits.try(source, { action: "chop", args: { times: 1 } });
```

`kits.try(source, { action, args })` compiles and audits the source exactly as a save does, then calls the action once, inside your program, against the live bot. It returns the action's result, or throws its error, so a broken action shows its message in the run. Nothing is saved or registered, the `ctx.store` of your kit and of every kit it calls is thrown away, and no call is counted in the statistics. The kits in `uses` must be offered and active. From the terminal: `minebot kits try woodcutter.ts --action chop --args '{"times":1}'`.

## Save it, and take it back

`kits.save(source)` writes the kit and offers it at once. Saving over a kit keeps the old source:

```js
await kits.versions("woodcutter");   // [{ version: 1, savedAt, savedBy, current: false }, { version: 2, ..., current: true }]
await kits.revert("woodcutter", 1);  // saves version 1 again, as version 3
```

Every save of a different source is a new version, and a revert is a save, so a revert can be reverted. `savedBy` is the name of the body that saved it. The versions sit in `.history/<kit>/` inside the agent-kit directory, so bodies that share the directory share the history, and a kit you remove can still be reverted to. From the terminal: `minebot kits versions woodcutter` and `minebot kits revert woodcutter 1`.

## Prefer the actions that work

`kits.available()` lists, for each kit, how often each of its actions succeeded and failed on this body, and the message of the last failure:

```js
kits.available().find((k) => k.name === "woodcutter").stats;
// { chop: { ok: 12, failed: 3, lastError: "no log within reach" } }
```

`minebot kits` prints the same as `chop: 12 ok / 3 failed`. The body counts every call, including calls that one kit makes to another, and keeps the counts across restarts. Saving a different source for a kit, or removing it, resets its counts, because the old counts describe code that no longer exists. When two actions do the same job, call the one that works, and read `lastError` before you call the other.
