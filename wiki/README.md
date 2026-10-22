# minebot wiki

The wiki is a set of markdown pages that agents search and read while they play. Pages describe game mechanics, step-by-step flows, and quirks of this Minecraft version and of Mineflayer that a model is unlikely to know.

Agents reach the wiki through the body: `minebot wiki search|read|list`, `ctx.wiki` in a run, or the `wiki_*` MCP tools (with `minebot mcp --tools full`). This README is not a page.

## Sections

| Section | Contents |
| - | - |
| `mechanics/` | How the game works: tool tiers, crafting, smelting, hunger, mobs, time. |
| `flows/` | Ordered steps to reach a goal, such as the first day or iron tools. |
| `quirks/` | Surprising behavior of Minecraft 26.1, Mineflayer, or minebot, with the workaround. |
| `reference/` | Tables generated from the game's data: recipes, blocks and their tools, drops, foods, mobs, enchantments. See Generated pages. |
| `minebot/` | How to work with the body: writing runs, notes, built-in routines, your own routines, reflexes. |
| `checks/` | Check modules. These are not pages. |

Lessons that agents write go to a separate directory (`--lessons`, default `.minebot/lessons/`). Lessons appear under the id prefix `lessons/`.

## Generated pages

The pages in `reference/` are not written by hand. `npm run wiki:reference` builds them from `minecraft-data` (the data Mineflayer loads) and, for what minecraft-data lacks for 26.1 (furnace recipes, stonecutting, smithing, item tags, mob loot), from the vanilla server's own data generator, which it runs from `.dev-server/server-26.1.jar`. Each page is small, split by letter, and carries `mc_version` and `verified_by: generated from ...`. Edit `scripts/wiki-reference.ts`, not the pages, and run it again after you change `MC_VERSION` or upgrade `minecraft-data`.

## Page format

Each page starts with YAML frontmatter:

```markdown
---
title: Drops can fall out of pickup range
tags: [drops, items, gathering]
mc_version: "26.1"
verified_by: observed in the craft-wooden-pickaxe demo, 2026-10-18
check: drops-fall-out-of-reach.js
---

Body in markdown.
```

| Field | Required | Meaning |
| - | - | - |
| `title` | yes | One line that states the fact or the goal. |
| `tags` | no | Search terms that are not in the title. |
| `mc_version` | no | The Minecraft version on which someone confirmed the page. Leave it out for general knowledge that nobody has checked in game. |
| `verified_by` | yes | How the page was confirmed: a check module, a test, or a dated observation. |
| `check` | no | A module in `checks/` that succeeds while the page is true. |
| `requires` | no | Features a body needs for the page to make sense: `builtins`, `milestones`, `reflexes`, `routines`. Bodies without one do not see the page. |

## Features

A body can lack built-in routines, milestones, reflexes, or routines. An agent must not read about a feature its body does not have, so the body hides that content:

- A page that needs a feature declares it in the frontmatter: `requires: [builtins]`. Bodies without built-in routines do not list, search, or read the page.
- A block of a page that needs a feature goes between marker lines, `<!-- builtins -->` and `<!-- /builtins -->` (or `milestones`, `reflexes`, `routines`). Bodies without the feature do not see the block, neither in the page nor in search results. Bodies with it see the text without the markers. Blocks do not nest.
- Everything outside the markers, and the title, the tags, and `verified_by`, must read well on a body without any of these features. A test (`test/wiki.test.ts`) fails when a page mentions kits, lessons, or milestones there.

Write each page for Mineflayer first, and put the built-in routines that do the same in a `<!-- builtins -->` block after it. The feature names come from one enum (`WikiFeature` in `src/protocol/schemas.ts`); the cut markers accept exactly those names.

## Status

Search results and pages show a status:

- `verified`: `mc_version` equals the pinned version in `src/mc/version.ts`.
- `stale`: `mc_version` is a different version. Confirm the page again before you trust it.
- `unverified`: the page has no `mc_version`.
- `lesson`: an agent wrote it, and nobody has reviewed it.

## Rules

1. State only what you confirmed, or mark the page as unverified by leaving out `mc_version`. An agent acts on a wrong page with full confidence.
2. Write the symptom first, so that a search for the error message finds the page.
3. Give the workaround as Mineflayer code in a module: `export default async (ctx) => { ... }`, with `import` for `goals`, `Movements`, and `Vec3` (a run has no `bot` or `goals` global). A built-in routine that does the same may follow in a `<!-- builtins -->` block (see Features).
4. Keep one fact or one flow per page.

## Checks

A check is a run module. Its default export, `async (ctx) => value`, returns while its page is true, and it throws with a reason when the page is no longer true. Run all checks against a live body:

```sh
node --conditions=minebot-sdk:source scripts/wiki-check.ts --bot <name>
```

Run the checks after you change `MC_VERSION` or upgrade Mineflayer. Then set `mc_version` on the pages that pass, and fix or remove the pages that fail.

## Promote a lesson

1. Read the lesson and confirm it in game.
2. Move the file into the right section and give it a stable name.
3. Replace `author` and `created` with `mc_version` and `verified_by`. Add a check if you can.
