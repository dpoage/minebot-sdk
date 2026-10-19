import { createHash } from "node:crypto";
import { z } from "zod";
import { Milestone } from "../../src/milestones/milestones.ts";
import { Check } from "./checks.ts";

/**
 * A task's grading spec, stored as `tests/milestones.json`: milestones graded from the player's statistics, then checks graded
 * from the world facts. The reward is 1 when the last milestone (every milestone with `allRequired`) and every check are met.
 */
export const MilestoneSpec = z
  .object({
    /** Username of the graded player. */
    player: z.string().default("agent"),
    milestones: z.array(Milestone).default([]),
    checks: z.array(Check).default([]),
    /** The reward needs every milestone, not only the last. See `gradeTrial`. */
    allRequired: z.boolean().default(false),
  })
  .refine((spec) => spec.milestones.length + spec.checks.length > 0, { message: "a spec needs a milestone or a check" });
export type MilestoneSpec = z.infer<typeof MilestoneSpec>;
/** The spec as written in a file, before defaults apply. */
export type MilestoneSpecInput = z.input<typeof MilestoneSpec>;

/** UUID an offline-mode server assigns to a username (name-based UUID v3 of "OfflinePlayer:<name>"). */
export function offlineUuid(username: string): string {
  const h = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x30;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
