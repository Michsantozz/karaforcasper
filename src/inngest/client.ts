import { Inngest } from "inngest";
import { init } from "@mastra/inngest";

// Cliente Inngest — orquestra o loop autônomo do agente.
// Em dev: aponta para o inngest-cli local (pnpm dev:inngest).
export const inngest = new Inngest({
  id: "casperagent",
  baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
  isDev: (process.env.INNGEST_DEV ?? "true") === "true",
});

// init() devolve createWorkflow/createStep cron-aware ligados a este Inngest.
// Use ESTES (não os de @mastra/core) nos workflows que rodam em schedule.
export const { createWorkflow, createStep } = init(inngest);
