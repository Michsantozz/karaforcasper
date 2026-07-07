import "server-only";
import { recallFetch } from "./client";

/**
 * Operações de Calendar V2 do Recall.ai (multi-usuário).
 *
 * Fronteira capability: estas funções falam com a REST API do Recall via
 * `recallFetch`. A persistência do mapa user↔calendar vive no repository
 * (calendar-repository.ts); o OAuth do provider vive nas rotas.
 */

export type CalendarPlatform = "google_calendar" | "microsoft_outlook";

export type RecallCalendar = {
  id: string;
  platform: CalendarPlatform;
  platform_email: string | null;
  status: string;
  status_changes: Array<{ status: string; created_at: string }>;
  oauth_email?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type CreateCalendarInput = {
  platform: CalendarPlatform;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRefreshToken: string;
  /** E-mail da conta autorizada (ajuda o Recall a popular platform_email). */
  oauthEmail?: string;
  /** URL onde o Recall envia webhooks de update do calendar/eventos. */
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
};

/** Cria um calendar no Recall a partir do refresh_token OAuth do usuário. */
export async function createCalendar(
  input: CreateCalendarInput,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "POST",
    path: "v2/calendars/",
    body: {
      platform: input.platform,
      oauth_client_id: input.oauthClientId,
      oauth_client_secret: input.oauthClientSecret,
      oauth_refresh_token: input.oauthRefreshToken,
      oauth_email: input.oauthEmail,
      webhook_url: input.webhookUrl,
      metadata: input.metadata,
    },
  });
}

/** Atualiza o refresh_token de um calendar existente (reconexão). */
export async function reconnectCalendar(
  calendarId: string,
  input: Pick<
    CreateCalendarInput,
    "oauthClientId" | "oauthClientSecret" | "oauthRefreshToken" | "oauthEmail"
  >,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "PATCH",
    path: `v2/calendars/${calendarId}/`,
    body: {
      oauth_client_id: input.oauthClientId,
      oauth_client_secret: input.oauthClientSecret,
      oauth_refresh_token: input.oauthRefreshToken,
      oauth_email: input.oauthEmail,
    },
  });
}

/** Lista calendars do workspace, opcionalmente filtrando por e-mail/plataforma. */
export async function listCalendars(query?: {
  platformEmail?: string;
  platform?: CalendarPlatform;
}): Promise<RecallCalendar[]> {
  const res = await recallFetch<{ results: RecallCalendar[] }>({
    method: "GET",
    path: "v2/calendars/",
    query: {
      platform_email: query?.platformEmail,
      platform: query?.platform,
    },
  });
  return res.results ?? [];
}

/** Lê um calendar pelo id. */
export async function retrieveCalendar(
  calendarId: string,
): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>({
    method: "GET",
    path: `v2/calendars/${calendarId}/`,
  });
}

/**
 * Obtém um access token OAuth do Google para o calendar conectado.
 *
 * O Recall gerencia o refresh do token a partir do refresh_token que demos na
 * criação — então não precisamos guardar/renovar credenciais do Google: pedimos
 * um access token fresco aqui e usamos direto na Google Calendar API.
 */
export async function getCalendarAccessToken(
  calendarId: string,
): Promise<{ token: string; expiresAt: string }> {
  const res = await recallFetch<{ token: string; expires_at: string }>({
    method: "POST",
    path: `v2/calendars/${calendarId}/access-token/`,
  });
  return { token: res.token, expiresAt: res.expires_at };
}

export type CalendarEvent = {
  id: string;
  calendar_id: string;
  platform_id: string;
  ical_uid: string;
  start_time: string;
  end_time: string;
  is_deleted: boolean;
  /** Link da meeting extraído do evento (null se não houver). */
  meeting_url: string | null;
  meeting_platform: string | null;
  /** Bots já agendados pra este evento (vazio se nenhum). */
  bots: Array<{ bot_id: string; start_time?: string }>;
  raw: Record<string, unknown>;
};

type ListEventsQuery = {
  calendarId: string;
  /** Só eventos vivos (recomendado pra exibir ao usuário). */
  isDeleted?: boolean;
  /** ISO 8601 — eventos alterados a partir deste ts (sync incremental). */
  updatedAtGte?: string;
  /** ISO 8601 — janela de início. */
  startTimeGte?: string;
  startTimeLte?: string;
  cursor?: string;
};

/**
 * Lista eventos de um calendar (uma página).
 *
 * Endpoint usa hífen: /api/v2/calendar-events/. Para paginar, repasse `next`
 * (a URL completa) sem alterar os query params — ou use o `cursor` extraído.
 * Rate limit: 60 req/min por workspace.
 */
export async function listCalendarEvents(
  query: ListEventsQuery,
): Promise<{ results: CalendarEvent[]; next: string | null }> {
  const res = await recallFetch<{
    results: CalendarEvent[];
    next: string | null;
    previous: string | null;
  }>({
    method: "GET",
    path: "v2/calendar-events/",
    query: {
      calendar_id: query.calendarId,
      is_deleted: query.isDeleted === undefined ? undefined : String(query.isDeleted),
      updated_at__gte: query.updatedAtGte,
      start_time__gte: query.startTimeGte,
      start_time__lte: query.startTimeLte,
      cursor: query.cursor,
    },
  });
  return { results: res.results ?? [], next: res.next ?? null };
}
