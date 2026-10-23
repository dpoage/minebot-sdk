// Generates bench/tasks/ from the task catalog below: one Harbor task directory per task and tier.
//   node --conditions=minebot-sdk:source bench/gen-tasks.ts
// Edit this file, not the generated directories; the generator deletes and rewrites bench/tasks/.
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_MODULES } from "../src/routines/index.ts";
import { MC_VERSION } from "../src/mc/version.ts";
import type { CheckInput } from "./verify/checks.ts";
import { type MilestoneSpecInput, offlineUuid } from "./verify/milestones.ts";

const TASKS_DIR = path.join(import.meta.dirname, "tasks");
/** Seed of the dev world; it has several trees within 20 blocks of spawn. */
const SEED = "-1395321890861809374";
/** The agent's player: the body's username, the one name the server lets in, and the player that the grader snapshots and the verifier grades. */
const PLAYER = "agent";

type Milestones = NonNullable<MilestoneSpecInput["milestones"]>;
type Milestone = Milestones[number];

/** The programs of bench/oracle/progression.ts, by `target`. */
type OracleTarget = "logs" | "wooden_pickaxe" | "stone_pickaxe" | "iron_pickaxe" | "diamond_pickaxe" | "shelter" | "stock_chest" | "stash_chest" | "retrieve_logs" | "dawn";

/** One agent session of a task: its goal, its time, its reference solution, and what grades it. */
interface Stage {
  /** Directory name under steps/ in a task with several stages; unused in a task with one. */
  name: string;
  /** Markdown, shown to the agent as the goal. */
  goal: string;
  /** What the server's record is graded for, after the standard sentence about statistics. Default: nothing more. */
  grading?: string;
  agentTimeoutSec: number;
  /** A multi-step task stops when this step's reward is below it. */
  minReward?: number;
  /** The reward needs every milestone, not only the last (see `gradeTrial` in verify/checks.ts). */
  allRequired?: boolean;
  /** `target` passed to bench/oracle/progression.ts by the reference solution. */
  oracleTarget: OracleTarget;
  /** Shell lines that run after the reference program in solve.sh, given whether the tier offers built-ins. */
  oracleAfter?: (builtins: boolean) => string;
  milestones: Milestones;
  checks?: CheckInput[];
}

interface TaskSpec {
  name: string;
  description: string;
  keywords: string[];
  difficulty: string;
  /** Built-in modules that the kits and full tiers offer besides the tier's own; the modules they use come with them. */
  extraBuiltins?: string[];
  /** The instruction describes the notes. Only a task in which the notes matter says so. */
  notes?: boolean;
  /** One session per stage. A task with several stages is a multi-step Harbor task: a new agent session starts at each. */
  stages: Stage[];
}

/**
 * What the agent gets on top of the base body. The base body is Mineflayer plus notes, status (deaths and
 * reconnects), the event log with blocking waits, the one-line observation, and the routine library with its action and reflex bindings;
 * every tier has it, and every tier starts its body with the same flags except `--builtins` and `--wiki`. A tier differs by the built-in
 * routine modules its body offers and by the wiki: those are the tier features.
 */
interface Tier {
  name: string;
  /** Built-in modules the body is told to offer (`--builtins`); the modules they use are offered with them. Empty offers none. */
  builtins: string[];
  wiki: "off" | "read";
}

const TIERS: Tier[] = [
  { name: "raw", builtins: [], wiki: "off" },
  { name: "kits", builtins: ["gatherer", "crafter", "builder", "explorer", "social"], wiki: "off" },
  { name: "wiki", builtins: [], wiki: "read" },
  { name: "full", builtins: ["gatherer", "crafter", "builder", "explorer", "social"], wiki: "read" },
];

/** The built-in modules a tier names in a task: the tier's own, plus the task's extra modules. None in a tier without built-ins. */
const tierBuiltins = (task: TaskSpec, tier: Tier): string[] => (tier.builtins.length > 0 ? [...tier.builtins, ...(task.extraBuiltins ?? [])] : []);

/**
 * The built-in modules a body offers when it is started with `--builtins=<names>`: the named modules and, transitively, the modules they use,
 * in catalog order (the body's own closure over `uses`, which a live test compares with its /features).
 */
function offered(names: string[]): string[] {
  const byName = new Map(BUILTIN_MODULES.map((module) => [module.name, module]));
  const all = new Set<string>();
  const add = (name: string): void => {
    const module = byName.get(name);
    if (!module) throw new Error(`unknown built-in module "${name}"`);
    if (all.has(name)) return;
    all.add(name);
    module.uses.forEach(add);
  };
  names.forEach(add);
  return BUILTIN_MODULES.filter((module) => all.has(module.name)).map((module) => module.name);
}

// Items that come from the world are graded by "gathered" (blocks dug and items picked up, never counted twice);
// items that are made are graded by "crafted". See `grade` in src/milestones/milestones.ts.
const log = (n: number): Milestone => ({
  id: n === 1 ? "log" : `log_${n}`,
  description: n === 1 ? "Obtain a log" : `Obtain ${n} logs`,
  via: "gathered",
  obtained: ["*_log"],
  count: n,
});
const crafted = (id: string, description: string, obtained: string): Milestone => ({
  id,
  description,
  via: "crafted",
  obtained: [obtained],
  count: 1,
});
const woodenChain: Milestones = [
  log(1),
  crafted("planks", "Craft planks", "*_planks"),
  crafted("crafting_table", "Craft a crafting table", "crafting_table"),
  crafted("stick", "Craft sticks", "stick"),
  crafted("wooden_pickaxe", "Craft a wooden pickaxe", "wooden_pickaxe"),
];

