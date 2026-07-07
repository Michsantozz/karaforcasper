import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { scopedDb } from "@/shared/db/rls";
import { userCalendars, type UserCalendarRow } from "@/shared/db/schema";

/**
 * Repository do mapa user → calendar do Recall (fronteira capability).
 *
 * As rotas de OAuth consultam aqui antes de criar (dedup por e-mail+plataforma)
 * e persistem o calendar.id depois. O webhook handler atualiza o status.
 */

/** Calendar já mapeado para (platform, platformEmail), ou null. */
export async function findCalendarByEmail(
  platform: string,
  platformEmail: string,
): Promise<UserCalendarRow | null> {
  const rows = await scopedDb()
    .select()
    .from(userCalendars)
    .where(
      and(
        eq(userCalendars.platform, platform),
        eq(userCalendars.platformEmail, platformEmail),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Calendar pelo id do Recall, ou null. */
export async function findCalendarById(
  recallCalendarId: string,
): Promise<UserCalendarRow | null> {
  const rows = await scopedDb()
    .select()
    .from(userCalendars)
    .where(eq(userCalendars.recallCalendarId, recallCalendarId))
    .limit(1);
  return rows[0] ?? null;
}

/** Todos os calendars de um usuário. */
export async function listCalendarsByUser(
  userId: string,
): Promise<UserCalendarRow[]> {
  return scopedDb()
    .select()
    .from(userCalendars)
    .where(eq(userCalendars.userId, userId));
}

/**
 * Upsert do mapeamento. Idempotente por recallCalendarId (PK): em conflito,
 * atualiza vínculo do user, status e e-mail.
 */
export async function saveCalendarMapping(input: {
  recallCalendarId: string;
  userId: string;
  platform: string;
  platformEmail?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await scopedDb()
    .insert(userCalendars)
    .values({
      recallCalendarId: input.recallCalendarId,
      userId: input.userId,
      platform: input.platform,
      platformEmail: input.platformEmail ?? null,
      status: input.status ?? null,
      metadata: input.metadata,
    })
    .onConflictDoUpdate({
      target: userCalendars.recallCalendarId,
      set: {
        userId: input.userId,
        platformEmail: input.platformEmail ?? null,
        status: input.status ?? null,
        updatedAt: new Date(),
      },
    });
}

/** Atualiza só o status (usado pelo webhook handler). */
export async function updateCalendarStatus(
  recallCalendarId: string,
  status: string,
): Promise<void> {
  await scopedDb()
    .update(userCalendars)
    .set({ status, updatedAt: new Date() })
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/** Remove o mapeamento de um calendar (após desconectar no Recall). */
export async function deleteCalendarMapping(
  recallCalendarId: string,
): Promise<void> {
  await scopedDb()
    .delete(userCalendars)
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/**
 * Liga/desliga a gravação AUTOMÁTICA (opt-in) de um calendar. Quando ligado, o
 * scheduler agenda bots para os próximos eventos com meeting_url — sem consenso
 * explícito por evento. Guardado em metadata.auto_record (sem migration extra).
 */
export async function setCalendarAutoRecord(
  recallCalendarId: string,
  autoRecord: boolean,
): Promise<void> {
  await scopedDb()
    .update(userCalendars)
    .set({
      metadata: sql`coalesce(${userCalendars.metadata}, '{}'::jsonb) || ${sql.raw(
        `'{"auto_record": ${autoRecord ? "true" : "false"}}'::jsonb`,
      )}`,
      updatedAt: new Date(),
    })
    .where(eq(userCalendars.recallCalendarId, recallCalendarId));
}

/**
 * Calendars com gravação automática ligada, de TODOS os usuários. Para o cron
 * de auto-scheduling (roda sob system scope). Filtra por metadata.auto_record.
 */
export async function listAutoRecordCalendars(): Promise<UserCalendarRow[]> {
  return scopedDb()
    .select()
    .from(userCalendars)
    .where(sql`${userCalendars.metadata}->>'auto_record' = 'true'`);
}
