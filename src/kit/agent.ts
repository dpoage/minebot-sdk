// Compiling agent kits: TypeScript source in the one shape every kit shares —
// `export default defineKit({ ... })` with the globals defineKit, action, and z provided.
// Types are stripped with node's own stripper, so positions survive and error messages
// point into the source the agent wrote.
import { stripTypeScriptTypes } from "node:module";
import { action, defineKit, isKit, type Kit } from "./kit.ts";
import { z } from "zod";

/** A kit's source failed validation. The message is safe to show the agent who wrote it. */
export class KitSourceError extends Error {}

const IMPORT_OR_REQUIRE = /\bimport\b|\brequire\s*\(/;
const DEFAULT_EXPORT = /(^|[\s;}])export\s+default\b/;
const ANY_EXPORT = /(^|[\s;}])export\b/;

/** Compiles kit source into a Kit, or throws KitSourceError with the reason. */
export function compileKit(source: string): Kit {
  if (IMPORT_OR_REQUIRE.test(source)) {
    throw new KitSourceError("kit source cannot import or require anything; defineKit, action, and z are provided as globals");
  }
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(source);
  } catch (err) {
    throw new KitSourceError(`kit source is not valid TypeScript: ${err instanceof Error ? err.message : String(err)}`);
  }
  const first = stripped.match(DEFAULT_EXPORT);
  if (!first || stripped.match(new RegExp(DEFAULT_EXPORT.source, "g"))!.length > 1) {
    throw new KitSourceError('kit source must have exactly one "export default defineKit({ ... })"');
  }
  const body = `${stripped.slice(0, first.index! + first[0].length - "export default".length)}return ${stripped.slice(first.index! + first[0].length)}`;
  if (ANY_EXPORT.test(body)) throw new KitSourceError('only "export default defineKit({ ... })" may be exported');
  // new Function returns Function; the shape we call it with is exactly this.
  let declared: unknown;
  try {
    const factory = new Function("defineKit", "action", "z", `"use strict";\n${body}`) as (...args: unknown[]) => unknown;
    declared = factory(defineKit, action, z);
  } catch (err) {
    throw new KitSourceError(`kit source failed to run: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The only values factory can return come from our own defineKit, which validated the kit;
  // the shape check below just gives a better message for a source that returned something else.
  if (!isKit(declared)) {
    throw new KitSourceError("kit source must end with: export default defineKit({ ... })");
  }
  return declared;
}