const cobblestone = (n: number): Milestone => ({
  id: "cobblestone",
  description: `Obtain ${n === 3 ? "three" : n} cobblestone`,
  via: "gathered",
  obtained: ["cobblestone"],
  // Stone is dug, and it drops cobblestone.
  blocks: ["stone", "cobblestone"],
  count: n,
});

/** The iron pickaxe chain: iron-tools grades it, and diamond-night builds on it. */
const ironChain: Milestones = [
  ...woodenChain,
  cobblestone(3),
  crafted("stone_pickaxe", "Craft a stone pickaxe", "stone_pickaxe"),
  // Iron ore is dug, and it drops raw iron.
  { id: "raw_iron", description: "Obtain three raw iron", via: "gathered", obtained: ["raw_iron"], blocks: ["iron_ore", "deepslate_iron_ore"], count: 3 },
  crafted("furnace", "Craft a furnace", "furnace"),
  { id: "iron_ingot", description: "Smelt three iron ingots", via: "crafted", obtained: ["iron_ingot"], count: 3 },
  crafted("iron_pickaxe", "Craft an iron pickaxe", "iron_pickaxe"),
];

/** Nights that survive-nights asks for: night 1 starts about 11 minutes after the clock starts, and each day is 20 minutes of server time. */
const NIGHTS = 2;
/** Logs that the stash chest holds in two-sessions. */
const STASH_LOGS = 8;
/**
 * Distance in blocks at which the first session of two-sessions leaves the chest. The body loads the chunks within the server's
 * view distance (8 chunks, 128 blocks, plus the rest of the chunk at the edge: under 144), so a chest this far away is not in the
 * loaded world, and `findBlocks` cannot see it from where the second session starts.
 */
const STASH_DISTANCE = 200;
const STOCK_COBBLESTONE = 16;

