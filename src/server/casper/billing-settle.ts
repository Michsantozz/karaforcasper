import "server-only";
import { randomUUID } from "node:crypto";
import { NativeTransferBuilder, PublicKey } from "casper-js-sdk";
import { CHAIN_NAME, getRpc, getAgentKey, getAgentPublicKeyHex } from "./client";
import { hashToTransferId } from "./meeting-notary";
import {
  hashUsageBatch,
  claimUnsettledUsage,
  releaseUsageClaim,
  reapStaleClaims,
  listUsersWithUnsettledUsage,
  markUsageSettled,
} from "./billing";
import { withSystemScope } from "@/shared/db/rls";

// Anchor = minimal self-transfer to the agent itself, carrying the batch hash
// in the transfer id. Same mechanism as meeting-notary: immutable on-chain
// proof that that set of charges existed in this state, without moving funds per minute.
const ANCHOR_AMOUNT_MOTES = "2500000000"; // 2.5 CSPR (transfer minimum)
const ANCHOR_PAYMENT_MOTES = 100_000_000; // ~0.1 CSPR gas
// A claim older than this is considered orphaned (the tick died before
// anchoring) and is released at the start of the cycle. Generous relative to
// the duration of an on-chain submission.
const STALE_CLAIM_MS = 15 * 60 * 1000; // 15 min

export interface SettleUserResult {
  userId: string;
  botIds: string[];
  batchHash: string;
  transactionHash: string;
  explorerUrl: string;
}

/**
 * Anchors ONE user's unsettled usage on-chain: aggregates the debits,
 * computes the batch's deterministic hash, submits a transfer with the id
 * derived from the hash, and marks the rows as settled with the txHash.
 * Idempotent: if there's no usage, no-op.
 */
export async function settleUserUsage(
  userId: string,
): Promise<SettleUserResult | null> {
  // Atomically claims the pending usage under system scope (short
  // transaction): the conditional UPDATE marks the rows with a claimToken
  // UNIQUE PER TICK and returns only the captured ones. Two overlapping cron
  // ticks use distinct tokens, so each debit is captured by exactly one tick —
  // never anchoring the same batch twice (double gas). The on-chain tx (slow,
  // network) runs OUTSIDE the Postgres transaction to avoid holding a pool connection.
  const claimToken = randomUUID();
  const rows = await withSystemScope(() =>
    claimUnsettledUsage(userId, claimToken),
  );
  if (rows.length === 0) return null;

  const batchHash = hashUsageBatch(
    rows.map((r) => ({ botId: r.botId, costMotes: r.costMotes })),
  );
  const transferId = hashToTransferId(batchHash);

  const key = await getAgentKey();
  const notary = await getAgentPublicKeyHex();

  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .target(PublicKey.fromHex(notary)) // to itself: anchoring only
    .amount(ANCHOR_AMOUNT_MOTES)
    .id(transferId)
    .chainName(CHAIN_NAME)
    .payment(ANCHOR_PAYMENT_MOTES)
    .build();

  tx.sign(key);
  let transactionHash: string;
  try {
    const res = await getRpc().putTransaction(tx);
    transactionHash = res.transactionHash.toHex();
  } catch (err) {
    // The on-chain tx failed → release the claim for the next tick to retry.
    await withSystemScope(() =>
      releaseUsageClaim(
        rows.map((r) => r.botId),
        claimToken,
      ),
    );
    throw err;
  }

  // Finalizes the claim with the real txHash. Matches by claimToken, not by IS NULL.
  await withSystemScope(() =>
    markUsageSettled(
      rows.map((r) => r.botId),
      transactionHash,
      claimToken,
    ),
  );

  return {
    userId,
    botIds: rows.map((r) => r.botId),
    batchHash,
    transactionHash,
    explorerUrl: `https://testnet.cspr.live/deploy/${transactionHash}`,
  };
}

/**
 * Settles all users with pending usage. Called by the cron. Returns how many
 * users were anchored and how many meetings in total.
 */
export async function settleAllUsage(): Promise<{
  users: number;
  meetings: number;
}> {
  // Releases orphaned claims (previous ticks that crashed between claim and
  // anchor) before sweeping — otherwise they'd stay stuck in "claiming:*" and never settle.
  await withSystemScope(() => reapStaleClaims(STALE_CLAIM_MS));

  const userIds = await withSystemScope(() => listUsersWithUnsettledUsage());
  let users = 0;
  let meetings = 0;
  for (const userId of userIds) {
    const res = await settleUserUsage(userId).catch(() => null);
    if (res) {
      users++;
      meetings += res.botIds.length;
    }
  }
  return { users, meetings };
}
