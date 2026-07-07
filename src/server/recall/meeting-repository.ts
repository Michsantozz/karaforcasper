import "server-only";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { scopedDb } from "@/shared/db/rls";
import {
  meetingRecords,
  type MeetingRecordRow,
  type NewMeetingRecordRow,
} from "@/shared/db/schema";

/**
 * Repository das atas persistidas (meeting_records) — fronteira capability.
 *
 * A ata gerada pelo LLM é a fonte de verdade do app: o Recall limpa a
 * transcrição/artefatos dias após a reunião. Persistir aqui evita re-buscar do
 * Recall e re-pagar o LLM a cada leitura, e habilita o cron de reconciliação a
 * varrer atas presas em pending/processing.
 */

/** Retorna a ata persistida de um bot, ou null. */
export async function findMeetingRecord(
  botId: string,
): Promise<MeetingRecordRow | null> {
  const rows = await scopedDb()
    .select()
    .from(meetingRecords)
    .where(eq(meetingRecords.botId, botId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Enfileira uma ata (status=pending). Idempotente: se já existe, não sobrescreve
 * (o enrichment/reconcile cuidam da transição de estado). Usado pelo webhook.
 */
export async function enqueueMeetingRecord(input: {
  botId: string;
  userId?: string | null;
  meetingUrl?: string | null;
}): Promise<void> {
  await scopedDb()
    .insert(meetingRecords)
    .values({
      botId: input.botId,
      userId: input.userId ?? null,
      meetingUrl: input.meetingUrl ?? null,
      status: "pending",
    })
    .onConflictDoNothing({ target: meetingRecords.botId });
}

/**
 * Marca a ata como "processing" e incrementa attempts, mas SÓ se ainda não
 * estiver "done" — evita reprocessar uma ata já pronta. Retorna a linha travada
 * (para o worker decidir seguir) ou null se já estava done/inexistente.
 */
export async function claimMeetingRecord(
  botId: string,
): Promise<MeetingRecordRow | null> {
  const rows = await scopedDb()
    .update(meetingRecords)
    .set({
      status: "processing",
      attempts: sql`${meetingRecords.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(meetingRecords.botId, botId),
        inArray(meetingRecords.status, ["pending", "processing", "failed"]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Persiste a ata gerada e marca done. */
export async function completeMeetingRecord(
  botId: string,
  data: Omit<
    NewMeetingRecordRow,
    "botId" | "status" | "attempts" | "createdAt" | "updatedAt"
  >,
): Promise<void> {
  await scopedDb()
    .update(meetingRecords)
    .set({ ...data, status: "done", error: null, updatedAt: new Date() })
    .where(eq(meetingRecords.botId, botId));
}

/** Marca a ata como falha definitiva (após esgotar retries). */
export async function failMeetingRecord(
  botId: string,
  error: string,
): Promise<void> {
  await scopedDb()
    .update(meetingRecords)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(eq(meetingRecords.botId, botId));
}

/**
 * Volta a ata para "pending" (retry transitório: transcrição ainda processando,
 * ou erro recuperável). O cron de reconciliação a pega no próximo tick.
 */
export async function requeueMeetingRecord(
  botId: string,
  note: string,
): Promise<void> {
  await scopedDb()
    .update(meetingRecords)
    .set({ status: "pending", error: note, updatedAt: new Date() })
    .where(eq(meetingRecords.botId, botId));
}

/**
 * Retorna botIds de atas travadas para o cron de reconciliação: pending há mais
 * de `staleMs`, ou failed (para nova tentativa). Não toca em done/processing
 * recente.
 */
export async function listStuckMeetingRecords(
  staleMs: number,
): Promise<string[]> {
  const threshold = new Date(Date.now() - staleMs);
  const rows = await scopedDb()
    .select({ botId: meetingRecords.botId })
    .from(meetingRecords)
    .where(
      or(
        and(
          eq(meetingRecords.status, "pending"),
          lt(meetingRecords.updatedAt, threshold),
        ),
        and(
          eq(meetingRecords.status, "processing"),
          lt(meetingRecords.updatedAt, threshold),
        ),
      ),
    );
  return rows.map((r) => r.botId);
}