const TASKS: TaskSpec[] = [
  {
    name: "collect-logs",
    description: "From an empty inventory, collect eight logs.",
    keywords: ["gathering"],
    difficulty: "Repeated navigate-dig-collect loop across several trees. Tests movement, digging, and picking up drops.",
    stages: [
      {
        name: "collect",
        goal: "Collect eight logs. Any kind of log counts.",
        agentTimeoutSec: 1200,
        oracleTarget: "logs",
        milestones: [log(1), log(4), log(8)],
      },
    ],
  },
  {
    name: "craft-wooden-pickaxe",
    description: "From an empty inventory, gather wood and craft a wooden pickaxe.",
    keywords: ["crafting"],
    difficulty: "Five dependent steps: logs, planks, crafting table, sticks, pickaxe. Needs navigation, digging, block placement, and crafting.",
    stages: [
      {
        name: "craft",
        goal: "Craft a wooden pickaxe.",
        agentTimeoutSec: 1800,
        oracleTarget: "wooden_pickaxe",
        milestones: woodenChain,
      },
    ],
  },
  {
    name: "craft-stone-pickaxe",
    description: "From an empty inventory, progress through wooden tools and craft a stone pickaxe.",
    keywords: ["crafting", "mining"],
    difficulty: "Seven dependent steps: the wooden pickaxe chain, then cobblestone, then the stone pickaxe. Adds digging stone with the right tool.",
    stages: [
      {
        name: "craft",
        goal: "Craft a stone pickaxe.",
        agentTimeoutSec: 2700,
        oracleTarget: "stone_pickaxe",
        milestones: [...woodenChain, cobblestone(3), crafted("stone_pickaxe", "Craft a stone pickaxe", "stone_pickaxe")],
      },
    ],
  },
  {
    name: "iron-tools",
    description: "From an empty inventory, mine iron ore, smelt it, and craft an iron pickaxe.",
    keywords: ["crafting", "mining", "smelting"],
    difficulty:
      "Eleven dependent steps: the stone pickaxe chain, then iron ore found underground, a furnace, fuel, smelting, and the iron pickaxe. Adds exploration for ore, the furnace, and a crafting chain longer than the stone pickaxe's.",
    stages: [
      {
        name: "craft",
        goal: "Craft an iron pickaxe. Find iron ore, mine it with the right tool, and smelt it in a furnace.",
        grading: "Every step counts, not only the pickaxe: the iron has to be mined, and the ingots have to come out of a furnace. Smelting counts as crafting: an item that you take out of a furnace is counted when you take it.",
        allRequired: true,
        agentTimeoutSec: 3600,
        oracleTarget: "iron_pickaxe",
        milestones: ironChain,
      },
    ],
  },
  {
    name: "diamond-night",
    description: "From an empty inventory, craft a diamond pickaxe and be alive at dawn after the first night.",
    keywords: ["crafting", "mining", "smelting", "survival"],
    difficulty:
      "Fourteen dependent steps: the iron pickaxe chain, then diamonds dug from 60 blocks and more below the surface, and the diamond pickaxe; and no death until the first night is over. Adds a deep descent past caves, lava, and the dark, a night in which hostile creatures spawn, and a clock the agent cannot hurry: it has to stay alive until dawn even when the pickaxe is done early.",
    extraBuiltins: ["survival", "combat"],
    stages: [
      {
        name: "dig",
        goal: `Craft a diamond pickaxe, and do not die before the first night is over.

Diamonds need an iron pickaxe, and they lie deep: diamond ore is most common far below sea level, under the deepslate. The world starts at dawn. A Minecraft day is 24000 ticks, which is 20 minutes of real time. The sun sets about 13000 ticks into the day (11 minutes after the world starts), and the night ends when the sun comes up on the next day (24000 ticks). Hostile creatures spawn in the dark, at night on the surface and at any time in caves.

You are graded when you stop or when the time limit passes, whichever is first. By then the server's clock must have passed the end of the first night (24000 ticks), the diamond pickaxe must be crafted, and the player must never have died: stopping early gives no reward. \`minebot wait --types day,hostile_near,low_health --timeout <ms>\` blocks until one of those events arrives, up to 30 minutes, and costs nothing while it waits.`,
        grading:
          "Every step of the chain counts, not only the diamond pickaxe: the iron has to be mined and smelted, and the diamonds have to be mined. Smelting counts as crafting: an item that you take out of a furnace is counted when you take it. The server's clock and the number of times the player died are graded too: the clock has to show at least one full day (24000 ticks), and the player must not have died.",
        allRequired: true,
        agentTimeoutSec: 5400,
        oracleTarget: "diamond_pickaxe",
        // The pickaxe is made and the player is walled in. Keep it alive until the server's clock passes the end of the first night.
        oracleAfter: (builtins) => `${runOracle("dawn", builtins, 1800000)}\n`,
        milestones: [
          ...ironChain,
          // Diamond ore is dug, and it drops diamonds.
          { id: "diamond", description: "Obtain three diamonds", via: "gathered", obtained: ["diamond"], blocks: ["diamond_ore", "deepslate_diamond_ore"], count: 3 },
          crafted("diamond_pickaxe", "Craft a diamond pickaxe", "diamond_pickaxe"),
        ],
        checks: [
          { id: "night_1", description: "Live to the end of the first night", type: "nights", nights: 1 },
          { id: "no_deaths", description: "Do not die", type: "deaths", max: 0 },
        ],
      },
    ],
  },
  {
    name: "survive-nights",
    description: `Survive ${NIGHTS} in-game nights in a fresh world without dying.`,
    keywords: ["survival", "endurance"],
    difficulty:
      "Open-ended and long: about 40 minutes of real time. Nothing is crafted or collected; the agent has to find a way to be safe through the dark, keep fed, and wait cheaply. Tests reflexes, shelter, and idling without losing the connection to the task.",
    extraBuiltins: ["survival", "combat"],
    stages: [
      {
        name: "survive",
        goal: `Survive ${NIGHTS} nights without dying.

The world starts at dawn. A Minecraft day is 24000 ticks, which is 20 minutes of real time. The sun sets about 13000 ticks into a day (11 minutes after the world starts), and a night ends when the sun comes up on the next day. Hostile creatures spawn in the dark, and the player has nothing but its hands.

You are graded when you stop or when the time limit passes, whichever is first. By then the server's clock must have passed the end of night ${NIGHTS} (${NIGHTS * 24000} ticks), so keep the player alive until then: stopping early gives no reward. \`minebot wait --types night,day,hostile_near --timeout <ms>\` blocks until one of those events arrives, up to 30 minutes, and costs nothing while it waits.`,
        grading: `The server's clock and the number of times the player died are graded instead of the items: the clock has to show at least ${NIGHTS} days (${NIGHTS * 24000} ticks) and the player must not have died.`,
        agentTimeoutSec: 3600,
        oracleTarget: "shelter",
        oracleAfter: () => `# The shelter is built. Wait for the dawn that ends each night: each \`day\` event is one. A wait that times out counts for nothing.
nights=0
while [ "$nights" -lt ${NIGHTS} ]; do
  out=$(minebot wait --types day --timeout 1500000 || true)
  echo "$out"
  case "$out" in
    *"timed out"*) ;;
    *) nights=$((nights + 1)) ;;
  esac
done
`,
        milestones: [],
        checks: [
          ...Array.from({ length: NIGHTS }, (_, i): CheckInput => ({ id: `night_${i + 1}`, description: `Live to the end of night ${i + 1}`, type: "nights", nights: i + 1 })),
          { id: "no_deaths", description: "Do not die", type: "deaths", max: 0 },
        ],
      },
    ],
  },
  {
    name: "stock-chest",
    description: `From an empty inventory, craft a chest, place it, and store ${STOCK_COBBLESTONE} cobblestone in it.`,
    keywords: ["crafting", "mining", "storage"],
    difficulty:
      "Nine dependent steps: the wooden pickaxe chain, then cobblestone mined in bulk, a chest crafted at a table, placed, and filled. Adds containers, which the server's statistics do not show: the verifier reads the chest's contents from the saved world.",
    extraBuiltins: ["container"],
    stages: [
      {
        name: "stock",
        goal: `Craft a chest, place it in the world, and store at least ${STOCK_COBBLESTONE} cobblestone in it.`,
        grading: "The contents of the chests in the world are graded too, as the server saved them: the cobblestone has to be in a chest when you finish.",
        agentTimeoutSec: 2700,
        oracleTarget: "stock_chest",
        milestones: [...woodenChain, cobblestone(STOCK_COBBLESTONE), crafted("chest", "Craft a chest", "chest")],
        checks: [{ id: "stocked", description: `Store ${STOCK_COBBLESTONE} cobblestone in a chest`, type: "stored", items: ["cobblestone"], min: STOCK_COBBLESTONE }],
      },
    ],
  },
  {
    name: "two-sessions",
    description: "Continue a job across two sessions of the agent: stash logs in a chest and leave, then, as a new session with no memory, find the chest and craft a stone pickaxe from the logs.",
    keywords: ["crafting", "storage", "memory", "continuity"],
    difficulty:
      "Two Harbor steps in one world, each a new agent session. The first sets up a chest of logs and leaves it far behind; the second has to find it again, from whatever the first session wrote down or left in the body, and use it. Tests notes and handoff, not game mechanics.",
    extraBuiltins: ["container"],
    notes: true,
    stages: [
      {
        name: "stash",
        goal: `Put ${STASH_LOGS} logs in a chest and leave them there. Collect logs, craft a chest, place it, store ${STASH_LOGS} logs in it, and then walk at least ${STASH_DISTANCE} blocks away from the chest and stop.

This is the first of two sessions. When you stop, a second session starts: a new agent session that has none of your context and none of your memory of this one. It starts where you stopped, with the inventory you leave, on the same body. The second session is asked to craft a stone pickaxe from the logs in this chest. It can read the body's notes, list its saved routines, and see the world; it knows nothing else about what you did. Leave it what it needs.`,
        grading: `The contents of the chests in the world and where the player stands are graded too, as the server saved them: ${STASH_LOGS} logs have to be in a chest, and the player has to be at least ${STASH_DISTANCE} blocks from it when you stop.`,
        agentTimeoutSec: 1800,
        // The second session needs the chest that this one filled; without it the trial has nothing to measure.
        minReward: 1.0,
        oracleTarget: "stash_chest",
        milestones: [log(STASH_LOGS), crafted("crafting_table", "Craft a crafting table", "crafting_table"), crafted("chest", "Craft a chest", "chest")],
        checks: [
          { id: "stashed", description: `Store ${STASH_LOGS} logs in a chest`, type: "stored", items: ["*_log"], min: STASH_LOGS },
          { id: "far_away", description: `Stand ${STASH_DISTANCE} blocks from the chest`, type: "distance", min: STASH_DISTANCE },
        ],
      },
      {
        name: "retrieve",
        goal: `Craft a stone pickaxe, using the logs in the chest that a previous session of this agent left.

You are the second of two sessions. The first session collected logs and put ${STASH_LOGS} of them in a chest somewhere in this world, then walked away from it. You know nothing about that session except what it left in the body (the notes and the saved routines) and in the world. Find the chest, take at least ${STASH_LOGS / 2} logs out of it, and use them for the tools. You start with whatever the first session left in the inventory.`,
        grading: `The contents of the chests in the world are graded too, as the server saved them: the chest that the first session filled has to be where it was and hold ${STASH_LOGS / 2} logs or fewer when you finish, and the first session has to have stopped at least ${STASH_DISTANCE} blocks from it.`,
        agentTimeoutSec: 1800,
        oracleTarget: "retrieve_logs",
        milestones: [crafted("wooden_pickaxe", "Craft a wooden pickaxe", "wooden_pickaxe"), cobblestone(3), crafted("stone_pickaxe", "Craft a stone pickaxe", "stone_pickaxe")],
        checks: [
          { id: "withdrawn", description: `Take ${STASH_LOGS / 2} logs out of the chest that the first session filled`, type: "withdrawn", items: ["*_log"], held: STASH_LOGS, max: STASH_LOGS / 2 },
          // The first session's step can still be rewritten while its verifier runs, so this step grades it again, from the grader's snapshot of it.
          { id: "first_session_far_away", description: `The first session stopped ${STASH_DISTANCE} blocks from the chest`, type: "distance", snapshot: "previous", min: STASH_DISTANCE },
        ],
      },
    ],
  },
];

