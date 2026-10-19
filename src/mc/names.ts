// Block and item name patterns. Shared by kits, milestone grading, and the benchmark verifier,
// so this module imports nothing but zod.
import { z } from "zod";

/** A block or item name pattern: `oak_log`, `minecraft:oak_log`, `*_log`, or a list of them. */
export const NamePattern = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export type NamePattern = z.infer<typeof NamePattern>;

/** Matches ids without namespace against `*` globs. */
export function nameMatcher(pattern: NamePattern): (name: string) => boolean {
  const regexes = (Array.isArray(pattern) ? pattern : [pattern]).map(
    (p) =>
      new RegExp(
        `^${p
          .replace(/^minecraft:/, "")
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      ),
  );
  return (name) => {
    const id = name.replace(/^minecraft:/, "");
    return regexes.some((re) => re.test(id));
  };
}
