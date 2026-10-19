// Downloads and runs a vanilla Minecraft server for local development.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SERVER_PORT } from "../src/protocol/index.ts";
import { MC_VERSION } from "../src/mc/version.ts";

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const { values: args } = parseArgs({
  options: {
    version: { type: "string", default: MC_VERSION },
    dir: { type: "string", default: ".dev-server" },
    port: { type: "string", default: String(DEFAULT_SERVER_PORT) },
    seed: { type: "string", default: "" },
    memory: { type: "string", default: "2G" },
    "accept-eula": { type: "boolean", default: false },
  },
});

interface VersionInfo {
  downloads: { server: { url: string; sha1: string } };
  javaVersion: { majorVersion: number };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function versionInfo(version: string): Promise<VersionInfo> {
  const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(MANIFEST_URL);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Minecraft version ${version} is not in the Mojang manifest`);
  return fetchJson<VersionInfo>(entry.url);
}

async function ensureJar(dir: string, info: VersionInfo): Promise<string> {
  const jar = path.join(dir, `server-${args.version}.jar`);
  const { url, sha1: expected } = info.downloads.server;
  if (existsSync(jar) && createHash("sha1").update(await readFile(jar)).digest("hex") === expected) return jar;
  console.log(`[dev-server] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`server jar download failed: ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const actual = createHash("sha1").update(data).digest("hex");
  if (actual !== expected) throw new Error(`server jar sha1 mismatch: ${actual} != ${expected}`);
  await writeFile(jar, data);
  return jar;
}

function javaMajor(): number {
  const out = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (out.error) throw new Error(`java not found: ${out.error.message}`);
  const match = /version "(\d+)(?:\.(\d+))?/.exec(out.stderr);
  if (!match?.[1]) throw new Error(`cannot parse java version from: ${out.stderr}`);
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

async function ensureEula(dir: string): Promise<void> {
  const file = path.join(dir, "eula.txt");
  if (args["accept-eula"] || process.env.MINECRAFT_EULA === "true") {
    await writeFile(file, "# Accepted via minebot dev-server (https://aka.ms/MinecraftEULA)\neula=true\n");
    return;
  }
  if (existsSync(file) && /^eula=true$/m.test(await readFile(file, "utf8"))) return;
  throw new Error(
    "The Minecraft EULA is not accepted. Read https://aka.ms/MinecraftEULA, then rerun with --accept-eula.",
  );
}

/** Writes server.properties on first run only, so later manual edits persist. */
async function ensureProperties(dir: string): Promise<void> {
  const file = path.join(dir, "server.properties");
  if (existsSync(file)) return;
  const props = {
    "online-mode": "false", // bodies join with offline usernames
    "server-ip": "127.0.0.1",
    "server-port": args.port,
    "level-seed": args.seed,
    difficulty: "easy",
    "spawn-protection": "0",
    "view-distance": "8",
    "simulation-distance": "8",
    motd: "minebot dev server",
  };
  const body = Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writeFile(file, `${body}\n`);
}

async function main(): Promise<void> {
  const dir = path.resolve(args.dir);
  await mkdir(dir, { recursive: true });
  await ensureEula(dir);
  const info = await versionInfo(args.version);
  const required = info.javaVersion.majorVersion;
  const found = javaMajor();
  if (found < required) throw new Error(`Minecraft ${args.version} needs Java ${required}+, found Java ${found}`);
  const jar = await ensureJar(dir, info);
  await ensureProperties(dir);

  console.log(`[dev-server] starting Minecraft ${args.version} in ${dir}`);
  const child = spawn("java", [`-Xmx${args.memory}`, "-jar", jar, "--nogui"], { cwd: dir, stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((err: unknown) => {
  console.error(`[dev-server] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
