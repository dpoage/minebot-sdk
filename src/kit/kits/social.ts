// The social kit: talk to, wait for, follow, and hand items to other players — built from
// the move, sense, and inventory primitives, with the pathfinder's follow goal for tagging along.
import { action, defineKit, type Entity, goals, type KitContext, Point, z } from "minebot-sdk/kit";

const USES = ["move", "sense", "inventory"] as const;

function playerEntity(ctx: KitContext, username: string): Entity {
  const entity = ctx.bot.players[username]?.entity;
  if (!entity) throw new Error(`player "${username}" is not in view`);
  return entity;
}

export interface ChatMessage {
  from: string;
  message: string;
}

/** Resolves with the next chat message from another player that matches the filters. */
export async function waitForChat(
  ctx: KitContext,
  options: { from?: string; match?: string; timeoutMs?: number } = {},
): Promise<ChatMessage> {
  const pattern = options.match ? new RegExp(options.match, "i") : null;
  const received = Promise.withResolvers<ChatMessage>();
  ctx.on("chat", (...args: unknown[]) => {
    const [from, message] = args;
    if (typeof from !== "string" || typeof message !== "string" || from === ctx.bot.username) return;
    if (options.from && from !== options.from) return;
    if (pattern && !pattern.test(message)) return;
    received.resolve({ from, message });
  });
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => received.reject(new Error(`no matching chat message within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => received.reject(ctx.signal.reason);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await received.promise;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export const social = defineKit(
  { name: "social", description: "Talk to, wait for, follow, and hand items to other players.", uses: USES },
  {
    say: action({
      doc: "Send a public chat `message`. Other players and agents read chat.",
      args: z.object({ message: z.string().min(1).max(256) }),
      returns: z.void(),
      run: (ctx, { message }) => ctx.bot.chat(message),
    }),
    waitForChat: action({
      doc: "Wait for the next chat message from another player. `from` (username), `match` (regex, case-insensitive), `timeoutMs` (default 60000).",
      args: z.object({
        from: z.string().optional(),
        match: z.string().optional(),
        timeoutMs: z.number().int().positive().default(60_000),
      }),
      returns: z.object({ from: z.string(), message: z.string() }),
      run: (ctx, options) => waitForChat(ctx, options),
    }),
    players: action({
      doc: "Other online players: [{ username, distance, position }] (distance and position are null when out of view).",
      args: z.object({}),
      returns: z.array(z.object({ username: z.string(), distance: z.number().nullable(), position: Point.nullable() })),
      run: (ctx) =>
        Object.values(ctx.bot.players)
          .filter((p) => p.username !== ctx.bot.username)
          .map((p) => ({
            username: p.username,
            distance: p.entity ? Math.round(p.entity.position.distanceTo(ctx.bot.entity.position)) : null,
            position: p.entity ? p.entity.position.floored() : null,
          })),
    }),
    follow: action({
      doc: "Follow a `player` for `durationMs` (default 30000), staying within `distance` (default 2) blocks.",
      args: z.object({
        player: z.string().min(1),
        distance: z.number().positive().default(2),
        durationMs: z.number().int().positive().default(30_000),
      }),
      returns: z.void(),
      run: async (ctx, { player, distance, durationMs }) => {
        ctx.bot.pathfinder.setGoal(new goals.GoalFollow(playerEntity(ctx, player), distance), true);
        try {
          await ctx.sleep(durationMs);
        } finally {
          ctx.bot.pathfinder.setGoal(null);
        }
      },
    }),
    give: action({
      doc: "Walk to a `player` and toss them `count` (default 1) of `item`.",
      args: z.object({ player: z.string().min(1), item: z.string().min(1), count: z.number().int().positive().default(1) }),
      returns: z.void(),
      run: async (ctx, { player, item, count }) => {
        const target = playerEntity(ctx, player);
        await ctx.kits.move.to({ position: target.position.floored(), range: 1, timeoutMs: 30_000 });
        // A tossed stack flies about two blocks; aim low so it lands at the recipient's feet.
        await ctx.bot.lookAt(playerEntity(ctx, player).position.offset(0, 0.2, 0), true);
        await ctx.kits.inventory.toss({ item, count });
      },
    }),
  },
);
