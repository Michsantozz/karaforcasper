import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { retrieveCalendar } from "@/server/recall/calendars";
import {
  findCalendarById,
  updateCalendarStatus,
} from "@/server/recall/calendar-repository";
import { autoScheduleForCalendar } from "@/server/recall/auto-schedule";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Webhook do Recall (Calendar V2, entregue via Svix).
 *
 * Dois eventos:
 * - `calendar.update`     → status mudou (ex: disconnected). Re-fetch e persiste.
 * - `calendar.sync_events`→ eventos mudaram. Re-fetch eventos e (de)agenda bots.
 *
 * Segurança: verificamos a assinatura Svix (svix-id/svix-timestamp/svix-signature)
 * com o signing secret do endpoint ANTES de confiar no corpo. `wh.verify` faz
 * HMAC-SHA256 + comparação timing-safe + janela de timestamp (anti-replay, 5min),
 * exatamente como `stripe.webhooks.constructEvent`. A verificação exige o corpo
 * CRU (req.text()) — nunca req.json(), que re-serializa e quebra a assinatura.
 */

type CalendarUpdate = {
  event: "calendar.update";
  data: { calendar_id: string };
};
type CalendarSyncEvents = {
  event: "calendar.sync_events";
  data: { calendar_id: string; last_updated_ts: string };
};
type RecallWebhook = CalendarUpdate | CalendarSyncEvents;

export async function POST(req: Request) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-closed: sem o secret não há como autenticar a origem. Recusa em vez
    // de processar corpo não confiável.
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 500 },
    );
  }

  const rawBody = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  let payload: RecallWebhook;
  try {
    payload = new Webhook(secret).verify(rawBody, headers) as RecallWebhook;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    throw err;
  }

  try {
    switch (payload.event) {
      case "calendar.update": {
        // Re-fetch para pegar o status mais recente e persistir. Tabela tenant →
        // system scope (webhook age em nome do dono do calendar).
        const calendarId = payload.data.calendar_id;
        const mapping = await withSystemScope(() =>
          findCalendarById(calendarId),
        );
        if (mapping) {
          const calendar = await retrieveCalendar(calendarId);
          await withSystemScope(() =>
            updateCalendarStatus(calendarId, calendar.status),
          );
        }
        break;
      }

      case "calendar.sync_events": {
        // Eventos mudaram. Se o calendar tem gravação automática ligada (opt-in),
        // agenda bots nos próximos eventos com meeting_url. Sem opt-in, não faz
        // nada (não gravamos reunião sem consentimento). O dedup por evento no
        // Recall garante idempotência com o cron de varredura.
        const calendarId = payload.data.calendar_id;
        const mapping = await withSystemScope(() =>
          findCalendarById(calendarId),
        );
        if (mapping && mapping.metadata?.auto_record === true) {
          await autoScheduleForCalendar({
            calendarId,
            userId: mapping.userId,
          });
        }
        break;
      }

      default:
        // Evento desconhecido — ack pra não reentregar.
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // 5xx faz o Svix reentregar. Use com cautela em erros não-transientes.
    return NextResponse.json(
      { error: "webhook processing failed", detail: message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
