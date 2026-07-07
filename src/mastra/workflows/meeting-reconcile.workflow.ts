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
 * Runs every 5 min. staleMs=5min: only touches rows stuck long enough,
 * avoiding a race with the enrichment triggered by the webhook.
 */
const reconcile = createStep({
  id: "meeting-reconcile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    processed: z.number(),
    done: z.number(),
    stillPending: z.number(),
  }),
  execute: async () => {
    const { reconcileStuckMeetings } = await import("@/server/recall/enrich");
    return reconcileStuckMeetings(5 * 60_000);
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
}).then(reconcile);

meetingReconcileWorkflow.commit();
