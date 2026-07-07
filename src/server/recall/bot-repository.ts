import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/shared/db";
import { recallBots, type RecallBotRow } from "@/shared/db/schema";

/**
 * Repository do mapeamento dedup_key → bot_id (fronteira capability).
 *
 * A lógica de deduplicação vive aqui, fora da tool e fora do stream/memory:
 * a tool consulta antes de criar e persiste o receipt depois.
 */

/** Retorna o bot já mapeado para um dedup_key, ou null. */
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

/** Retorna o bot pelo botId do Recall (usado pelo webhook de bot), ou null. */
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

/** Extrai o user_id dono do bot a partir da metadata persistida, se houver. */
export function botOwnerUserId(row: RecallBotRow | null): string | null {
  const uid = row?.metadata?.user_id;
  return typeof uid === "string" ? uid : null;
}

/** Persiste o mapeamento. Idempotente: no-op se o dedup_key já existe. */
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

/** Remove o mapeamento (após cancelar/remover o bot). */
export async function deleteBotMapping(dedupKey: string): Promise<void> {
  await db.delete(recallBots).where(eq(recallBots.dedupKey, dedupKey));
}

/**
 * Deriva o dedup_key padrão: um bot por instância de meeting.
 * Formato: `${joinAtIso|adhoc}-${meetingUrl}`.
 */
export function defaultDedupKey(meetingUrl: string, joinAt?: string): string {
  return `${joinAt ?? "adhoc"}-${meetingUrl}`;
}
