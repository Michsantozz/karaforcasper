import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Manutenção periódica do multisig SaaS (sem humano no loop):
 *  1. expira requests pending|ready cujo prazo passou (sweep proativo);
 *  2. reconcilia requests "broadcast" contra a rede → promove a "confirmed";
 *  3. limpa nonces de prova de posse expirados.
 *
 * Roda a cada 15 min. Substitui a expiração lazy (que só acontecia quando alguém
 * tentava assinar) por um job determinístico.
 */
const maintenance = createStep({
  id: "multisig-maintenance",
  inputSchema: z.object({}),
  outputSchema: z.object({
    expired: z.number(),
    reconciled: z.number(),
  }),
  execute: async () => {
    const {
      sweepExpiredRequests,
      listBroadcastRequestIds,
      reconcileBroadcastStatus,
    } = await import("@/server/casper/signature-request");
    const { sweepExpiredNonces } = await import("@/server/casper/user-wallets");

    const expired = await sweepExpiredRequests();

    const ids = await listBroadcastRequestIds();
    let reconciled = 0;
    for (const id of ids) {
      const status = await reconcileBroadcastStatus(id);
      if (status === "confirmed") reconciled++;
    }

    await sweepExpiredNonces();

    return { expired, reconciled };
  },
});

export const multisigMaintenanceWorkflow = createWorkflow({
  id: "multisig-maintenance",
  inputSchema: z.object({}),
  outputSchema: z.object({
    expired: z.number(),
    reconciled: z.number(),
  }),
  cron: "*/15 * * * *",
}).then(maintenance);

multisigMaintenanceWorkflow.commit();
