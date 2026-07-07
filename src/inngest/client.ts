import { Inngest } from "inngest";
import { init } from "@mastra/inngest";

// Inngest client — orchestrates the agent's autonomous loop.
// In dev: points to the local inngest-cli (pnpm dev:inngest).
export const inngest = new Inngest({
  id: "casperagent",
  baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
  isDev: (process.env.INNGEST_DEV ?? "true") === "true",
});

// init() returns cron-aware createWorkflow/createStep bound to this Inngest.
// Use THESE (not the ones from @mastra/core) in workflows that run on a schedule.
export const { createWorkflow, createStep } = init(inngest);
