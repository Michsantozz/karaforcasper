import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Meeting minutes reconciliation (no human in the loop).
 *
 * The happy path generates the minutes in the bot webhook (transcript.done). This cron is the
 * SAFETY NET: if the webhook got lost, arrived before the transcript was
 * ready, or the enrichment failed transiently, the row in meeting_records
 * stays "pending"/"processing". Here we scan the stuck ones and reprocess them — durable
 * by construction (each tick is a new attempt).
 *
 * Runs every 5 min. staleMs=15min (≈3× the cron, aligned with claim's
 * staleProcessingMs): only reprocesses rows stuck long enough that a live
 * webhook-enrich would already have finished, so we never race a running
 * enrichment. A slow-but-alive run stays untouched until it's genuinely stale.
 */
// Exported for unit testing the step logic in isolation (see tests/unit/workflows).
export const reconcile = createStep({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  execute: async () => {
    const { reconcileStuckMeetings } = await import("@/server/recall/enrich");
    return reconcileStuckMeetings(15 * 60_000);
  },
});

export const meetingReconcileWorkflow = createWorkflow({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  cron: "*/5 * * * *",
  // Serializes runs: reconcile sweeps every stuck row and can outlast the 5-min
  // tick. concurrency:1 makes Inngest queue the next tick instead of running two
  // sweeps in parallel (which would double-claim the same records).
  concurrency: { limit: 1 },
}).then(reconcile);

meetingReconcileWorkflow.commit();