const TASK_TOML_HEAD = `# Generated by bench/gen-tasks.ts. Edit the catalog there, then rerun it.
# Two sidecars hold what Harbor copies to the verifier: the body, every program the agent ran with its output
# (/var/log/minebot), and the grader, the player's statistics and what the saved world shows (/var/log/grading).
artifacts = [
  { source = "/var/log/minebot", destination = "minebot", service = "body" },
  { source = "/var/log/grading", destination = "grading", service = "grader" },
]
`;

function taskToml(task: TaskSpec, tier: Tier): string {
  const keywords = ["minecraft", ...task.keywords, "embodied", "code-as-action", `tier-${tier.name}`];
  const [only] = task.stages;
  const multiStep = task.stages.length > 1;
  // A task with several stages is a Harbor multi-step task: one trial, one set of containers, and a new agent session for each step.
  // Each step has its own instruction, time, reference solution, and verifier; the trial's reward is the last step's.
  const steps = task.stages
    .map(
      (stage) => `
[[steps]]
name = ${JSON.stringify(stage.name)}
${stage.minReward === undefined ? "" : `min_reward = ${stage.minReward.toFixed(1)}\n`}
[steps.agent]
timeout_sec = ${stage.agentTimeoutSec.toFixed(1)}
`,
    )
    .join("");
  return `schema_version = "${multiStep ? "1.4" : "1.3"}"
${multiStep ? 'multi_step_reward_strategy = "final"\n' : ""}${TASK_TOML_HEAD}
[task]
name = "minebot/${task.name}-${tier.name}"
description = ${JSON.stringify(task.description)}
keywords = ${JSON.stringify(keywords)}

[metadata]
category = "minecraft"
tier = "${tier.name}"
# Every tier has the base body: Mineflayer plus notes, status (deaths and reconnects), the event log with blocking waits, the one-line observation,
# and the routine library with action and reflex bindings. The tier features are below: the built-in modules the body offers (the closure of its
# --builtins over their uses) and the wiki.
builtins = ${JSON.stringify(offered(tierBuiltins(task, tier)))}
wiki = "${tier.wiki}"
goals = false
difficulty_explanation = ${JSON.stringify(task.difficulty)}
${multiStep ? steps : `
[agent]
timeout_sec = ${only!.agentTimeoutSec.toFixed(1)}
`}
# The verifier runs in a container of its own, built from tests/Dockerfile, apart from the agent's container.
# It never runs code that the agent could have changed. See compose() for why.
[verifier]
timeout_sec = 120.0
environment_mode = "separate"

[verifier.environment]
build_timeout_sec = 300.0
cpus = 1
memory_mb = 512

# Runs in the grader's container after each agent session ends: saves the server's world over RCON, which neither main nor the body can reach,
# and writes the player's statistics and the world facts to /var/log/grading, where the artifacts entry above collects them.
[[verifier.collect]]
service = "grader"
command = "node /opt/minebot/bench/verify/snapshot.ts ${PLAYER}"
timeout_sec = 120.0

[environment]
build_timeout_sec = 300.0
cpus = 2
memory_mb = 2048

[environment.healthcheck]
command = "minebot observe | grep -q '\\"connected\\": true'"
interval_sec = 3.0
timeout_sec = 10.0
start_period_sec = 20.0
retries = 40

[[environment.mcp_servers]]
name = "minebot"
transport = "stdio"
command = "minebot"
args = ["mcp"]
`;
}

