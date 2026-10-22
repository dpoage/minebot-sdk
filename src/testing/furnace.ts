// Furnaces: the state a furnace block holds between visits, and the window Mineflayer's
// `openFurnace` hands out. Smelting runs on the harness clock, so a routine that waits (`sleep`)
// sees the output appear after the real 10 s per item, with real fuel burn times.
import { EventEmitter } from "node:events";
import type { Item } from "prismarine-item";
import { burnTicks, SMELT_TICKS, smeltOutput } from "../mc/smelting.ts";
import type { Inventory } from "./inventory.ts";
import { strict } from "./strict.ts";

/** What one furnace block holds. Item stacks are `name` and `count`; the window turns them into items. */
export interface FurnaceState {
  input: { name: string; count: number } | null;
  fuel: { name: string; count: number } | null;
  output: { name: string; count: number } | null;
  /** Ticks of burning left of the fuel item in use. */
  burnLeft: number;
  /** Ticks the fuel item in use burns in all, as the server's total-fuel property reports it; 0 before anything burned. */
  totalBurn: number;
  /** Ticks the current input has cooked. */
  cooked: number;
  /** Windows open on this furnace, each with how it announces a changed property: the harness calls it each time the clock passes with the furnace burning, as the server's progress packets arrive. */
  windows: Map<number, () => void>;
}

export function emptyFurnace(): FurnaceState {
  return { input: null, fuel: null, output: null, burnLeft: 0, totalBurn: 0, cooked: 0, windows: new Map() };
}

/** Advances one furnace by one tick, as the server does. Returns whether it is lit afterwards. */
export function tickFurnace(state: FurnaceState, stackSize: (name: string) => number): boolean {
  const result = state.input ? smeltOutput(state.input.name) : undefined;
  const room = result !== undefined && (!state.output || (state.output.name === result && state.output.count < stackSize(result)));
  if (state.burnLeft === 0 && state.fuel && result !== undefined && room) {
    state.burnLeft = burnTicks(state.fuel.name);
    state.totalBurn = state.burnLeft;
    state.fuel.count -= 1;
    if (state.fuel.count === 0) state.fuel = null;
  }
  if (state.burnLeft > 0) {
    state.burnLeft -= 1;
    if (result !== undefined && room) {
      state.cooked += 1;
      if (state.cooked >= SMELT_TICKS) {
        state.cooked = 0;
        state.input!.count -= 1;
        if (state.input!.count === 0) state.input = null;
        state.output = { name: result, count: (state.output?.count ?? 0) + 1 };
      }
    } else state.cooked = Math.max(0, state.cooked - 2);
  } else state.cooked = Math.max(0, state.cooked - 2);
  return state.burnLeft > 0;
}

export interface FurnaceWindowDeps {
  id: number;
  state: FurnaceState;
  inventory: Inventory;
  makeItem: (name: string, count: number) => Item;
  stackSize: (name: string) => number;
  itemName: (type: number) => string;
  /** Called when the window closes. */
  onClose: () => void;
}

/** The furnace window Mineflayer's `openFurnace` resolves with, over a furnace's state and the player's inventory. */
export function furnaceWindow(deps: FurnaceWindowDeps) {
  const { state, inventory } = deps;
  const emitter = new EventEmitter();
  const stack = (slot: { name: string; count: number } | null, index: number): Item | null => {
    if (!slot) return null;
    const item = deps.makeItem(slot.name, slot.count);
    item.slot = index;
    return item;
  };
  /** Moves `count` of item `type` from the player's inventory into a furnace slot, which holds one kind of item. */
  const load = (slot: "input" | "fuel", type: number, count: number) => {
    const name = deps.itemName(type);
    if (slot === "input" && smeltOutput(name) === undefined) throw new Error(`${name} cannot be smelted`);
    if (slot === "fuel" && burnTicks(name) === 0) throw new Error(`${name} is not a furnace fuel`);
    const held = state[slot];
    if (held && held.name !== name) throw new Error(`the furnace ${slot} slot holds ${held.name}, not ${name}`);
    if ((held?.count ?? 0) + count > deps.stackSize(name)) throw new Error(`the furnace ${slot} slot cannot hold ${(held?.count ?? 0) + count} ${name}`);
    if (inventory.count(type) < count) throw new Error(`the inventory holds ${inventory.count(type)} ${name}, not ${count}`);
    inventory.remove(type, count);
    state[slot] = { name, count: (held?.count ?? 0) + count };
  };
  /** Moves a furnace slot's items to the inventory; what does not fit stays in the slot. */
  const take = (slot: "input" | "fuel" | "output") => {
    const held = state[slot];
    if (!held) return null;
    const type = inventory.make(held.name, 1).type;
    const left = inventory.add(type, held.count);
    state[slot] = left > 0 ? { name: held.name, count: left } : null;
    return stack({ name: held.name, count: held.count - left }, 0);
  };
  const window = {
    id: deps.id,
    type: "minecraft:furnace",
    title: "Furnace",
    inventoryStart: 3,
    inventoryEnd: 39,
    /** The window's slots: input, fuel, output, then the player's grid and hotbar. */
    get slots(): (Item | null)[] {
      return [stack(state.input, 0), stack(state.fuel, 1), stack(state.output, 2), ...inventory.slots.slice(9, 45)];
    },
    inputItem: () => stack(state.input, 0),
    fuelItem: () => stack(state.fuel, 1),
    outputItem: () => stack(state.output, 2),
    /** Fuel left as a fraction of the fuel item burning, and in seconds, like Mineflayer's window. */
    get fuel(): number {
      return state.totalBurn > 0 ? state.burnLeft / state.totalBurn : 0;
    },
    get fuelSeconds(): number {
      return state.burnLeft / 20;
    },
    get totalFuel(): number | null {
      return state.totalBurn > 0 ? state.totalBurn : null;
    },
    get totalFuelSeconds(): number {
      return state.totalBurn / 20;
    },
    get progress(): number {
      return state.cooked / SMELT_TICKS;
    },
    /** Seconds the current input still needs, as Mineflayer computes it. */
    get progressSeconds(): number {
      return (SMELT_TICKS - state.cooked) / 20;
    },
    totalProgress: SMELT_TICKS,
    totalProgressSeconds: SMELT_TICKS / 20,
    selectedItem: null,
    putInput: async (type: number, _metadata: number | null, count: number) => load("input", type, count),
    putFuel: async (type: number, _metadata: number | null, count: number) => load("fuel", type, count),
    takeInput: async () => take("input"),
    takeFuel: async () => take("fuel"),
    takeOutput: async () => take("output"),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
    close: () => {
      state.windows.delete(deps.id);
      emitter.emit("close");
      deps.onClose();
    },
  };
  state.windows.set(deps.id, () => emitter.emit("update"));
  return strict("furnace window", window);
}
