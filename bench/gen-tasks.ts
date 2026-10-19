// Generates bench/tasks/ from the task catalog below: one Harbor task directory per task and tier.
//   node bench/gen-tasks.ts
// Edit this file, not the generated directories; the generator deletes and rewrites bench/tasks/.
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_KITS } from "../src/kit/index.ts";
import { MC_VERSION } from "../src/mc/version.ts";
import type { CheckInput } from "./verify/checks.ts";
import type { MilestoneSpecInput } from "./verify/milestones.ts";

const TASKS_DIR = path.join(import.meta.dirname, "tasks");
/** Seed of the dev world; it has several trees within 20 blocks of spawn. */
const SEED = "-1395321890861809374";

type Milestones = NonNullable<MilestoneSpecInput["milestones"]>;
type Milestone = Milestones[number];

/** The programs of bench/oracle/progression.js, by TARGET. */
type OracleTarget = "logs" | "wooden_pickaxe" | "stone_pickaxe" | "iron_pickaxe" | "shelter" | "stock_chest" | "stash_chest" | "retrieve_logs";

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
  /** TARGET passed to bench/oracle/progression.js by the reference solution. */
  oracleTarget: OracleTarget;
  /** Shell lines that run after the reference program in solve.sh. */
  oracleAfter?: string;
  milestones: Milestones;
  checks?: CheckInput[];
}

interface TaskSpec {
  name: string;
  description: string;
  keywords: string[];
  difficulty: string;
  /** Kits that the kits and full tiers offer besides the tier's own; the primitives they use come with them. */
  extraKits?: string[];
  /** The body starts with triggers, and the instruction describes them. Every other task starts with `--no-triggers`. */
  triggers?: boolean;
  /** The instruction describes the notes. Only a task in which the notes matter says so. */
  notes?: boolean;
  /** One session per stage. A task with several stages is a multi-step Harbor task: a new agent session starts at each. */
  stages: Stage[];
}

/**
 * What the agent gets on top of the base body. The base body is Mineflayer plus notes, status (deaths and
 * reconnects), the event log with blocking waits, and the one-line observation; every tier has it. Every tier also locks its kits.
 * The lock is advisory: programs run in a node:vm context that is not a security boundary (see compose()).
 */
interface Tier {
  name: string;
  kits: string[];
  wiki: "off" | "read";
}

const TIERS: Tier[] = [
  { name: "raw", kits: [], wiki: "off" },
  { name: "kits", kits: ["gatherer", "crafter", "builder", "explorer", "social"], wiki: "off" },
  { name: "wiki", kits: [], wiki: "read" },
  { name: "full", kits: ["gatherer", "crafter", "builder", "explorer", "social"], wiki: "read" },
];

/**
 * The kits a body offers when it is started with `--kits=<names>`: the named kits and, transitively, the kits they use.
 * Primitives use no kits; routines build on them. The instruction names both groups.
 */
function offered(names: string[]): { primitives: string[]; routines: string[] } {
  const byName = new Map(BUILTIN_KITS.map((kit) => [kit.name, kit]));
  const all = new Set<string>();
  const add = (name: string): void => {
    const kit = byName.get(name);
    if (!kit) throw new Error(`unknown kit "${name}"`);
    if (all.has(name)) return;
    all.add(name);
    kit.uses.forEach(add);
  };
  names.forEach(add);
  const kits = BUILTIN_KITS.filter((kit) => all.has(kit.name));
  return { primitives: kits.filter((k) => k.uses.length === 0).map((k) => k.name), routines: kits.filter((k) => k.uses.length > 0).map((k) => k.name) };
}

