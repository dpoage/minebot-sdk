// The Mineflayer connection: one player's lifecycle — join, reconnect with a growing wait,
// click pacing, translating bot events into the body's event log, and halting in-flight actions.
import { setTimeout as delay } from "node:timers/promises";
import mineflayer, { type Bot } from "mineflayer";
import { recordDeath, trackDeaths, type Senses } from "../mc/deaths.ts";
import { round, vec } from "../mc/position.ts";
import { MC_VERSION } from "../mc/version.ts";
import { NOT_CONNECTED_MESSAGE, type EventSink } from "../protocol/host.ts";
import { installPathfinder } from "./pathfinding.ts";
import { watchGame } from "./watch.ts";

const RECONNECT_DELAY_MS = 5_000;
/** Reconnect delays double after each failed attempt up to this cap, so a server that is down for hours is not hammered. */
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
/** A session shorter than this does not reset the reconnect delay: a server that kicks the body right after it joins must not be hammered. */
const STABLE_SESSION_MS = 60_000;
/**
 * Pause after each window click. Mineflayer 4.39 sends clicks without waiting for the server and keeps one
 * global container stateId. On 26.1 the server answers stale clicks with full resyncs that land between
 * later predicted clicks and corrupt the client's model of the inventory and cursor; crafting then loses
 * or duplicates items. Two server ticks per click lets each resync arrive before the next click.
 * Upstream: PrismarineJS/mineflayer#4072, #4103.
 */
const CLICK_PACE_MS = 100;

/**
 * The tick the sun finishes setting: the first tick of night (beds work from here). `bot.time.isDay`
 * flips only at 13000, but the world is already dark at 12542, so the day and night events use this.
 */
const NIGHT_START_TICK = 12542;

/** The parts of a bot the day/night tracker reads: its clock, and the `time` event of each time packet. */
interface PhaseSource {
  time: { timeOfDay: number };
  on(event: "time", listener: () => void): unknown;
}

/**
 * Announces the phase a connection joins in on its first time packet, then only each transition:
 * `wasNight` starts unknown, so the first packet always pushes `day` or `night`. A later reconnect
 * starts unknown again and announces its phase too.
 */
export function announceDayNight(bot: PhaseSource, events: EventSink): void {
  let wasNight: boolean | undefined;
  bot.on("time", () => {
    const night = bot.time.timeOfDay >= NIGHT_START_TICK;
    if (night === wasNight) return;
    wasNight = night;
    if (night) events.push("night", { timeOfDay: bot.time.timeOfDay });
    else events.push("day", { timeOfDay: bot.time.timeOfDay });
  });
}

export class NotConnectedError extends Error {
  constructor() {
    super(NOT_CONNECTED_MESSAGE);
  }
}

/** `offline` joins servers in offline mode; `microsoft` signs in to the account for online-mode servers. */
export type ServerAuth = "offline" | "microsoft";

export interface ConnectionOptions {
  /** The player name offline; with `microsoft`, the key of the token cache (the in-game name is the account's). */
  username: string;
  auth: ServerAuth;
  /** Where Microsoft sign-in tokens are cached between connections and restarts. */
  authCacheDir: string;
  host: string;
  port: number;
  events: EventSink;
  /** Deaths and reconnects the previous host counted, when this connection replaces one. */
  deaths?: number;
  reconnects?: number;
}

