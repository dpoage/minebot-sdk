// "Did you mean": when an agent's code uses a bot member that does not exist, name the real one.
//
// Agents (Qwen-class) hallucinate Mineflayer members from other bot libraries and from Array/Map habits:
// `bot.selectItem(item)`, `bot.entities.values()`, `bot.inventory.items.filter(...)`. The corpus of real runs
// has eleven such paths; the curated table answers each with the instruction that works. A live bot adds two
// things the table cannot: it checks that the named member exists on THAT bot before the line is shown, and it
// supplies the real member names for an edit-distance answer on a path nobody curated.
//
// Two consumers: the runner's `explain` hook (explainError, runtime TypeErrors) and the type-check refusal
// (suggestBotMember, a path rebuilt from the syntax tree). Neither may ever throw or invent a suggestion for
// code that is not about a bot member.

/** A row of the curated table: the line to show, and the real members it names (each must exist on the bot). */
interface CuratedRow {
  readonly line: string;
  readonly needs: readonly string[];
}

const ENTITIES_LINE = "bot.entities is a plain object keyed by entity id, not a Map or an array";

const CURATED: Record<string, CuratedRow> = {
  setYaw: { line: "bot.setYaw does not exist: use bot.look(yaw, pitch)", needs: ["look"] },
  isSneaking: { line: 'bot.isSneaking does not exist: use bot.getControlState("sneak")', needs: ["getControlState"] },
  getSkyLight: { line: "bot.getSkyLight does not exist: use bot.blockAt(pos).skyLight", needs: ["blockAt"] },
  daylight: {
    line: "bot.daylight does not exist: use bot.time.timeOfDay (ticks of the day) or bot.time.isDay",
    needs: ["time.timeOfDay", "time.isDay"],
  },
  selectItem: { line: 'bot.selectItem does not exist: use bot.equip(item, "hand")', needs: ["equip"] },
  isRaining: { line: "bot.isRaining is a boolean, not a function: read bot.isRaining", needs: ["isRaining"] },
  "entities.values": {
    line: `bot.entities.values does not exist (${ENTITIES_LINE}): use Object.values(bot.entities)`,
    needs: ["entities"],
  },
  "entities.filter": {
    line: `bot.entities.filter does not exist (${ENTITIES_LINE}): use Object.values(bot.entities).filter(...)`,
    needs: ["entities"],
  },
  "inventory.items.filter": {
    line: "bot.inventory.items.filter does not exist (bot.inventory.items is a method): use bot.inventory.items().filter(...)",
    needs: ["inventory.items"],
  },
  "inventory.findItem": {
    line: "bot.inventory.findItem does not exist: use bot.inventory.items().find(...)",
    needs: ["inventory.items"],
  },
  "inventory.findInventorySlot": {
    line: "bot.inventory.findInventorySlot does not exist: use bot.inventory.items().find(...)",
    needs: ["inventory.items"],
  },
};

const PATH = /^[\w$]+(?:\.[\w$]+)*$/;

/**
 * The message V8 writes for a call on a non-function: the source text of the callee, then the verdict. The
 * receiver is `bot`, `ctx.bot`, or a destructured alias that ends in `bot` (`myBot`): any other callee
 * (`g.on`, `hits.map`, `ctx.notes.get(...).catch`) is not about a bot member and never matches. The optional
 * `TypeError: ` is how the run record prints the same message, so a copy of it matches too.
 */
const NOT_A_FUNCTION =
  /^(?:\w*Error: )?(?:ctx\.)?[\w$]*[bB]ot\.([\w$]+(?:\.[\w$]+)*) is not a function(?: or its return value is not iterable)?$/;

/** Longer than any V8 callee message; a longer text is some other error's prose. */
const MAX_MESSAGE = 300;

/** What `root.<path>` is on this object: undefined when any segment is missing or the walk leaves the objects. */
function walk(root: object, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Every own and inherited member name of an object, stopping before Object.prototype. */
function memberNames(target: object): string[] {
  const names = new Set<string>();
  for (let at: object | null = target; at !== null && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
    for (const name of Object.getOwnPropertyNames(at)) names.add(name);
  }
  return [...names].sort();
}

/** Optimal-string-alignment distance: insert, delete, substitute, or swap two neighbours, each one edit. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** The real member nearest to `wrong` among the members of `parent`, or undefined when none is close. */
function nearestMember(parent: object, wrong: string): string | undefined {
  // A typo's reach: no edits for short names (every short name is near another), one for 4-5 letters, else two.
  const allowed = wrong.length <= 3 ? 0 : wrong.length <= 5 ? 1 : 2;
  let best: { name: string; distance: number } | undefined;
  for (const name of memberNames(parent)) {
    if (name.startsWith("_") || name.startsWith("$")) continue;
    const distance = name.toLowerCase() === wrong.toLowerCase() ? 0 : editDistance(name, wrong);
    if (distance <= allowed && (best === undefined || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function kindOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/**
 * One instruction line for a nonexistent bot member, or undefined when there is nothing true to say.
 *
 * `path` is the dotted member path after `bot.` (`selectItem`, `entities.values`). Without `bot`, only the
 * curated table answers. With `bot`: a path that is a real function answers nothing (nothing is missing); a
 * curated answer is returned only when the members it names exist on that bot; a real non-function value
 * (`bot.username()`) is named as a value to read; and an uncurated missing path gets the nearest real member
 * of its parent object, when one is within a typo's distance. Never throws.
 */
export function suggestBotMember(path: string, bot?: object): string | undefined {
  try {
    if (typeof path !== "string" || !PATH.test(path)) return undefined;
    const row = Object.hasOwn(CURATED, path) ? CURATED[path] : undefined;
    if (bot === undefined || bot === null) return row?.line;

    const value = walk(bot, path);
    if (typeof value === "function") return undefined;
    if (row !== undefined && row.needs.every((member) => walk(bot, member) !== undefined)) return row.line;
    if (value !== undefined) return `bot.${path} is a ${kindOf(value)}, not a function: read bot.${path}`;

    const cut = path.lastIndexOf(".");
    const parentPath = cut < 0 ? undefined : path.slice(0, cut);
    const parent = parentPath === undefined ? bot : walk(bot, parentPath);
    if (typeof parent !== "object" || parent === null) return undefined;
    const wrong = path.slice(cut + 1);
    const near = nearestMember(parent, wrong);
    if (near === undefined) return undefined;
    const real = parentPath === undefined ? near : `${parentPath}.${near}`;
    const member = (parent as Record<string, unknown>)[near];
    return typeof member === "function"
      ? `bot.${path} does not exist: the nearest real member is bot.${real}(...)`
      : `bot.${path} does not exist: the nearest real member is bot.${real}, a ${kindOf(member)} to read, not call`;
  } catch {
    return undefined;
  }
}

/**
 * The runner's `explain` hook: an instruction for a run that died calling a bot member that is not a function
 * (`bot.selectItem is not a function`). Matches only that V8 runtime message on an Error rooted at `bot`,
 * `ctx.bot`, or a destructured `…bot` alias; everything else (other TypeErrors, thrown strings, null, a
 * refusal text) is undefined. Never throws, whatever the error's getters do.
 */
export function explainError(err: unknown, bot?: object): string | undefined {
  try {
    if (!(err instanceof Error)) return undefined;
    const message: unknown = err.message;
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return undefined;
    const path = NOT_A_FUNCTION.exec(message.split("\n", 1)[0]!)?.[1];
    return path === undefined ? undefined : suggestBotMember(path, bot);
  } catch {
    return undefined;
  }
}
