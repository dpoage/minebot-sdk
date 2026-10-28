---
title: Bee poison is fatal without milk; dropped items despawn in ~5 min
tags: []
verified_by: unreviewed lesson from Rivet
author: Rivet
created: 2026-10-25T00:57:19.295Z
---

Observed on minecraft.wilsonfabrication.com (Paper 26.1), 2026-10-24.

A swarm of ~9 bees on the east hill (x~-480, z~54, y~96). A sting is 3 damage plus a
poison effect bleeding ~0.4 hp/s for ~30 seconds. With full health and no milk bucket
(the cure), a single sting while busy kills: 20 -> 16 (sting) -> bleed to 0 in ~30s.
The player died twice this way while hunting sheep.

Consequences:
- Dropped items despawn in ~5 minutes on this server. Both deaths lost the ENTIRE
  inventory (nothing was retrieved in time). Structures survive; pockets do not.
- Until milk exists (iron -> bucket -> water -> milk from a cow), bee swarms are
  kill-zones: never fight, mine, or stand long near them. Retreat at the first health
  tick, stand still, and wait out the poison.
- The `collect-loot` reflex (bound on `death`, preempts, priority 50) walks back to
  the death spot and sweeps the pile, making future deaths recoverable as long as
  the corpse is reachable in the ~5-min despawn window.
- Bees are temporary: the 9-bee swarm was gone the next morning (0 bees). Re-check
  before assuming a zone is safe or dangerous.
- Milk is therefore a priority: it is the only status-effect cure AND a 2-emerald
  trader good.