function instruction(task: TaskSpec, tier: Tier, stage: Stage): string {
  const sections = [
    `You control a Minecraft player named \`${PLAYER}\` in a vanilla survival world (Minecraft Java Edition ${MC_VERSION}, Easy difficulty). No one else is playing. ${stage === task.stages[0] ? "The player starts with an empty inventory." : "The player is wherever the previous session left it."}

## Goal

${stage.goal}

## How to act

The \`minebot\` command in this terminal controls the player. The same actions are available as \`minebot\` MCP tools.

- \`minebot observe\` prints the position, health, inventory, and nearby entities as JSON.
- \`minebot run <file>\` runs a module (TypeScript or JavaScript) against the player and prints its logs and result. Without a file, it reads the module from stdin. \`--args <json>\` passes arguments.
- \`minebot api\` prints how a run works and what its context \`ctx\` holds on this body.
- \`minebot events\` prints recent chat, damage, and deaths.
- \`minebot stop\` aborts the running run.

The API references are at \`/opt/minebot/node_modules/mineflayer/docs/api.md\` and \`/opt/minebot/node_modules/mineflayer-pathfinder/readme.md\`.

## Runs

A run is a module. Its default export is a function: the body calls it with \`ctx\` and the \`--args\` object, and sends back what it returns. \`ctx.bot\` is the live Mineflayer bot; \`ctx.log\`, \`ctx.sleep\`, \`ctx.signal\`, \`ctx.notes\`, and \`ctx.store\` come with it. A module uses named imports from Node's core modules and from the packages that the body ships (\`mineflayer-pathfinder\`, \`vec3\`, \`minecraft-data\`), and \`require()\` works too. Save this as \`look.ts\`, then run \`minebot run look.ts\`:

\`\`\`ts
import { Vec3 } from "vec3";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  const mcData = require("minecraft-data")(ctx.bot.version);
  const feet = ctx.bot.entity.position.floored();
  const below = ctx.bot.blockAt(feet.plus(new Vec3(0, -1, 0)));
  ctx.log("standing on", below?.name);
  return { feet, below: below?.name, logId: mcData.itemsByName.oak_log.id };
};
\`\`\`

A run stops after 60 seconds unless you pass \`--timeout <ms>\`. Check \`ctx.signal.aborted\` in long loops. One run goes at a time. Values that you store on \`globalThis\` persist between runs.

## Routines

A routine is a module that you save in the body's library and call by name. The body keeps the library and the bindings. \`minebot routines save <file...>\` saves each file under its file name without the extension, and reports the type errors of its source (they do not stop the save). Save the modules that a routine imports first, and import them as \`./<name>.ts\`. \`minebot routines\` lists the routines and their bindings, and \`minebot routines source <name>\` prints one. \`defineRoutine\` from \`minebot-sdk/routine\` adds a description and zod schemas for the arguments and the result.

\`minebot bind action <name> <routine>\` names a routine for \`minebot call <name> --args <json>\`, which runs it like \`minebot run\` (same timeout, one run at a time). \`minebot unbind <name>\` removes a binding. Save this as \`where.ts\`:

\`\`\`ts
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext, args: { note?: string }) => {
  const { x, y, z } = ctx.bot.entity.position;
  ctx.log(args.note ?? "position");
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), health: ctx.bot.health };
};
\`\`\`

\`\`\`sh
minebot routines save where.ts
minebot bind action pos where
minebot call pos --args '{"note":"now"}'
\`\`\`

## Reflexes

A reflex is a routine that the body runs when an event arrives, so a reaction does not wait for your next turn. \`minebot bind reflex <name> <routine> --on <events>\` binds one, and the body calls the routine as \`(ctx, { event })\`, where \`event\` is \`{ seq, type, time, data }\`. The events include \`hurt\`, \`death\`, \`chat\`, \`low_health\` (health below 8), \`low_food\` (food below 6), \`hostile_near\` (a hostile creature within 16 blocks), \`night\`, and \`day\`. Options: \`--cooldown <ms>\` (default 1000), \`--timeout <ms>\` (default 30000), \`--priority <n>\`, \`--preempt\` (the firing stops the running run), \`--when <expression>\`, and \`--from\` and \`--match\` for chat. A firing waits until no run is active unless it preempts. A reflex that fails 3 times in a row disables itself; bind it again to enable it. \`minebot routines\` shows what each reflex did, and \`minebot unbind <name>\` removes one. Save this as \`eat.ts\`, then run \`minebot routines save eat.ts\` and \`minebot bind reflex eater eat --on low_food\`:

\`\`\`ts
import type { BodyEvent } from "minebot-sdk/client";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext, { event }: { event?: BodyEvent }) => {
  const food = ctx.bot.inventory.items().find((item) => ctx.bot.registry.foodsByName[item.name]);
  if (!food) return { ate: null, on: event?.type };
  await ctx.bot.equip(food, "hand");
  await ctx.bot.consume();
  return { ate: food.name, on: event?.type };
};
\`\`\``,
  ];
  const builtins = offered(tierBuiltins(task, tier));
  if (builtins.length > 0) {
    if (!builtins.includes("gatherer") || !builtins.includes("crafter")) throw new Error(`${task.name}-${tier.name}: the built-ins example calls gatherer and crafter`);
    sections.push(`## Built-in routines

The body offers these built-in routines, which take \`ctx\` and one object of arguments: ${builtins.join(", ")}. \`minebot builtins docs [module...]\` prints every routine with its arguments and result, and \`minebot builtins search <query>\` finds routines by what they do. Call one from the terminal with \`minebot call <module>.<routine> --args <json>\`, with no bind: \`minebot call gatherer.gather --args '{"blocks":"*_log","count":4}'\`. A run or a routine imports a module as \`minebot-sdk/routines/<module>\` and calls its routines with \`ctx\`:

\`\`\`ts
import * as gatherer from "minebot-sdk/routines/gatherer";
import * as crafter from "minebot-sdk/routines/crafter";
import type { RoutineContext } from "minebot-sdk/routine";

export default async (ctx: RoutineContext) => {
  await gatherer.gather(ctx, { blocks: "*_log", count: 4 });
  return crafter.make(ctx, { item: "wooden_pickaxe" });
};
\`\`\``);
  }
  if (tier.wiki !== "off") {
    sections.push(`## Wiki

The wiki has notes on game mechanics, step-by-step plans, and known quirks of this Minecraft version and of Mineflayer. Search it before you guess, and search for the text of an error when something fails:

- \`minebot wiki search <words>\` lists matching pages.
- \`minebot wiki read <page>\` prints a page.

A module can use \`ctx.wiki.search(words)\` and \`ctx.wiki.read(page)\` too.`);
  }
  if (task.notes) {
    sections.push(`## Notes

The body keeps notes that outlast your session: \`minebot notes\` lists them, \`minebot notes get <key>\` reads one, and \`minebot notes set <key> <text>\` writes one (the text comes from stdin when omitted). A module uses \`ctx.notes.list()\`, \`ctx.notes.get(key)\`, and \`ctx.notes.set(key, text)\`.`);
  }
  // A task without milestones has nothing to say about statistics; its stage says what is graded instead.
  const graded = [
    stage.milestones.length > 0 &&
      "The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice.",
    stage.grading,
    "You cannot run server commands.",
  ].filter(Boolean);
  sections.push(`## Grading

${graded.join(" ")}`);
  return `${sections.join("\n\n")}\n`;
}

