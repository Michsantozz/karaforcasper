import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Auto-scheduling of bots per calendar (no human in the loop).
 *
 * The reactive path schedules via the calendar.sync_events webhook. This cron is the SAFETY
 * NET: it scans all calendars with auto-record enabled (opt-in) and schedules
 * bots for upcoming events with a meeting_url — covering missed webhooks and
 * events created outside a sync window. Idempotent (dedup per event in
 * Recall), so running it again doesn't duplicate bots.
 *
 * Runs every 10 min.
 */
const scan = createStep({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  execute: async () => {
    const { autoScheduleAll } = await import("@/server/recall/auto-schedule");
    return autoScheduleAll();
  },
});

export const autoScheduleWorkflow = createWorkflow({
  id: "auto-schedule",
  inputSchema: z.object({}),
  outputSchema: z.object({
    calendars: z.number(),
    scheduled: z.number(),
  }),
  cron: "*/10 * * * *",
}).then(scan);

autoScheduleWorkflow.commit();
