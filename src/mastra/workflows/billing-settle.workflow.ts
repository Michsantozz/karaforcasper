import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Periodic web3 billing settlement (no human in the loop).
 *
 * Usage is measured off-chain per meeting (fast, no gas per minute). This
 * cron aggregates usage not yet anchored per user and NOTARIZES the batch on-chain
 * (1 tx per user/cycle, id = batch hash) — an immutable, auditable proof of
 * how much was charged, with controlled gas.
 *
 * Runs every hour. If a settle tx fails, the usage remains un-settled and the
 * next tick retries — durable by construction.
 */
const settle = createStep({
  id: "billing-settle",
  inputSchema: z.object({}),
  outputSchema: z.object({
    users: z.number(),
    meetings: z.number(),
  }),
  execute: async () => {
    const { settleAllUsage } = await import("@/server/casper/billing-settle");
    return settleAllUsage();
  },
});

export const billingSettleWorkflow = createWorkflow({
  id: "billing-settle",
  inputSchema: z.object({}),
  outputSchema: z.object({
    users: z.number(),
    meetings: z.number(),
  }),
  cron: "0 * * * *",
}).then(settle);

billingSettleWorkflow.commit();