/**
 * The server's healthcheck, which fails closed: RCON answers on loopback, the server's own server.properties has the whitelist on, and
 * the nft table of RCON_LOOPBACK_ONLY is loaded. A server image that ignores WHITELIST and RCON_LOOPBACK_ONLY fails the last two.
 */
const HEALTHCHECK = [
  "exec 3<>/dev/tcp/127.0.0.1/25575",
  "grep -qx white-list=true /opt/minecraft/server.properties",
  "nft list table inet rcon_guard | grep -q 'tcp dport 25575 drop'",
].join(" && ");

/**
 * The shell script of the body's command: remove what the tier withholds, then start the body, with the body's arguments as "$@".
 * Compose reads `$` in a value as interpolation and takes `$$` for a literal `$`, so each "$@" is written "$$@" in the file.
 */
const TIER_WRAPPER = 'node --conditions=minebot-sdk:source /opt/minebot/bench/tier/remove.ts "$$@" && exec minebot "$$@"';

/**
 * The compose file of a trial. Harbor reserves `main` for the agent and merges this file over its own.
 *
 * Isolation. The agent runs in `main` as root and must not reach the grading, so:
 * - `main` is on the `agent` network and the internal `api` network, which it shares with `body` only. `minecraft` is on the internal
 *   `game` network with `body`. `main` cannot resolve `minecraft`, and it does not mount the world volume. It could still reach the server by IP address:
 *   rootless podman routes between the bridges of a project (the `isolate` network option does not stop it with this netavark),
 *   so the server container refuses the game and RCON ports to everything outside its own network (RESTRICT_TO_OWN_SUBNET).
 *   A network attached to `main` that is not internal also gives it the internet, which agent harnesses need for their model API: that is `agent`.
 *   Every network of `body` is internal, so code that runs in the body cannot reach the internet; `main` reaches `body` over `api`.
 * - `main` runs the client image (bench/images/client), which has no body, built-ins, wiki, oracle, or verifier.
 * - The verifier is a separate Harbor environment (task.toml, [verifier.environment]) that runs apart from `main`.
 *   Its inputs are artifacts that Harbor copies from the sidecars: the grader's snapshot of the statistics and the world, and the body's program history.
 *   Harbor's alternatives either run the verifier in `main`, where the agent can edit it, or give it a second compose project
 *   that cannot reach this one; the snapshot hook ([[verifier.collect]]) is the supported way to pass server state across.
 *   The hook runs after each agent session ends. Harbor stops `main` before it only for the last (or only) session of a task,
 *   so the hook does not depend on `main` being stopped: it reads and writes nothing that `main` can reach.
 * - The `grader` sidecar holds the RCON password and the read-only world volume (the statistics, and the saved chunks that hold the containers).
 *   Besides the grader, only the server holds them (`minecraft` has RCON_PASSWORD and mounts the world read-write); the body has neither.
 *   The grader shares the network namespace of `minecraft` (network_mode), where the server
 *   accepts RCON on the loopback interface only (RCON_LOOPBACK_ONLY), so no other container reaches RCON even with the password.
 *   Its image is the body's (bench/images/minebot), which already holds the snapshot code and its dependencies; it runs nothing but the hook.
 *   Only the body API (with its token) is open to `main`.
 * - The server lets in only the agent's player (WHITELIST, enforced), so code that runs in the body cannot log in a second player.
 *   Its healthcheck fails closed: the server must have applied both protections (the whitelist, and the loopback-only RCON rule),
 *   so a server image that ignores them never becomes healthy and the trial fails at start.
 * - A module that runs in the body has the body process's privileges: it can `require` any package that the image holds and read any file
 *   that the body's user can. That is why the body holds neither the RCON password nor the world, and why nothing the verifier grades
 *   comes from the body: it grades from the grader's snapshot, and the program history is a record for whoever reads the trial.
 * - The tiers are what the body's container holds. The body command is a shell wrapper: it first runs bench/tier/remove.ts with the body's own
 *   arguments, which deletes the built-in modules and the wiki that the arguments do not offer, and starts the body only if that succeeds
 *   (`&&`), so a trial whose tier cannot be set up fails at start. The body flags are the single source of the tier.
 */
