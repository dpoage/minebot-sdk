// What the body knows of its own deaths and its spawn point: the server's death message and the
// inventory at that moment, the most recent death of this host session, and the respawn point the
// server confirmed. Shaped like effects.ts: one tracker per bot, read by the observation.
import type { Bot } from "mineflayer";
import type { DeathSummary, Vec } from "../protocol/index.ts";
import { vec } from "./position.ts";

/** What the player carried when the server's death message arrived. */
export interface DroppedItem {
  name: string;
  count: number;
}

/** What the server said of a death as it happened: `death_combat_event` and the inventory then. */
export interface DeathDetail {
  /** The message, e.g. "Fartmastery drowned". */
  cause?: string;
  /** The items the player carried; absent when it carried none. */
  dropped?: DroppedItem[];
}

/** What the body senses about its player's deaths and spawn point. */
export interface Senses {
  /** The most recent death of this host session; absent until the player dies. */
  lastDeath?: DeathSummary;
  /**
   * The bed or respawn anchor the server confirmed as the spawn point; `null` once the server reset it
   * to the world spawn; absent while this host session has not heard either way.
   */
  spawnPoint?: Vec | null;
}

interface Tracker extends Senses {
  /** The message and inventory of a death whose Mineflayer `death` event has not arrived yet. */
  pending?: DeathDetail;
  /** The bed or respawn anchor the bot used last: the server's confirmation message names no position. */
  used?: Vec;
}

/** The NBT tags whose value is a number. */
const NUMBER_TAGS: Record<string, true> = { byte: true, short: true, int: true, long: true, float: true, double: true };

/** The confirmation the server sends a player whose respawn point it set. */
const SET_SPAWN_KEY = "block.minecraft.set_spawn";

const trackers = new WeakMap<object, Tracker>();

function trackerOf(bot: Bot): Tracker {
  let tracker = trackers.get(bot);
  if (!tracker) {
    tracker = {};
    trackers.set(bot, tracker);
  }
  return tracker;
}

/** What the body has sensed about `bot`; empty for a bot that is not tracked. */
export function sensesOf(bot: Bot): Senses {
  return trackerOf(bot);
}

/**
 * Starts recording what the server says about `bot`'s deaths and spawn point. Call once per bot,
 * before it joins. `carried` are the senses of the host session so far, which a reconnection keeps.
 * The returned object is the live state the observation of this bot reads.
 */
export function trackDeaths(bot: Bot, carried: Senses = {}): Senses {
  const tracker: Tracker = { ...carried };
  trackers.set(bot, tracker);
  const lang = bot.registry.language ?? {};

  // The server sends the death message just before the health update Mineflayer turns into `death`.
  bot._client.on("death_combat_event", (packet: { playerId?: unknown; message?: unknown }) => {
    if (packet?.playerId !== bot.entity?.id) return;
    const cause = componentText(componentOf(packet.message), lang).trim();
    const dropped = bot.inventory.items().map(({ name, count }): DroppedItem => ({ name, count }));
    tracker.pending = { ...(cause !== "" && { cause }), ...(dropped.length > 0 && { dropped }) };
  });

  // The server confirms a respawn point with a message; the position is the bed or anchor the bot used.
  bot.on("message", (message) => {
    if (isSpawnSet(message) && tracker.used) tracker.spawnPoint = tracker.used;
  });

  // The server reset the spawn point (the bed or anchor is gone): the player respawns at the world spawn.
  bot.on("spawnReset", () => {
    tracker.spawnPoint = null;
  });

  wrapUse(bot, tracker);
  return tracker;
}

/**
 * Records the death Mineflayer just reported, and gives the `death` event's data: where the player
 * died, the server's message for it, and what the player carried. Call from the bot's `death` listener.
 */
export function recordDeath(bot: Bot): { position: Vec; cause?: string; dropped?: DroppedItem[] } {
  const tracker = trackerOf(bot);
  const detail = tracker.pending;
  tracker.pending = undefined;
  const position = vec(bot.entity.position);
  tracker.lastDeath = { time: new Date().toISOString(), position, ...(detail?.cause !== undefined && { cause: detail.cause }) };
  return { position, ...detail };
}

