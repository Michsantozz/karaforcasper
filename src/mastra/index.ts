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
  // assistantAgent é o agente unificado (reunião + on-chain + notarize +
  // multisig). casper/meeting permanecem para compatibilidade/testes.
  agents: { assistantAgent, casperAgent, meetingAgent },
  workflows: {
    autonomousWorkflow,
    multisigMaintenanceWorkflow,
    meetingReconcileWorkflow,
    billingSettleWorkflow,
    autoScheduleWorkflow,
  },
  // Persiste traces, telemetria e estado de workflows no PG do app (schema
  // `mastra`). Sem isso o loop autônomo/cron rodaria stateless.
  storage: getMastraStore(),
});