function compose(task: TaskSpec, tier: Tier): string {
  const builtins = tierBuiltins(task, tier);
  // Every tier has routines and reflexes (the body's defaults) and no milestones: the agent has no live grader.
  const flags = [`--builtins=${builtins.length > 0 ? builtins.join(",") : "none"}`, `--wiki=${tier.wiki}`, "--no-milestones"];
  return `# Generated by bench/gen-tasks.ts. See compose() there for the isolation design.
services:
  main:
    depends_on:
      body:
        condition: service_healthy
    networks:
      - agent
      - api

  minecraft:
    image: minebot.local/minebot-server:${MC_VERSION}
    pull_policy: never
    environment:
      EULA: "true"
      RCON_PASSWORD: minebot-bench
      LEVEL_SEED: "${SEED}"
      DIFFICULTY: easy
      RESTRICT_TO_OWN_SUBNET: "true"
      RCON_LOOPBACK_ONLY: "true"
      WHITELIST: ${JSON.stringify(JSON.stringify([{ uuid: offlineUuid(PLAYER), name: PLAYER }]))}
    cap_add:
      - NET_ADMIN
    volumes:
      - world:/opt/minecraft/world
    networks:
      - game
    healthcheck:
      # RCON answers on loopback, and the server applied both protections: the whitelist is on and RCON is loopback-only. Fails closed.
      test: ${JSON.stringify(["CMD", "bash", "-c", HEALTHCHECK])}
      interval: 2s
      timeout: 2s
      retries: 90
      start_period: 5s

  body:
    image: minebot.local/minebot:dev
    pull_policy: never
    command:
      - sh
      - -c
      - ${JSON.stringify(TIER_WRAPPER)}
      - tier
      - body
      - --bot=${PLAYER}
      - --host=minecraft
      - --api-host=0.0.0.0
      - --api-port=7070
      - --history=/var/log/minebot/programs.jsonl
      # Tier "${tier.name}".
${flags.map((f) => `      - ${f}`).join("\n")}
    environment:
      MINEBOT_TOKEN: minebot-bench-body
    networks:
      - api
      - game
    depends_on:
      minecraft:
        condition: service_healthy
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:7070/health').then(r => r.json()).then(h => process.exit(h.connected ? 0 : 1), () => process.exit(1))"
      interval: 2s
      timeout: 5s
      retries: 90
      start_period: 5s

  grader:
    image: minebot.local/minebot:dev
    pull_policy: never
    network_mode: "service:minecraft"
    # Idle until Harbor runs the snapshot hook in it. A process that is PID 1 ignores SIGTERM unless it handles it.
    command:
      - node
      - -e
      - "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1 << 30)"
    environment:
      RCON_PASSWORD: minebot-bench
    volumes:
      - world:/srv/minecraft-world:ro
    depends_on:
      minecraft:
        condition: service_healthy

networks:
  agent:
  api:
    internal: true
  game:
    internal: true

volumes:
  world:
`;
}

