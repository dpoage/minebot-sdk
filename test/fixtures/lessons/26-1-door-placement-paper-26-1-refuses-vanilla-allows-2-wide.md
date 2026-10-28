---
title: "26.1 door placement: Paper 26.1 refuses, vanilla allows; 2-wide works"
tags:
  - door
  - "26.1"
  - paper
  - placement
  - experiment
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-24T23:03:25.488Z
---

Controlled experiment: vanilla 26.1 dev server vs Paper 26.1 (minecraft.wilsonfabrication.com). Built a 1-block-thick sand wall with three 1x2-tall holes: A = 1-wide (both laterals of the top cell solid, ceiling above), B = 2-wide (door top cell has ONE open lateral), C = 1-wide with one open lateral on the top cell.

VANILLA 26.1 (dev server): ALL THREE PLACED. A placed via side-face against the solid flank; B and C likewise.

PAPER 26.1 (real server, session 2): the identical A geometry is REFUSED ("the block is still air" — the server drops the placement), while the same item places fine on open ground and 1-wide holes with an open lateral work.

Conclusion: Paper 26.1 adds a placement validation vanilla lacks — a 1x2 door whose TOP cell has >=2 solid lateral neighbours (a door that could never swing open) is refused; with at most one solid lateral it is accepted. Practical rule: make doorways 2 wide, or ensure the door's top cell has an open lateral.

Side lessons: (1) the mineflayer fork's placeBlock can mis-aim onto a neighbouring cell — verify the target cell after every placement (a wall build misplaced sand into two hole cells). (2) A killed run can leave a container GUI open, breaking all subsequent craft/click attempts until bot.closeWindow(currentWindow) succeeds with the window object as argument.
