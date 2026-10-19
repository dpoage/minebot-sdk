// Runs bench/jobs/qwen.yaml against the local Qwen endpoint.
//   node bench/qwen.ts [--tier raw|kits|wiki|full]... [--task <glob>]... [extra harbor run options...]
// Reads the API key from $QWEN_KEY_FILE (default ~/.config/hyperqwen.key), asks the endpoint
// for the model's context length, and passes both to Harbor. Terminus 2 needs the context
// length to summarize before the context overflows; LiteLLM does not know local models.
// --task selects task directories by glob (e.g. "craft-*-full"); --tier is a shortcut for "*-<tier>".
// Without either, every task in bench/tasks runs.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const JOB = path.join(import.meta.dirname, "jobs", "qwen.yaml");
const KEY_FILE = process.env.QWEN_KEY_FILE ?? path.join(homedir(), ".config", "hyperqwen.key");
const TIERS = ["raw", "kits", "wiki", "full"] as const;

// --tier and --task select tasks; every other argument goes to `harbor run` unchanged.
const requestedTiers: string[] = [];
const taskGlobs: string[] = [];
const harborArgs: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!;
  const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
  if (flag === "--tier") requestedTiers.push(inline ?? process.argv[++i] ?? "");
  else if (flag === "--task") taskGlobs.push(inline ?? process.argv[++i] ?? "");
  else harborArgs.push(arg);
}
const selection = [...z.array(z.enum(TIERS)).parse(requestedTiers).map((t) => `*-${t}`), ...taskGlobs];

const Job = z
  .object({
    agents: z.tuple([z.object({ model_name: z.string(), model_base_url: z.string(), model_api_key_name: z.string() }).loose()]),
    datasets: z.tuple([z.object({ path: z.string() }).loose()]),
  })
  .loose();
// vLLM reports max_model_len; llama.cpp and SGLang use other names.
const Models = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        max_model_len: z.number().optional(),
        context_length: z.number().optional(),
        meta: z.object({ n_ctx_train: z.number(), n_ctx: z.number() }).partial().optional(),
      })
      .loose(),
  ),
});

const job = Job.parse(parseYaml(await readFile(JOB, "utf8")));
const [agent] = job.agents;
const modelId = agent.model_name.replace(/^openai\//, "");
const key = (await readFile(KEY_FILE, "utf8")).trim();

let res: Response;
try {
  res = await fetch(`${agent.model_base_url}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
} catch (err) {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  console.error(`[qwen] cannot reach ${agent.model_base_url}: ${cause}`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`[qwen] GET ${agent.model_base_url}/models returned ${res.status}`);
  process.exit(1);
}
const models = Models.parse(await res.json()).data;
const model = models.find((m) => m.id === modelId);
if (!model) {
  console.error(`[qwen] the endpoint serves ${models.map((m) => m.id).join(", ")}, not ${modelId}`);
  process.exit(1);
}
const context = model.max_model_len ?? model.context_length ?? model.meta?.n_ctx ?? model.meta?.n_ctx_train;
if (!context) {
  console.error(`[qwen] the endpoint does not report a context length for ${modelId}: ${JSON.stringify(model)}`);
  process.exit(1);
}
console.error(`[qwen] ${modelId} at ${agent.model_base_url}, context ${context} tokens, tasks ${selection.length ? selection.join(", ") : "all"}`);

if (selection.length > 0) job.datasets[0].task_names = selection;
const jobFile = path.join(await mkdtemp(path.join(tmpdir(), "minebot-qwen-")), "qwen.yaml");
await writeFile(jobFile, stringifyYaml(job));

const harbor = path.join(import.meta.dirname, "..", ".venv", "bin", "harbor");
const modelInfo = { max_input_tokens: context };
const child = spawn(harbor, ["run", "-c", jobFile, "--ak", `model_info=${JSON.stringify(modelInfo)}`, ...harborArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    [agent.model_api_key_name]: key,
    // podman-compose lives in the same virtual environment as Harbor.
    PATH: `${path.dirname(harbor)}:${process.env.PATH ?? ""}`,
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