const DOCKERFILE = `# Generated by bench/gen-tasks.ts.
# The agent's container. Build the base image first: bench/build-images.sh
FROM minebot.local/minebot-client:dev
ENV MINEBOT_URL=http://body:7070 \\
    MINEBOT_TOKEN=minebot-bench-body
WORKDIR /root
`;

const VERIFIER_DOCKERFILE = `# Generated by bench/gen-tasks.ts.
# The verifier's container: the grading code from the verifier image, and this directory as /tests.
# Build the base image first: bench/build-images.sh
FROM minebot.local/minebot-verifier:dev
COPY . /tests/
`;

const TEST_SH = `#!/bin/sh
set -eu
exec node /opt/verifier/bench/verify/check.ts /tests/milestones.json
`;

/** `minebot run` of the oracle module with its arguments: the program of every solution that does not go through the library. */
const runOracle = (target: OracleTarget, builtins: boolean, timeoutMs = 900000): string =>
  `minebot run /solution/progression.ts --args '${JSON.stringify({ target, builtins })}' --timeout ${timeoutMs}`;

/**
 * The solutions that reach the oracle the way an agent reaches a routine it saved: collect-logs calls it by the action name `oracle`,
 * and craft-wooden-pickaxe runs bench/oracle/run-saved.ts, a run that imports it from the library. Every tier takes the same path,
 * so each trial of those two tasks exercises the library, the bindings, and a `call` or a run that imports a library module.
 */
const SAVED_SOLUTIONS: Partial<Record<OracleTarget, "call" | "run-saved">> = { logs: "call", wooden_pickaxe: "run-saved" };

/** The oracle commands of solve.sh: the files are the ones the emit loop copies into the solution directory. */
function oracleCommands(stage: Stage, builtins: boolean): string[] {
  const how = SAVED_SOLUTIONS[stage.oracleTarget];
  if (how === undefined) return [runOracle(stage.oracleTarget, builtins)];
  const args = JSON.stringify({ target: stage.oracleTarget, builtins });
  return [
    "minebot routines save /solution/progression.ts",
    "minebot bind action oracle progression",
    how === "call" ? `minebot call oracle --args '${args}' --timeout 900000` : `minebot run /solution/run-saved.ts --args '${args}' --timeout 900000`,
  ];
}

function solveSh(stage: Stage, builtins: boolean): string {
  return `#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
${oracleCommands(stage, builtins).join("\n")}
${stage.oracleAfter?.(builtins) ?? ""}`;
}

/** The files solve.sh reads, from bench/oracle. */
const solutionFiles = (stage: Stage): string[] => ["progression.ts", ...(SAVED_SOLUTIONS[stage.oracleTarget] === "run-saved" ? ["run-saved.ts"] : [])];

async function emit(file: string, content: string, executable = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (executable) await chmod(file, 0o755);
}

await rm(TASKS_DIR, { recursive: true, force: true });
for (const task of TASKS) {
  const multiStep = task.stages.length > 1;
  for (const tier of TIERS) {
    const dir = path.join(TASKS_DIR, `${task.name}-${tier.name}`);
    await emit(path.join(dir, "task.toml"), taskToml(task, tier));
    await emit(path.join(dir, "environment", "docker-compose.yaml"), compose(task, tier));
    await emit(path.join(dir, "environment", "Dockerfile"), DOCKERFILE);
    for (const stage of task.stages) {
      // A multi-step task keeps each step's instruction, tests, and solution under steps/<name>/.
      const stageDir = multiStep ? path.join(dir, "steps", stage.name) : dir;
      const spec: MilestoneSpecInput = { player: PLAYER, milestones: stage.milestones, checks: stage.checks ?? [], ...(stage.allRequired && { allRequired: true }) };
      await emit(path.join(stageDir, "instruction.md"), instruction(task, tier, stage));
      await emit(path.join(stageDir, "tests", "Dockerfile"), VERIFIER_DOCKERFILE);
      await emit(path.join(stageDir, "tests", "test.sh"), TEST_SH, true);
      await emit(path.join(stageDir, "tests", "milestones.json"), `${JSON.stringify(spec, null, 2)}\n`);
      await emit(path.join(stageDir, "solution", "solve.sh"), solveSh(stage, tier.builtins.length > 0), true);
      for (const file of solutionFiles(stage)) await copyFile(path.join(import.meta.dirname, "oracle", file), path.join(stageDir, "solution", file));
    }
  }
}
console.log(`generated ${TASKS.length} tasks x ${TIERS.length} tiers in ${path.relative(process.cwd(), TASKS_DIR)}/`);
