// One line of a body's program history. The benchmark verifier reads these lines; the body only writes them.
import { z } from "zod";

export const HistoryRecord = z.looseObject({
  seq: z.number(),
  startedAt: z.string(),
  code: z.string(),
  /** A program that was flagged is also written before it runs, with status `started`, in case it kills the body. */
  status: z.string(),
  escapeAttempts: z.array(z.string()).default([]),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;
