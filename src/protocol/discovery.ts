// Where running bodies and their clients find each other. Shared by the body, the CLI, and the MCP server.
import path from "node:path";

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 25565;

/** Directory where running bodies publish their endpoint files (`<name>.json`). */
export const RUNTIME_DIR = path.resolve(process.env.MINEBOT_RUNTIME_DIR ?? ".minebot");

export function endpointFile(name: string): string {
  return path.join(RUNTIME_DIR, `${name}.json`);
}