export class Connection {
  readonly #options: ConnectionOptions;
  #bot: Bot | null = null;
  #spawned = false;
  #closing = false;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempts = 0;
  #reconnects = 0;
  #deaths = 0;
  #lastDisconnect: string | undefined;
  /** What the host session has sensed of its player: carried into the next connection's tracker. */
  #senses: Senses = {};

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#deaths = options.deaths ?? 0;
    this.#reconnects = options.reconnects ?? 0;
  }

  get bot(): Bot | null {
    return this.#bot;
  }

  get spawned(): boolean {
    return this.#spawned;
  }

  get deaths(): number {
    return this.#deaths;
  }

  get reconnects(): number {
    return this.#reconnects;
  }

  get lastDisconnect(): string | undefined {
    return this.#lastDisconnect;
  }

  get reconnecting(): boolean {
    return !this.#closing;
  }

  /** The live bot, or an error naming the problem. */
  requireBot(): Bot {
    if (!this.#bot || !this.#spawned) throw new NotConnectedError();
    return this.#bot;
  }

  start(): void {
    this.#closing = false;
    this.#connect();
  }

  close(): void {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#bot?.quit("body shutting down");
  }

  /**
   * Stops every action a program may have left in flight. Clearing the goal stops pathfinding at
   * once; `pathfinder.stop()` would instead set a flag that, on an idle bot, cancels the next path.
   */
  halt(): void {
    const bot = this.#bot;
    if (!bot) return;
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    if (bot.targetDigBlock) bot.stopDigging();
    bot.deactivateItem();
  }

  #connect(): void {
    const { username, auth, authCacheDir, host, port, events } = this.#options;
    const bot = mineflayer.createBot({
      username,
      host,
      port,
      version: MC_VERSION,
      auth,
      ...(auth === "microsoft" && {
        profilesFolder: authCacheDir,
        // The operator, not the agent, signs in: the code goes to the body's terminal.
        onMsaCode: ({ verification_uri, user_code }: { verification_uri: string; user_code: string }) =>
          console.error(`[minebot] Microsoft sign-in: open ${verification_uri} and enter code ${user_code}`),
      }),
    });
    this.#bot = bot;
    installPathfinder(bot);
    watchGame(bot, events);
    this.#senses = trackDeaths(bot, this.#senses);
    // Plugins (including the inventory plugin that defines clickWindow) load after createBot returns.
    bot.once("login", () => {
      const click = bot.clickWindow.bind(bot);
      bot.clickWindow = async (slot, mouseButton, mode) => {
        await click(slot, mouseButton, mode);
        await delay(CLICK_PACE_MS);
      };
    });

    let spawnedAt: number | undefined;
    bot.once("spawn", () => {
      this.#spawned = true;
      spawnedAt = Date.now();
      events.push("connected", { username: bot.username, host, port });
    });
    bot.on("spawn", () => events.push("spawn", { position: vec(bot.entity.position) }));
    // The server reset the spawn point to the world spawn; the tracker reports null from here.
    bot.on("spawnReset", () => events.push("spawn_reset", {}));
    bot.on("death", () => {
      this.#deaths++;
      // The tracker holds the server's death message and the inventory as it was when that arrived.
      events.push("death", recordDeath(bot));
    });

    let lastHealth = 20;
    bot.on("health", () => {
      if (bot.health < lastHealth) events.push("hurt", { health: round(bot.health), food: bot.food });
      lastHealth = bot.health;
    });

    // The first time packet after a join announces the phase the body joined in; later ones only a transition.
    announceDayNight(bot, events);
    bot.on("chat", (from, message) => {
      if (from !== bot.username) events.push("chat", { from, message });
    });
    bot.on("whisper", (from, message) => events.push("whisper", { from, message }));
    bot.on("messagestr", (message, position) => {
      if (position === "system" || position === "game_info") events.push("system", { message });
    });
    bot.on("playerJoined", (p) => events.push("player_joined", { username: p.username }));
    bot.on("playerLeft", (p) => events.push("player_left", { username: p.username }));
    bot.on("kicked", (reason) => {
      // Typed as string, but 1.20.3+ servers send an NBT text component such as { type: "string", value }.
      const raw: unknown = reason;
      const text =
        typeof raw === "object" && raw !== null && "value" in raw && typeof raw.value === "string"
          ? raw.value
          : typeof raw === "string"
            ? raw
            : JSON.stringify(raw);
      this.#lastDisconnect = `kicked: ${text}`;
      events.push("kicked", { reason: this.#lastDisconnect });
    });
    bot.on("error", (err) => events.push("error", { message: err.message }));
    bot.on("end", (reason) => {
      this.#spawned = false;
      this.#lastDisconnect ??= reason;
      events.push("disconnected", { reason });
      if (this.#closing) return;
      if (spawnedAt !== undefined && Date.now() - spawnedAt >= STABLE_SESSION_MS) this.#reconnectAttempts = 0;
      const wait = Math.min(RECONNECT_DELAY_MS * 2 ** this.#reconnectAttempts, MAX_RECONNECT_DELAY_MS);
      this.#reconnectAttempts++;
      events.push("reconnect_scheduled", { inMs: wait, attempt: this.#reconnectAttempts });
      this.#reconnectTimer = setTimeout(() => {
        this.#lastDisconnect = undefined;
        this.#reconnects++;
        this.#connect();
      }, wait);
    });
  }
}
