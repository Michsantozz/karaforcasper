import { Mastra } from "@mastra/core";
import { casperAgent } from "./agents/casper.agent";
import { meetingAgent } from "./agents/meeting.agent";
import { assistantAgent } from "./agents/assistant.agent";
import { autonomousWorkflow } from "./workflows/autonomous.workflow";
import { multisigMaintenanceWorkflow } from "./workflows/multisig-maintenance.workflow";
import { meetingReconcileWorkflow } from "./workflows/meeting-reconcile.workflow";
import { billingSettleWorkflow } from "./workflows/billing-settle.workflow";
import { autoScheduleWorkflow } from "./workflows/auto-schedule.workflow";
import { getMastraStore } from "./storage";

export const mastra = new Mastra({
  // assistantAgent is the unified agent (meeting + on-chain + notarize +
  // multisig). casper/meeting remain for compatibility/tests.
  agents: { assistantAgent, casperAgent, meetingAgent },
  workflows: {
    autonomousWorkflow,
    multisigMaintenanceWorkflow,
    meetingReconcileWorkflow,
    billingSettleWorkflow,
    autoScheduleWorkflow,
  },
  // Persists traces, telemetry and workflow state in the app's PG (schema
  // `mastra`). Without this the autonomous loop/cron would run stateless.
  storage: getMastraStore(),
});