/** The kits a tier offers in a task: the tier's own, plus the task's extra kits. None in a tier without kits. */
const tierKits = (task: TaskSpec, tier: Tier): string[] => (tier.kits.length > 0 ? [...tier.kits, ...(task.extraKits ?? [])] : []);

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
        milestones: [
          ...woodenChain,
          cobblestone(3),
          crafted("stone_pickaxe", "Craft a stone pickaxe", "stone_pickaxe"),
          // Iron ore is dug, and it drops raw iron.
          { id: "raw_iron", description: "Obtain three raw iron", via: "gathered", obtained: ["raw_iron"], blocks: ["iron_ore", "deepslate_iron_ore"], count: 3 },
          crafted("furnace", "Craft a furnace", "furnace"),
          { id: "iron_ingot", description: "Smelt three iron ingots", via: "crafted", obtained: ["iron_ingot"], count: 3 },
          crafted("iron_pickaxe", "Craft an iron pickaxe", "iron_pickaxe"),
        ],
      },
    ],
  },
  {
    name: "survive-nights",
    description: `Survive ${NIGHTS} in-game nights in a fresh world without dying.`,
    keywords: ["survival", "endurance"],
    difficulty:
      "Open-ended and long: about 40 minutes of real time. Nothing is crafted or collected; the agent has to find a way to be safe through the dark, keep fed, and wait cheaply. Tests reflexes (triggers), shelter, and idling without losing the connection to the task.",
    extraKits: ["survival", "combat"],
    triggers: true,
    stages: [
      {
        name: "survive",
        goal: `Survive ${NIGHTS} nights without dying.

The world starts at dawn. A Minecraft day is 24000 ticks, which is 20 minutes of real time. The sun sets about 13000 ticks into a day (11 minutes after the world starts), and a night ends when the sun comes up on the next day. Hostile creatures spawn in the dark, and the player has nothing but its hands.

You are graded when you stop or when the time limit passes, whichever is first. By then the server's clock must have passed the end of night ${NIGHTS} (${NIGHTS * 24000} ticks), so keep the player alive until then: stopping early gives no reward. \`minebot wait --types night,day,hostile_near --timeout <ms>\` blocks until one of those events arrives, up to 30 minutes, and costs nothing while it waits.`,
        grading: `The server's clock and the number of times the player died are graded instead of the items: the clock has to show at least ${NIGHTS} days (${NIGHTS * 24000} ticks) and the player must not have died.`,
        agentTimeoutSec: 3600,
        oracleTarget: "shelter",
        oracleAfter: `# The shelter is built. Wait for the dawn that ends each night: each \`day\` event is one. A wait that times out counts for nothing.
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
    extraKits: ["container"],
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
    extraKits: ["container"],
    notes: true,
    stages: [
      {
        name: "stash",
        goal: `Put ${STASH_LOGS} logs in a chest and leave them there. Collect logs, craft a chest, place it, store ${STASH_LOGS} logs in it, and then walk at least ${STASH_DISTANCE} blocks away from the chest and stop.

This is the first of two sessions. When you stop, a second session starts: a new agent session that has none of your context and none of your memory of this one. It starts where you stopped, with the inventory you leave, on the same body. The second session is asked to craft a stone pickaxe from the logs in this chest. It can read the body's notes and see the world; it knows nothing else about what you did. Leave it what it needs.`,
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

You are the second of two sessions. The first session collected logs and put ${STASH_LOGS} of them in a chest somewhere in this world, then walked away from it. You know nothing about that session except what it left in the body (the notes) and in the world. Find the chest, take at least ${STASH_LOGS / 2} logs out of it, and use them for the tools. You start with whatever the first session left in the inventory.`,
        grading: `The contents of the chests in the world are graded too, as the server saved them: the chest that the first session filled has to be where it was and hold ${STASH_LOGS / 2} logs or fewer when you finish.`,
        agentTimeoutSec: 1800,
        oracleTarget: "retrieve_logs",
        milestones: [crafted("wooden_pickaxe", "Craft a wooden pickaxe", "wooden_pickaxe"), cobblestone(3), crafted("stone_pickaxe", "Craft a stone pickaxe", "stone_pickaxe")],
        checks: [{ id: "withdrawn", description: `Take ${STASH_LOGS / 2} logs out of the chest that the first session filled`, type: "withdrawn", items: ["*_log"], held: STASH_LOGS, max: STASH_LOGS / 2 }],
      },
    ],
  },
];

const TASK_TOML_HEAD = `# Generated by bench/gen-tasks.ts. Edit the catalog there, then rerun it.
# After the agent's container stops, the body sidecar writes two things that Harbor copies to the verifier:
# every program the agent ran, with its output (/var/log/minebot), and the player's statistics and what the saved world shows (/var/log/grading).
artifacts = [
  { source = "/var/log/minebot", destination = "minebot", service = "body" },
  { source = "/var/log/grading", destination = "grading", service = "body" },
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
# Every tier has the base body: Mineflayer plus notes, status (deaths and reconnects), the event log with blocking waits, and the one-line observation.
kits = ${JSON.stringify(tierKits(task, tier))}
wiki = "${tier.wiki}"
goals = false
triggers = ${task.triggers === true}
difficulty_explanation = ${JSON.stringify(task.difficulty)}
${multiStep ? steps : `
[agent]
timeout_sec = ${only!.agentTimeoutSec.toFixed(1)}
`}
# The verifier runs in a container of its own, built from tests/Dockerfile, after the agent's container is stopped.
# It never runs code that the agent could have changed. See compose() for why.
[verifier]
timeout_sec = 120.0
environment_mode = "separate"

[verifier.environment]
build_timeout_sec = 300.0
cpus = 1
memory_mb = 512

# Runs in the body's container after the agent's container is stopped: saves the server's world over RCON
# and writes the player's statistics and the world facts to /var/log/grading, where the artifacts entry above collects them.
[[verifier.collect]]
service = "body"
command = "node /opt/minebot/bench/verify/snapshot.ts agent"
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
    `You control a Minecraft player named \`agent\` in a vanilla survival world (Minecraft Java Edition ${MC_VERSION}, Easy difficulty). No one else is playing. ${stage === task.stages[0] ? "The player starts with an empty inventory." : "The player is wherever the previous session left it."}

## Goal

${stage.goal}

## How to act

The \`minebot\` command in this terminal controls the player. The same actions are available as \`minebot\` MCP tools.

- \`minebot observe\` prints the position, health, inventory, and nearby entities as JSON.
- \`minebot run <file>\` runs a JavaScript program against the player and prints its logs and return value. Without a file, it reads the program from stdin.
- \`minebot api\` prints the program reference. A program is the body of an async function that receives a live Mineflayer \`bot\`.
- \`minebot events\` prints recent chat, damage, and deaths.
- \`minebot stop\` aborts the running program.

A program stops after 60 seconds unless you pass \`--timeout <ms>\`. Values that you store on \`globalThis\` persist between programs, so you can build helper functions and reuse them. The API references are at \`/opt/minebot/node_modules/mineflayer/docs/api.md\` and \`/opt/minebot/node_modules/mineflayer-pathfinder/readme.md\`.`,
  ];
  const kits = tierKits(task, tier);
  if (kits.length > 0) {
    const { primitives, routines } = offered(kits);
    sections.push(`## Kits

Programs call ready-made actions through the \`kit\` global, namespaced by kit, with one object argument: \`await kit.gatherer.gather({ blocks: "*_log", count: 4 })\` or \`await kit.crafter.make({ item: "wooden_pickaxe" })\`. Run \`minebot kits docs\` for every action, its arguments, and their defaults. The body offers the primitive kits ${primitives.join(", ")} and the routine kits ${routines.join(", ")}, which are built from them. You cannot change the active kits.`);
  }
  if (tier.wiki !== "off") {
    sections.push(`## Wiki

The wiki has notes on game mechanics, step-by-step plans, and known quirks of this Minecraft version and of Mineflayer. Search it before you guess, and search for the text of an error when something fails:

- \`minebot wiki search <words>\` lists matching pages.
- \`minebot wiki read <page>\` prints a page.

Programs can use \`wiki.search(words)\` and \`wiki.read(page)\` too.`);
  }
  if (task.notes) {
    sections.push(`## Notes

The body keeps notes that outlast your session: \`minebot notes\` lists them, \`minebot notes get <key>\` reads one, and \`minebot notes set <key> <text>\` writes one (the text comes from stdin when omitted). Programs use \`notes.list()\`, \`notes.get(key)\`, and \`notes.set(key, text)\`.`);
  }
  if (task.triggers) {
    sections.push(`## Triggers

A trigger is a program that the body starts when an event arrives, so a reaction does not wait for your next turn. \`minebot triggers add <name> --on <events> [file]\` saves one (the program comes from stdin when the file is omitted; options \`--cooldown <ms>\`, \`--timeout <ms>\`, \`--priority <n>\`, and \`--preempt\`, which lets the trigger stop the running program). \`minebot triggers\` lists the triggers and what they did, and \`minebot triggers rm <name>\` deletes one. Programs can use \`triggers.add({ name, on, run })\` too. The events include \`hurt\`, \`low_health\`, \`low_food\`, \`hostile_near\`, \`night\`, and \`day\`. The body runs only the triggers you register.`);
  }
  // A task without milestones has nothing to say about statistics; its stage says what is graded instead.
  const graded = [
    stage.milestones.length > 0 &&
      "The server's record of what the player dug, picked up, and crafted is graded after you finish. Picking an item up again after you dropped it does not count twice.",
    stage.grading,
    "You cannot run server commands.",
  ].filter(Boolean);
  sections.push(`## Grading

${graded.join(" ")}

Every program you run is recorded and audited. A program that reaches outside the program environment fails the trial with reward 0. The audit flags these names wherever they appear in a program, comments and strings included: \`process\`, \`require(\`, \`import(\`, \`getBuiltinModule\`, \`Function(\`, \`constructor.constructor\`, and \`globalThis.constructor\`.`);
  return `${sections.join("\n\n")}\n`;
}

/**
 * The compose file of a trial. Harbor reserves `main` for the agent and merges this file over its own.
 *
 * Isolation. The agent runs in `main` as root and must not reach the grading, so:
 * - `main` is on the `agent` network with `body` only. `minecraft` is on the internal `game` network with `body`.
 *   `main` cannot resolve `minecraft`, and it does not mount the world volume. It could still reach the server by IP address:
 *   rootless podman routes between the bridges of a project (the `isolate` network option does not stop it with this netavark),
 *   so the server container refuses the game and RCON ports to everything outside its own network (RESTRICT_TO_OWN_SUBNET).
 *   A network attached to `main` that is not internal also gives it the internet, which agent harnesses need for their model API.
 * - `main` runs the client image (bench/images/client), which has no oracle, kits, wiki, or verifier.
 * - The verifier is a separate Harbor environment (task.toml, [verifier.environment]) that starts after `main` is stopped.
 *   Its inputs are artifacts that Harbor copies from the sidecars: the body's snapshot of the statistics and the world, and the program history.
 *   Harbor's alternatives either run the verifier in `main`, where the agent can edit it, or give it a second compose project
 *   that cannot reach this one; the snapshot hook ([[verifier.collect]]) is the supported way to pass server state across.
 * - The body holds the RCON password and the read-only world volume (the statistics, and the saved chunks that hold the containers),
 *   and only the body API (with its token) is open to `main`.
 *   A program that escapes the VM can reach the body's process, so the body flags such programs (src/audit.ts)
 *   and the verifier fails the trial. That is an audit, not a security boundary.
 */
function compose(task: TaskSpec, tier: Tier): string {
  const kits = tierKits(task, tier);
  const flags = [
    ...(kits.length > 0 ? [`--kits=${kits.join(",")}`] : ["--kits="]),
    "--lock-kits",
    "--no-agent-kits",
    `--wiki=${tier.wiki}`,
    "--no-milestones",
    // Triggers are off unless the task is about reflexes (see TaskSpec.triggers).
    ...(task.triggers ? [] : ["--no-triggers"]),
  ];
  return `# Generated by bench/gen-tasks.ts. See compose() there for the isolation design.
services:
  main:
    depends_on:
      body:
        condition: service_healthy
    networks:
      - agent

  minecraft:
    image: minebot.local/minebot-server:${MC_VERSION}
    pull_policy: never
    environment:
      EULA: "true"
      RCON_PASSWORD: minebot-bench
      LEVEL_SEED: "${SEED}"
      DIFFICULTY: easy
      RESTRICT_TO_OWN_SUBNET: "true"
    cap_add:
      - NET_ADMIN
    volumes:
      - world:/opt/minecraft/world
    networks:
      - game
    healthcheck:
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/25575"]
      interval: 2s
      timeout: 2s
      retries: 90
      start_period: 5s

  body:
    image: minebot.local/minebot:dev
    pull_policy: never
    command:
      - minebot
      - body
      - --bot=agent
      - --host=minecraft
      - --api-host=0.0.0.0
      - --api-port=7070
      - --history=/var/log/minebot/programs.jsonl
      # Tier "${tier.name}".
${flags.map((f) => `      - ${f}`).join("\n")}
    environment:
      MINEBOT_TOKEN: minebot-bench-body
      RCON_PASSWORD: minebot-bench
    volumes:
      - world:/srv/minecraft-world:ro
    networks:
      - agent
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

networks:
  agent:
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

function solveSh(stage: Stage): string {
  return `#!/bin/sh
# Oracle: runs the reference program through the same API the agent uses.
# Harbor uploads this directory to /solution; the agent's image does not contain the program.
set -eu
{ echo 'const TARGET = "${stage.oracleTarget}";'; cat /solution/progression.js; } \\
  | minebot run --timeout 900000
${stage.oracleAfter ?? ""}`;
}

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
      const spec: MilestoneSpecInput = { player: "agent", milestones: stage.milestones, checks: stage.checks ?? [], ...(stage.allRequired && { allRequired: true }) };
      await emit(path.join(stageDir, "instruction.md"), instruction(task, tier, stage));
      await emit(path.join(stageDir, "tests", "Dockerfile"), VERIFIER_DOCKERFILE);
      await emit(path.join(stageDir, "tests", "test.sh"), TEST_SH, true);
      await emit(path.join(stageDir, "tests", "milestones.json"), `${JSON.stringify(spec, null, 2)}\n`);
      await emit(path.join(stageDir, "solution", "solve.sh"), solveSh(stage), true);
      await copyFile(path.join(import.meta.dirname, "oracle", "progression.js"), path.join(stageDir, "solution", "progression.js"));
    }
  }
}
console.log(`generated ${TASKS.length} tasks x ${TIERS.length} tiers in ${path.relative(process.cwd(), TASKS_DIR)}/`);
