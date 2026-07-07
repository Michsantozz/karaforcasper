import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Settlement periódico do billing web3 (sem humano no loop).
 *
 * O uso é medido off-chain a cada reunião (rápido, sem gas por minuto). Este
 * cron agrega o uso ainda não ancorado por usuário e NOTARIZA o batch on-chain
 * (1 tx por usuário/ciclo, id = hash do batch) — prova imutável e auditável de
 * quanto foi cobrado, com gas controlado.
 *
 * Roda a cada hora. Se uma tx de settle falha, o uso continua não-settled e o
 * próximo tick retenta — durável por construção.
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
