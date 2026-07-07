import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { recallBots, type RecallBotRow } from "@/shared/db/schema";

/**
 * Repository for the dedup_key → bot_id mapping (capability boundary).
 *
 * The deduplication logic lives here, outside the tool and outside the
 * stream/memory: the tool queries before creating and persists the receipt afterward.
 */

/** Returns the bot already mapped to a dedup_key, or null. */
export async function findBotByDedupKey(
  dedupKey: string,
): Promise<RecallBotRow | null> {
  const rows = await db
    .select()
    .from(recallBots)
    .where(eq(recallBots.dedupKey, dedupKey))
    .limit(1);
  return rows[0] ?? null;
}

/** Returns the bot by Recall botId (used by the bot webhook), or null. */
export async function findBotByBotId(
  botId: string,
): Promise<RecallBotRow | null> {
  const rows = await db
    .select()
    .from(recallBots)
    .where(eq(recallBots.botId, botId))
    .limit(1);
  return rows[0] ?? null;
}

/** Extracts the bot owner's user_id from the persisted metadata, if any. */
export function botOwnerUserId(row: RecallBotRow | null): string | null {
  const uid = row?.metadata?.user_id;
  return typeof uid === "string" ? uid : null;
}

/** Persists the mapping. Idempotent: no-op if the dedup_key already exists. */
export async function saveBotMapping(input: {
  dedupKey: string;
  botId: string;
  meetingUrl: string;
  joinAt?: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db
    .insert(recallBots)
    .values({
      dedupKey: input.dedupKey,
      botId: input.botId,
      meetingUrl: input.meetingUrl,
      joinAt: input.joinAt ?? null,
      metadata: input.metadata,
    })
    .onConflictDoNothing({ target: recallBots.dedupKey });
}

/** Removes the mapping (after canceling/removing the bot). */
export async function deleteBotMapping(dedupKey: string): Promise<void> {
  await db.delete(recallBots).where(eq(recallBots.dedupKey, dedupKey));
}

/**
 * Derives the default dedup_key: one bot per meeting instance.
 * Format: `${joinAtIso|adhoc}-${meetingUrl}`.
 */
export function defaultDedupKey(meetingUrl: string, joinAt?: string): string {
  return `${joinAt ?? "adhoc"}-${meetingUrl}`;
}
