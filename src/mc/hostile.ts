// Which creatures count as hostile. One predicate serves the `hostile_near` event and the survival and
// combat routines, so they never disagree about what a threat is.

/** Registry category of creatures that attack on sight. The registry `type` is not enough: phantoms, slimes, magma cubes, ghasts, and shulkers have type `mob`. */
const HOSTILE_KIND = "Hostile mobs";

/** Creatures in that category that do not attack on sight, or are not creatures that move: not a threat until provoked. */
const NOT_ALWAYS_HOSTILE: Record<string, true> = { enderman: true, zombified_piglin: true, strider: true, end_crystal: true };

/** True for a creature that attacks on sight, as the registry's category and name tell. */
export function isHostile(entity: { kind?: string; name?: string }): boolean {
  return entity.kind === HOSTILE_KIND && !NOT_ALWAYS_HOSTILE[entity.name ?? ""];
}
