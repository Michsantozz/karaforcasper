import "server-only";
import { recallFetch } from "@/server/recall/client";
import { listCalendarEvents, type CalendarEvent } from "@/server/recall/calendars";
import { listAutoRecordCalendars } from "@/server/recall/calendar-repository";
import { hasBalanceForMinutes } from "@/server/casper/billing";
import { withSystemScope, withUserScope } from "@/shared/db/rls";

/**
 * Auto-scheduling de bots por agenda (opt-in).
 *
 * Para cada calendar com gravação automática ligada, agenda um bot do Recall nos
 * próximos eventos que têm meeting_url. Idempotente: o Recall deduplica pela
 * deduplication_key por evento, então rodar de novo não cria bot duplicado.
 *
 * Disparado por dois caminhos:
 *  - o webhook calendar.sync_events (reação a mudança de agenda);
 *  - o cron de varredura periódica (rede de segurança se o webhook falhar).
 */

/** Janela à frente para agendar (min). Eventos além disso ficam para depois. */
const HORIZON_MINUTES = Number(process.env.AUTO_SCHEDULE_HORIZON_MINUTES ?? 60);

/** Estimativa de duração p/ o gate de saldo (o custo real é medido depois). */
const ESTIMATED_MINUTES = Number(process.env.BILLING_ESTIMATED_MINUTES ?? 30);

export interface AutoScheduleResult {
  calendarId: string;
  scheduled: number;
  skippedNoBalance: number;
  skippedNoUrl: number;
}

/**
 * Agenda bots para os eventos próximos (com meeting_url) de UM calendar. Recebe
 * o dono para o gate de saldo e a deduplication_key. Não abre escopo de banco em
 * volta da chamada REST/gate: cada um cuida do próprio.
 */
export async function autoScheduleForCalendar(input: {
  calendarId: string;
  userId: string;
}): Promise<AutoScheduleResult> {
  const now = Date.now();
  const horizon = new Date(now + HORIZON_MINUTES * 60_000).toISOString();

  const { results } = await listCalendarEvents({
    calendarId: input.calendarId,
    isDeleted: false,
    startTimeGte: new Date(now).toISOString(),
    startTimeLte: horizon,
  });

  let scheduled = 0;
  let skippedNoBalance = 0;
  let skippedNoUrl = 0;

  for (const event of results as CalendarEvent[]) {
    if (!event.meeting_url) {
      skippedNoUrl++;
      continue;
    }
    // Já tem bot agendado neste evento? O Recall dedup por key, mas evitamos a
    // chamada quando o próprio evento já reporta bots.
    if ((event.bots?.length ?? 0) > 0) continue;

    // Gate de saldo por dono (leitura tenant, sob escopo do usuário).
    const ok = await withUserScope(input.userId, () =>
      hasBalanceForMinutes(input.userId, ESTIMATED_MINUTES),
    );
    if (!ok) {
      skippedNoBalance++;
      continue;
    }

    await recallFetch({
      method: "POST",
      path: `v2/calendar-events/${event.id}/bot/`,
      body: {
        deduplication_key: `${input.userId}:${event.id}`,
        bot_config: {
          metadata: { user_id: input.userId, auto_scheduled: "true" },
        },
      },
    });
    scheduled++;
  }

  return {
    calendarId: input.calendarId,
    scheduled,
    skippedNoBalance,
    skippedNoUrl,
  };
}

/**
 * Percorre todos os calendars com auto-record ligado e agenda bots. Chamado pelo
 * cron. Lê a lista sob system scope (cruza usuários); cada calendar agenda com o
 * próprio dono.
 */
export async function autoScheduleAll(): Promise<{
  calendars: number;
  scheduled: number;
}> {
  const calendars = await withSystemScope(() => listAutoRecordCalendars());
  let scheduled = 0;
  for (const cal of calendars) {
    const res = await autoScheduleForCalendar({
      calendarId: cal.recallCalendarId,
      userId: cal.userId,
    }).catch(() => null);
    if (res) scheduled += res.scheduled;
  }
  return { calendars: calendars.length, scheduled };
}
