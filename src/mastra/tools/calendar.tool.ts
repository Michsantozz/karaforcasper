import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recallFetch } from "@/server/recall/client";
import {
  listCalendarEvents,
  getCalendarAccessToken,
  type CalendarEvent,
} from "@/server/recall/calendars";
import { createGoogleEvent } from "@/server/recall/google-calendar";
import { getDayAvailability } from "@/server/recall/availability";
import {
  findCalendarById,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { saveBotMapping, defaultDedupKey } from "@/server/recall/bot-repository";
import { setCalendarAutoRecord } from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";
import { withUserScope } from "@/shared/db/rls";

/**
 * Tools de Calendar V2 do agente de reuniões — escopadas ao usuário da sessão.
 *
 * O dono da agenda é o usuário autenticado (better-auth). As tools resolvem a
 * sessão server-side e só operam sobre calendars que pertencem a ele — o agente
 * nunca recebe nem confia em um user_id vindo do chat.
 */

/** Resolve o user_id da sessão; lança se não autenticado (vira erro de tool). */
async function sessionUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error(
      "Usuário não autenticado. Peça para fazer login antes de usar a agenda.",
    );
  }
  return session.user.id;
}

/** Garante que o calendar pertence ao usuário; lança caso contrário. */
async function assertOwnedCalendar(
  calendarId: string,
  userId: string,
): Promise<void> {
  const mapping = await withUserScope(userId, () =>
    findCalendarById(calendarId),
  );
  if (!mapping || mapping.userId !== userId) {
    throw new Error("Calendar não encontrado para este usuário.");
  }
}

function projectEvent(e: CalendarEvent) {
  return {
    eventId: e.id,
    calendarId: e.calendar_id,
    startTime: e.start_time,
    endTime: e.end_time,
    meetingUrl: e.meeting_url,
    platform: e.meeting_platform,
    scheduledBots: e.bots?.length ?? 0,
  };
}

