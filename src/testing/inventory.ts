// The player's inventory with Mineflayer's slot layout: armor at 5-8, the main grid at 9-35, the
// hotbar at 36-44, the off hand at 45. Routines read `slots`, `items()`, and the held item.
import type { Item } from "prismarine-item";
import type { ItemClass, Registry } from "./universe.ts";

export const ARMOR_SLOTS: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
export const OFF_HAND_SLOT = 45;
const INVENTORY_START = 9;
const INVENTORY_END = 45;
const HOTBAR_START = 36;

export class Inventory {
  readonly slots: (Item | null)[] = new Array<Item | null>(46).fill(null);
  readonly inventoryStart = INVENTORY_START;
  readonly inventoryEnd = INVENTORY_END;
  readonly hotbarStart = HOTBAR_START;
  quickBarSlot = 0;
  readonly id = 0;
  readonly type = "minecraft:inventory";
  /** The item on the mouse cursor; the harness never clicks, so nothing is ever there. */
  readonly selectedItem: Item | null = null;
  readonly #Item: ItemClass;
  readonly #registry: Registry;

  constructor(ItemClass: ItemClass, registry: Registry) {
    this.#Item = ItemClass;
    this.#registry = registry;
  }

  /** The stacks in the main grid and the hotbar: what Mineflayer calls the inventory's items. */
  items(): Item[] {
    return this.slots.slice(INVENTORY_START, INVENTORY_END).filter((item): item is Item => item !== null);
  }

  /** How many of item type `type` the grid and hotbar hold. */
  count(type: number): number {
    return this.items().reduce((n, item) => (item.type === type ? n + item.count : n), 0);
  }

  /** How many slots of the grid and hotbar are empty. */
  emptySlotCount(): number {
    return INVENTORY_END - INVENTORY_START - this.items().length;
  }

  /** The item in the hand: the selected hotbar slot. */
  get held(): Item | null {
    return this.slots[HOTBAR_START + this.quickBarSlot] ?? null;
  }

  /** Creates an item stack of `name`, which must exist in the registry. */
  make(name: string, count: number): Item {
    const def = this.#registry.itemsByName[name.replace(/^minecraft:/, "")];
    if (!def) throw new Error(`unknown item "${name}"`);
    return new this.#Item(def.id, count);
  }

  set(slot: number, item: Item | null): void {
    if (item) item.slot = slot;
    this.slots[slot] = item;
  }

  /** Slots in the order a pickup fills them: the hotbar, then the main grid. */
  #fillOrder(): number[] {
    const order: number[] = [];
    for (let slot = HOTBAR_START; slot < INVENTORY_END; slot++) order.push(slot);
    for (let slot = INVENTORY_START; slot < HOTBAR_START; slot++) order.push(slot);
    return order;
  }

  /** Adds `count` of item `type`, topping up partial stacks first. Returns how many did not fit. */
  add(type: number, count: number): number {
    const def = this.#registry.items[type];
    if (!def) throw new Error(`unknown item id ${type}`);
    let left = count;
    for (const slot of this.#fillOrder()) {
      const stack = this.slots[slot];
      if (!stack || stack.type !== type || stack.count >= def.stackSize) continue;
      const moved = Math.min(left, def.stackSize - stack.count);
      stack.count += moved;
      left -= moved;
      if (left === 0) return 0;
    }
    for (const slot of this.#fillOrder()) {
      if (this.slots[slot]) continue;
      const moved = Math.min(left, def.stackSize);
      this.set(slot, new this.#Item(type, moved));
      left -= moved;
      if (left === 0) return 0;
    }
    return left;
  }

  /** Removes up to `count` of item `type`, smallest stacks first. Returns how many were removed. */
  remove(type: number, count: number): number {
    let left = count;
    const stacks = this.slots
      .map((item, slot) => ({ item, slot }))
      .filter((entry): entry is { item: Item; slot: number } => entry.item !== null && entry.item.type === type && entry.slot >= INVENTORY_START && entry.slot < INVENTORY_END)
      .sort((a, b) => a.item.count - b.item.count);
    for (const { item, slot } of stacks) {
      const taken = Math.min(left, item.count);
      item.count -= taken;
      left -= taken;
      if (item.count === 0) this.slots[slot] = null;
      if (left === 0) break;
    }
    return count - left;
  }

  /** Totals by item name, as routines report them. */
  totals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const item of this.items()) totals[item.name] = (totals[item.name] ?? 0) + item.count;
    return totals;
  }

  /** Where `equip` puts an item: the slot a destination names. */
  destSlot(destination: string): number {
    if (destination === "hand") return HOTBAR_START + this.quickBarSlot;
    if (destination === "off-hand") return OFF_HAND_SLOT;
    const armor = ARMOR_SLOTS[destination];
    if (armor === undefined) throw new Error(`invalid destination ${destination}`);
    return armor;
  }

  /** Moves `item` to `destination`, swapping whatever is there back to where `item` was. */
  equip(item: Item, destination: string): void {
    const source = this.slots.findIndex((slot) => slot === item);
    if (source < 0) throw new Error("the item is not in the inventory");
    if (destination === "hand" && source >= HOTBAR_START && source < INVENTORY_END) {
      this.quickBarSlot = source - HOTBAR_START;
      return;
    }
    const dest = this.destSlot(destination);
    if (source === dest) return;
    const displaced = this.slots[dest] ?? null;
    this.slots[source] = null;
    this.set(dest, item);
    if (displaced) this.set(source, displaced);
  }
}
