// The trigger store's entry schema as the code before Round B reads it: TriggerName, TriggerInput
// (src/protocol/schemas.ts) and Stored (src/host/triggers.ts) copied from commit 0580923
// (`git show 0580923:src/protocol/schemas.ts`, `git show 0580923:src/host/triggers.ts`), nothing
// else changed. `from` and `match` come from today's WaitInput, which Round B did not touch, as
// MAX_TIMEOUT_MS does not differ. A body rolled back to that code parses its triggers.json with this schema.
import { z } from "zod";
import { MAX_TIMEOUT_MS, WaitInput } from "../../../src/protocol/index.ts";

const MAX_TRIGGER_CODE_LENGTH = 32 * 1024;
const DEFAULT_TRIGGER_COOLDOWN_MS = 1000;
const DEFAULT_TRIGGER_TIMEOUT_MS = 30_000;

const TriggerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,47}$/, "use 1-48 lowercase letters, digits, and . _ -; start with a letter or digit");

const TriggerInput = z.object({
  name: TriggerName,
  /** Event types that fire the trigger; any of them matches. A trigger cannot listen to `trigger_*` events. */
  on: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(16)
    .refine((types) => !types.some((type) => type.startsWith("trigger_")), "a trigger cannot listen to trigger events"),
  from: WaitInput.shape.from,
  match: WaitInput.shape.match,
  /** A JavaScript expression over `event` and `bot`; the trigger fires only when it is truthy. */
  when: z.string().min(1).max(2000).optional(),
  /** Program source, run with the usual globals plus `event`. */
  run: z.string().min(1).max(MAX_TRIGGER_CODE_LENGTH, "trigger code is limited to 32 KiB"),
  /** Minimum time between two firings of this trigger. */
  cooldownMs: z.number().int().nonnegative().max(60 * 60_000).default(DEFAULT_TRIGGER_COOLDOWN_MS),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TRIGGER_TIMEOUT_MS),
  enabled: z.boolean().default(true),
  /** Abort the running program when the trigger fires; the firing runs once that program has ended. */
  preempt: z.boolean().default(false),
  /** Order of waiting triggers, highest first; a preempting trigger never aborts a running trigger of equal or higher priority. */
  priority: z.number().int().min(-100).max(100).default(0),
});

export const BaseStored = TriggerInput.extend({
  updated: z.string(),
  disabledReason: z.string().optional(),
});
