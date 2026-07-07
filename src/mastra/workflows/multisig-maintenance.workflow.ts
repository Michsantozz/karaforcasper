import { z } from "zod";
import { createWorkflow, createStep } from "@/inngest/client";

/**
 * Periodic maintenance of the SaaS multisig (no human in the loop):
 *  1. expires pending|ready requests whose deadline has passed (proactive sweep);
 *  2. reconciles "broadcast" requests against the network → promotes to "confirmed";
 *  3. cleans up expired proof-of-possession nonces.
 *
 * Runs every 15 min. Replaces the lazy expiration (which only happened when someone
 * tried to sign) with a deterministic job.
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
