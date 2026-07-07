import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, like, lt } from "drizzle-orm";
import { scopedDb } from "@/shared/db/rls";
import {
  billingDeposits,
  usageLedger,
  type UsageLedgerRow,
} from "@/shared/db/schema";

/**
 * Web3 billing — prepaid ledger + on-chain anchor (capability layer).
 *
 * Balance = Σ deposits (credits, backed by on-chain tx) − Σ usage (debits).
 * Everything in MOTES (bigint) to avoid losing precision. Settle doesn't move
 * funds per minute: it NOTARIZES the usage batch on-chain (see settleUsage in the worker).
 */

export const MOTES_PER_CSPR = 1_000_000_000n;

/** Price per minute of recording, in motes. Default 0.5 CSPR/min. */
export function pricePerMinuteMotes(): bigint {
  const env = process.env.BILLING_PRICE_PER_MINUTE_CSPR;
  const cspr = env ? Number(env) : 0.5;
  return BigInt(Math.round(cspr * Number(MOTES_PER_CSPR)));
}

/** Cost of a meeting (motes) from the minutes. */
export function costForMinutes(minutes: number): bigint {
  return BigInt(Math.max(0, Math.ceil(minutes))) * pricePerMinuteMotes();
}

/** Total sum of the user's deposits (motes). */
async function totalDeposits(userId: string): Promise<bigint> {
  const rows = await scopedDb()
    .select({ amount: billingDeposits.amountMotes })
    .from(billingDeposits)
    .where(eq(billingDeposits.userId, userId));
  return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

/** Total sum of the user's usage (motes), settled or not. */
async function totalUsage(userId: string): Promise<bigint> {
  const rows = await scopedDb()
    .select({ cost: usageLedger.costMotes })
    .from(usageLedger)
    .where(eq(usageLedger.userId, userId));
  return rows.reduce((acc, r) => acc + BigInt(r.cost), 0n);
}

/** Available balance of the user in motes (can be negative if overdrawn). */
export async function balanceMotes(userId: string): Promise<bigint> {
  const [deposits, usage] = await Promise.all([
    totalDeposits(userId),
    totalUsage(userId),
  ]);
  return deposits - usage;
}

/** Balance in CSPR (string, for display). */
export async function balanceCspr(userId: string): Promise<string> {
  const motes = await balanceMotes(userId);
  return (Number(motes) / Number(MOTES_PER_CSPR)).toString();
}

/**
 * Credits a deposit. Idempotent by txHash (PK). Called after verifying the
 * on-chain tx (that the funds arrived at the app's account). Returns false if already credited.
 */
export async function creditDeposit(input: {
  txHash: string;
  userId: string;
  amountMotes: bigint;
  fromPublicKey?: string | null;
}): Promise<boolean> {
  const res = await scopedDb()
    .insert(billingDeposits)
    .values({
      txHash: input.txHash,
      userId: input.userId,
      amountMotes: input.amountMotes.toString(),
      fromPublicKey: input.fromPublicKey ?? null,
    })
    .onConflictDoNothing({ target: billingDeposits.txHash })
    .returning({ txHash: billingDeposits.txHash });
  return res.length > 0;
}

/**
 * Records the usage debit of a meeting. Idempotent by botId (PK): measuring
 * the same meeting twice doesn't double the charge.
 */
export async function recordUsage(input: {
  botId: string;
  userId: string;
  minutes: number;
}): Promise<void> {
  const cost = costForMinutes(input.minutes);
  await scopedDb()
    .insert(usageLedger)
    .values({
      botId: input.botId,
      userId: input.userId,
      minutes: Math.max(0, Math.ceil(input.minutes)),
      costMotes: cost.toString(),
    })
    .onConflictDoNothing({ target: usageLedger.botId });
}

/**
 * Balance gate: true if the user has credit for (at least) one more meeting
 * of the estimated size. Used before scheduling/creating a bot.
 */
export async function hasBalanceForMinutes(
  userId: string,
  estimatedMinutes: number,
): Promise<boolean> {
  const [balance, needed] = await Promise.all([
    balanceMotes(userId),
    Promise.resolve(costForMinutes(estimatedMinutes)),
  ]);
  return balance >= needed;
}

/** Debits not yet anchored on-chain, for a user. */
export async function listUnsettledUsage(
  userId: string,
): Promise<UsageLedgerRow[]> {
  return scopedDb()
    .select()
    .from(usageLedger)
    .where(
      and(eq(usageLedger.userId, userId), isNull(usageLedger.settledTxHash)),
    );
}

/**
 * Prefix of the optimistic settle claim. Marks a row as "being anchored by
 * this tick" before submitting the (slow) on-chain tx. Since settle runs the
 * network OUTSIDE the Postgres transaction, two overlapping cron ticks would
 * read the same unsettled rows and anchor the SAME batch twice (double gas).
 * The atomic claim solves this: the conditional UPDATE
 * (WHERE settled_tx_hash IS NULL) only captures rows nobody has taken yet,
 * so each debit is anchored by exactly one tick. It's a durable per-row lock
 * (survives a crash: an orphaned claim is cleaned up by releaseUsageClaim on
 * retry) without a session advisory lock (which would leak in the pool).
 */
export const SETTLE_CLAIM_PREFIX = "claiming:";

/**
 * Atomically claims the unsettled debits of a user for this tick. Returns
 * only the rows actually captured (those that were free). A concurrent tick
 * running at the same time captures a disjoint subset (or empty).
 * The claimToken must be unique per tick (e.g. derived from batchHash).
 */
export async function claimUnsettledUsage(
  userId: string,
  claimToken: string,
): Promise<UsageLedgerRow[]> {
  // Writes settledAt = now on the claim: serves as the lock timestamp for the
  // reaper (reapStaleClaims) to release orphaned claims left by a tick that
  // crashed between the claim and the mark. Only overwritten with the real
  // instant in markUsageSettled.
  return scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: SETTLE_CLAIM_PREFIX + claimToken, settledAt: new Date() })
    .where(
      and(eq(usageLedger.userId, userId), isNull(usageLedger.settledTxHash)),
    )
    .returning();
}

