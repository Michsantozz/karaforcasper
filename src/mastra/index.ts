import { Mastra } from "@mastra/core";
import { assistantAgent } from "./agents/assistant.agent";
import { meetingReconcileWorkflow } from "./workflows/meeting-reconcile.workflow";
import { meetingEnrichWorkflow } from "./workflows/meeting-enrich.workflow";
import { autoScheduleWorkflow } from "./workflows/auto-schedule.workflow";
import { getMastraStore } from "./storage";

export const mastra = new Mastra({
  // assistantAgent is the unified meeting agent (Recall.ai + calendar).
  agents: { assistantAgent },
  workflows: {
    meetingReconcileWorkflow,
    meetingEnrichWorkflow,
    autoScheduleWorkflow,
  },
  // Persists traces, telemetry and workflow state in the app's PG (schema
  // `mastra`). Without this the cron would run stateless.
  storage: getMastraStore(),
});