/**
 * Remembers the bed or respawn anchor the bot uses: the server's confirmation message carries no
 * position, so the position has to come from the bot's own use.
 */
function wrapUse(bot: Bot, tracker: Tracker): void {
  const sleep = bot.sleep;
  if (typeof sleep === "function") {
    bot.sleep = (async (...args: Parameters<Bot["sleep"]>) => {
      const [bedBlock] = args;
      if (bedBlock) tracker.used = vec(bedBlock.position);
      return sleep.apply(bot, args);
    }) as Bot["sleep"];
  }
  const activate = bot.activateBlock;
  if (typeof activate === "function") {
    bot.activateBlock = (async (...args: Parameters<Bot["activateBlock"]>) => {
      const [block] = args;
      if (block?.name === "respawn_anchor") tracker.used = vec(block.position);
      return activate.apply(bot, args);
    }) as Bot["activateBlock"];
  }
}

/** True for Mineflayer's parsed "Respawn point set" system message. */
function isSpawnSet(message: unknown): boolean {
  if (typeof message !== "object" || message === null || !("json" in message)) return false;
  const json = message.json;
  return typeof json === "object" && json !== null && "translate" in json && json.translate === SET_SPAWN_KEY;
}

/** The component `raw` holds: an NBT tag from the packet, a JSON string, or a component already. */
function componentOf(raw: unknown): unknown {
  if (typeof raw !== "string") return nbtValue(raw);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : raw;
  } catch {
    return raw;
  }
}

/** An NBT tag as the chat JSON schema: compounds become objects, lists arrays, numbers numbers, strings their JSON component. */
function nbtValue(tag: unknown): unknown {
  if (Array.isArray(tag)) return tag.map(nbtValue);
  if (!isTag(tag)) {
    if (typeof tag !== "object" || tag === null) return tag;
    // A compound's fields, as a list of compounds carries them: convert each value.
    return Object.fromEntries(Object.entries(tag).map(([key, entry]) => [key, nbtValue(entry)]));
  }
  if (tag.type === "string") {
    // A string tag holds the component as JSON text.
    const text = String(tag.value);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (tag.type === "compound") {
    const value = tag.value;
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nbtValue(entry)]));
  }
  if (tag.type === "list") {
    const value = tag.value;
    const items: unknown = typeof value === "object" && value !== null && "value" in value ? value.value : [];
    return Array.isArray(items) ? items.map(nbtValue) : [];
  }
  if (NUMBER_TAGS[tag.type]) return Number(tag.value);
  return tag.value;
}

function isTag(value: unknown): value is { type: string; value?: unknown } {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/** A component as plain text, translating keys with the game's language table. */
function componentText(component: unknown, lang: Record<string, string>): string {
  if (typeof component === "string") return component;
  if (typeof component === "number") return String(component);
  if (Array.isArray(component)) return component.map((part) => componentText(part, lang)).join("");
  if (typeof component !== "object" || component === null) return "";
  let text = "";
  if ("text" in component && (typeof component.text === "string" || typeof component.text === "number")) text = String(component.text);
  else if ("" in component && (typeof component[""] === "string" || typeof component[""] === "number")) text = String(component[""]);
  else if ("translate" in component && typeof component.translate === "string") {
    const args = "with" in component && Array.isArray(component.with) ? component.with.map((arg) => componentText(arg, lang)) : [];
    const format = lang[component.translate];
    if (format !== undefined) {
      let next = 0;
      text = format.replace(/%(?:(\d+)\$)?s|%%/g, (match, index: string | undefined) => {
        if (match === "%%") return "%";
        return args[index === undefined ? next++ : Number(index) - 1] ?? "";
      });
    } else {
      // No translation for the key: the key itself, as the client shows an unknown key.
      text = component.translate;
    }
  } else if ("selector" in component && typeof component.selector === "string") text = component.selector;
  else if ("keybind" in component && typeof component.keybind === "string") text = component.keybind;
  if ("extra" in component && Array.isArray(component.extra)) text += component.extra.map((part) => componentText(part, lang)).join("");
  return text;
}
