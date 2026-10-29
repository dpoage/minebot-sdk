// The stack a dropped item entity holds, read safely. Mineflayer names the entity on the spawn packet and
// the stack arrives with the later `entity_metadata` packet, so a read before that throws; the observation
// and the items routines both read through this, so both see the same stack at the same moment.
import type { Entity } from "prismarine-entity";

/** The stack a dropped item entity holds, or null while its metadata has not arrived. */
export function droppedStack(entity: Entity): { name: string; count: number } | null {
  if (entity.name !== "item") return null;
  try {
    const stack = entity.getDroppedItem();
    return stack ? { name: stack.name, count: stack.count } : null;
  } catch {
    return null;
  }
}
