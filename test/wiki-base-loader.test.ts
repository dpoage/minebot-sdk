// P4.4: a lessons directory written by this change loads in the base tree (e97ef83) too. Base's PageMeta has no
// `provenance` key; zod strips the unknown key, so the lesson loads, searches and reads as a plain lesson. This file is
// run against the base checkout (`git worktree add /tmp/cw1/base e97ef83`), where it imports the base loader.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Wiki } from "../src/wiki/wiki.ts";

/** A lesson file exactly as this tree writes one: base's frontmatter keys plus the provenance record. */
const NEW_FORMAT = `---
title: move.to loops on diagonals
tags:
  - move
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T17:36:39.037Z
provenance:
  sdk: 0.1.0
  modules:
    move: aaaaaaaaaaaa
---

Flatten the path first, with enough words.
`;

async function wikiOver(): Promise<{ wiki: Wiki; id: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "minebot-wiki-new-format-"));
  const root = path.join(base, "wiki");
  const lessons = path.join(base, "lessons");
  await mkdir(root);
  await mkdir(lessons);
  await writeFile(path.join(lessons, "move-to-loops.md"), NEW_FORMAT);
  return { wiki: Wiki.load(root, lessons), id: "lessons/move-to-loops" };
}

describe("a Wiki that predates lesson records", () => {
  it("loads a lessons directory holding a new-format lesson, and lists, searches and reads it", async () => {
    const { wiki, id } = await wikiOver();
    assert.equal(wiki.lessonCount, 1);
    assert.deepEqual(wiki.list("lessons").map((p) => [p.id, p.title]), [[id, "move.to loops on diagonals"]]);
    assert.deepEqual(wiki.search("diagonals").map((p) => p.id), [id]);
    assert.equal(wiki.read(id).body, "Flatten the path first, with enough words.");
  });
});