/** Lista os próximos eventos das agendas conectadas do usuário. */
export const listCalendarEventsTool = createTool({
  id: "list_calendar_events",
  description:
    "Lista os próximos eventos das agendas conectadas do usuário (Google/Outlook). " +
    "Mostra horário, link da reunião e quantos bots já estão agendados para cada evento. " +
    "Use para o usuário escolher em qual reunião colocar o bot.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe("Restringe a um calendar específico. Omita para todos."),
  }),
  outputSchema: z.object({
    count: z.number(),
    events: z.array(
      z.object({
        eventId: z.string(),
        calendarId: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        meetingUrl: z.string().nullable(),
        platform: z.string().nullable(),
        scheduledBots: z.number(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    let calendarIds: string[];
    if (input.calendarId) {
      await assertOwnedCalendar(input.calendarId, userId);
      calendarIds = [input.calendarId];
    } else {
      const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
      calendarIds = mappings.map((m) => m.recallCalendarId);
    }

    // Janela: de agora até +30 dias. start_time__lte evita listar eventos
    // muito distantes (recorrências longe no futuro).
    const now = new Date();
    const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const events = (
      await Promise.all(
        calendarIds.map(async (cid) => {
          const { results } = await listCalendarEvents({
            calendarId: cid,
            isDeleted: false,
            startTimeGte: now.toISOString(),
            startTimeLte: horizon.toISOString(),
          });
          return results;
        }),
      )
    ).flat();

    const projected = events
      .map(projectEvent)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return { count: projected.length, events: projected };
  },
});

/**
 * Agenda (ou atualiza) um bot para um evento da agenda. meeting_url e join_at
 * são preenchidos automaticamente pelo Recall a partir do evento.
 */
export const scheduleBotForEventTool = createTool({
  id: "schedule_bot_for_event",
  description:
    "Agenda um bot do Recall.ai para entrar automaticamente em um evento da agenda do usuário. " +
    "O link e o horário vêm do próprio evento. Chamar de novo no mesmo evento atualiza o bot. " +
    "O bot entra sem gravar; o usuário pode pedir para começar a gravar depois.",
  inputSchema: z.object({
    eventId: z.string().describe("ID do evento da agenda (de list_calendar_events)"),
    botName: z
      .string()
      .optional()
      .describe('Nome exibido na call. Default do Recall: "Meeting Notetaker".'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    scheduledBots: z.number(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    // Confirma posse: busca o evento e valida que o calendar dele é do usuário.
    const event = await recallFetch<CalendarEvent>({
      method: "GET",
      path: `v2/calendar-events/${input.eventId}/`,
    });
    await assertOwnedCalendar(event.calendar_id, userId);

    const updated = await recallFetch<CalendarEvent>({
      method: "POST",
      path: `v2/calendar-events/${input.eventId}/bot/`,
      body: {
        deduplication_key: `${userId}:${input.eventId}`,
        bot_config: {
          ...(input.botName ? { bot_name: input.botName } : {}),
        },
      },
    });

    return {
      ok: true,
      eventId: updated.id,
      scheduledBots: updated.bots?.length ?? 0,
    };
  },
});

/** Remove o bot agendado de um evento da agenda. */
export const removeBotFromEventTool = createTool({
  id: "remove_bot_from_event",
  description:
    "Remove o bot agendado de um evento da agenda do usuário (desagenda). " +
    "Use quando o usuário não quiser mais gravar aquela reunião.",
  inputSchema: z.object({
    eventId: z.string().describe("ID do evento da agenda"),
  }),
  outputSchema: z.object({ ok: z.boolean(), eventId: z.string() }),
  execute: async (input) => {
    const userId = await sessionUserId();

    const event = await recallFetch<CalendarEvent>({
      method: "GET",
      path: `v2/calendar-events/${input.eventId}/`,
    });
    await assertOwnedCalendar(event.calendar_id, userId);

    await recallFetch({
      method: "DELETE",
      path: `v2/calendar-events/${input.eventId}/bot/`,
    });
    return { ok: true, eventId: input.eventId };
  },
});

/**
 * Cria um evento no Google Calendar do usuário, com link do Meet por padrão, e
 * opcionalmente já envia um bot de gravação para esse link.
 *
 * O access token vem do Recall (que gerencia o refresh do calendar conectado),
 * então não guardamos credenciais do Google. Requer o scope calendar.events —
 * se a agenda foi conectada com o scope antigo (readonly), o usuário precisa
 * reconectar para conceder permissão de escrita.
 */
export const createCalendarEventTool = createTool({
  id: "create_calendar_event",
  description:
    "Cria uma reunião no Google Calendar do usuário (gera link do Google Meet por padrão) e, " +
    "se pedido, já envia um bot de gravação para a reunião. Requer agenda Google conectada com permissão de escrita. " +
    "Datas em ISO 8601 com fuso (ex: 2026-06-25T10:00:00-03:00).",
  inputSchema: z.object({
    summary: z.string().describe("Título da reunião"),
    startIso: z
      .string()
      .describe("Início em ISO 8601 com offset de fuso"),
    endIso: z.string().describe("Fim em ISO 8601 com offset de fuso"),
    timeZone: z
      .string()
      .optional()
      .describe('IANA tz, ex: "America/Sao_Paulo". Opcional se o ISO já tem offset.'),
    description: z.string().optional().describe("Descrição/pauta"),
    attendees: z
      .array(z.string())
      .optional()
      .describe("E-mails dos convidados"),
    withMeet: z
      .boolean()
      .optional()
      .describe("Gerar link do Google Meet. Default: true."),
    sendBot: z
      .boolean()
      .optional()
      .describe("Se true, já envia um bot de gravação para o link do Meet criado."),
    botName: z.string().optional().describe("Nome do bot na call, se sendBot."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    htmlLink: z.string(),
    meetingUrl: z.string().nullable(),
    botId: z.string().nullable(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    // Resolve um calendar Google conectado do usuário para obter o access token.
    const mappings = await withUserScope(userId, () => listCalendarsByUser(userId));
    const google = mappings.find((m) => m.platform === "google_calendar");
    if (!google) {
      throw new Error(
        "Nenhuma agenda Google conectada. Peça para o usuário conectar a agenda.",
      );
    }

    const { token } = await getCalendarAccessToken(google.recallCalendarId);

    const event = await createGoogleEvent({
      accessToken: token,
      summary: input.summary,
      startIso: input.startIso,
      endIso: input.endIso,
      timeZone: input.timeZone,
      description: input.description,
      attendees: input.attendees,
      withMeet: input.withMeet ?? true,
    });

    // Opcional: já manda um bot ad-hoc para o link do Meet recém-criado.
    let botId: string | null = null;
    if (input.sendBot && event.meetingUrl) {
      const bot = await recallFetch<{ id: string }>({
        method: "POST",
        path: "v1/bot/",
        body: {
          meeting_url: event.meetingUrl,
          ...(input.botName ? { bot_name: input.botName } : {}),
          metadata: { event_id: event.id, user_id: userId },
        },
      });
      botId = bot.id;

      // Persiste o bot com o dono (user_id) para o webhook de bot saber quem
      // notificar quando a ata ficar pronta (transcript.done). Idempotente.
      await saveBotMapping({
        dedupKey: defaultDedupKey(event.meetingUrl),
        botId: bot.id,
        meetingUrl: event.meetingUrl,
        metadata: { event_id: event.id, user_id: userId },
      });
    }

    return {
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      meetingUrl: event.meetingUrl,
      botId,
    };
  },
});

/**
 * Disponibilidade de um dia: a grade de horário comercial já classificada
 * (livre/ocupado) contra a agenda real do usuário. Espelha o que o pick_date
 * mostra no chat — útil quando o agente quer SUGERIR um horário livre em texto
 * (ex.: "amanhã você tem 09h, 11h e 15h livres") sem abrir o seletor.
 */
export const getFreeSlotsTool = createTool({
  id: "get_free_slots",
  description:
    "Retorna os horários LIVRES e OCUPADOS de um dia, cruzando o horário comercial (09:00–18:00) " +
    "com os eventos da agenda conectada do usuário. Use para sugerir horários livres em texto ou " +
    "para checar se um horário específico está disponível antes de create_calendar_event. " +
    "Se o usuário não tem agenda conectada, todos os horários (futuros) voltam como livres.",
  inputSchema: z.object({
    dateIso: z.string().describe("Dia a consultar (yyyy-mm-dd)"),
    timeZone: z
      .string()
      .optional()
      .describe('IANA tz do usuário, ex: "America/Sao_Paulo" (default). BRT.'),
  }),
  outputSchema: z.object({
    dateIso: z.string(),
    timeZone: z.string(),
    noCalendar: z.boolean(),
    freeCount: z.number(),
    slots: z.array(
      z.object({
        timeHm: z.string(),
        datetimeIso: z.string(),
        busy: z.boolean(),
        reason: z.string().optional(),
      }),
    ),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();
    const day = await getDayAvailability({
      userId,
      dateIso: input.dateIso,
      timeZone: input.timeZone || "America/Sao_Paulo",
    });
    return {
      dateIso: day.dateIso,
      timeZone: day.timeZone,
      noCalendar: day.noCalendar,
      freeCount: day.slots.filter((s) => !s.busy).length,
      slots: day.slots,
    };
  },
});

/**
 * Liga/desliga a gravação AUTOMÁTICA de uma agenda (opt-in). Quando ligada, o
 * app agenda bots sozinho nos próximos eventos com link de reunião — via webhook
 * de sync e um cron de varredura. É consentimento explícito do usuário: sem isso
 * o app nunca grava reuniões automaticamente.
 */
export const setCalendarAutoRecordTool = createTool({
  id: "set_calendar_auto_record",
  description:
    "Liga ou desliga a gravação automática de uma agenda conectada do usuário. " +
    "Quando ligada, o app envia bots sozinho para os próximos eventos com link de reunião. " +
    "Use quando o usuário pedir para 'gravar todas as reuniões' de uma agenda, ou parar.",
  inputSchema: z.object({
    calendarId: z
      .string()
      .optional()
      .describe("Calendar a configurar. Omita para aplicar a todas as agendas do usuário."),
    enabled: z.boolean().describe("true = liga a gravação automática; false = desliga."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    enabled: z.boolean(),
    calendars: z.number(),
  }),
  execute: async (input) => {
    const userId = await sessionUserId();

    let calendarIds: string[];
    if (input.calendarId) {
      await assertOwnedCalendar(input.calendarId, userId);
      calendarIds = [input.calendarId];
    } else {
      const mappings = await withUserScope(userId, () =>
        listCalendarsByUser(userId),
      );
      calendarIds = mappings.map((m) => m.recallCalendarId);
    }

    await withUserScope(userId, async () => {
      for (const cid of calendarIds) {
        await setCalendarAutoRecord(cid, input.enabled);
      }
    });

    return { ok: true, enabled: input.enabled, calendars: calendarIds.length };
  },
});