/**
 * Releases orphaned claims: rows stuck in "claiming:*" whose claim is older
 * than staleMs — a sign that the tick that claimed them died before anchoring.
 * Called at the start of each settle cycle. Resets the column to NULL so the
 * next tick captures them again. staleMs should be > the maximum expected
 * duration of an on-chain submission, so as not to steal a claim still in flight.
 */
export async function reapStaleClaims(staleMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const res = await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: null, settledAt: null })
    .where(
      and(
        like(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + "%"),
        lt(usageLedger.settledAt, cutoff),
      ),
    )
    .returning({ botId: usageLedger.botId });
  return res.length;
}

/** Releases a claim (resets the column to NULL) — used when the on-chain tx fails. */
export async function releaseUsageClaim(
  botIds: string[],
  claimToken: string,
): Promise<void> {
  if (botIds.length === 0) return;
  await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash: null })
    .where(
      and(
        eq(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + claimToken),
        inArray(usageLedger.botId, botIds),
      ),
    );
}

/** Users with unanchored usage (for the settle cron to iterate over). */
export async function listUsersWithUnsettledUsage(): Promise<string[]> {
  const rows = await scopedDb()
    .selectDistinct({ userId: usageLedger.userId })
    .from(usageLedger)
    .where(isNull(usageLedger.settledTxHash));
  return rows.map((r) => r.userId);
}

/**
 * Finalizes the debits claimed by this tick, writing the real txHash of the
 * anchor. Matches by claimToken (not by IS NULL): the rows already left NULL
 * at claim time, so only whoever holds this claim finalizes them — two ticks don't collide.
 */
export async function markUsageSettled(
  botIds: string[],
  settledTxHash: string,
  claimToken: string,
): Promise<void> {
  if (botIds.length === 0) return;
  await scopedDb()
    .update(usageLedger)
    .set({ settledTxHash, settledAt: new Date() })
    .where(
      and(
        eq(usageLedger.settledTxHash, SETTLE_CLAIM_PREFIX + claimToken),
        inArray(usageLedger.botId, botIds),
      ),
    );
}

/**
 * Deterministic hash of a usage batch — the id of the on-chain anchor. Same
 * list of (botId, cost) → same hash, regardless of order.
 */
export function hashUsageBatch(
  rows: Array<{ botId: string; costMotes: string }>,
): string {
  const canonical = JSON.stringify(
    rows
      .map((r) => ({ botId: r.botId, cost: r.costMotes }))
      .sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0)),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
