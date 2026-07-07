import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { findBotByBotId, botOwnerUserId } from "@/server/recall/bot-repository";
import { enqueueMeetingRecord } from "@/server/recall/meeting-repository";
import { enrichMeeting } from "@/server/recall/enrich";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Webhook de BOT do Recall (status/artifact change, entregue via Svix) — canal
 * SEPARADO do webhook de calendar (../route.ts). Configurado no dashboard Recall
 * apontando para /api/webhooks/recall/bot.
 *
 * Objetivo: fechar o loop pós-reunião. Quando a transcrição fica pronta
 * (transcript.done), geramos a ATA automaticamente (summarizeMeeting) e criamos
 * uma notificação in-app para o dono do bot — que aparece no sino global e
 * leva à ata acionável (Notarizar / Multisig). É o equivalente ao "push" do
 * Fireflies: o usuário não precisa voltar e pedir o resumo.
 *
 * Segurança: mesma verificação Svix do webhook de calendar (HMAC-SHA256 +
 * timing-safe + janela anti-replay). Exige o corpo CRU (req.text()).
 */

type BotBase = {
  data: { bot?: { id?: string; metadata?: Record<string, unknown> } };
};
type TranscriptDone = BotBase & { event: "transcript.done" };
type BotDone = BotBase & { event: "bot.done" };
type BotWebhook = TranscriptDone | BotDone | { event: string; data: unknown };

export async function POST(req: Request) {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    // Fail-closed: sem secret não há como autenticar a origem.
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
  }

  const rawBody = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  let payload: BotWebhook;
  try {
    payload = new Webhook(secret).verify(rawBody, headers) as BotWebhook;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    throw err;
  }

  try {
    // Só reagimos ao fim da transcrição — momento em que a ata pode ser gerada.
    if (payload.event !== "transcript.done") {
      return NextResponse.json({ ok: true, ignored: payload.event });
    }

    const data = payload.data as BotBase["data"];
    const botId = data.bot?.id;
    if (!botId) {
      return NextResponse.json({ ok: true, note: "no bot id" });
    }

    // Descobre o dono: metadata do payload primeiro, depois o repo (persistido
    // na criação do bot). Guardamos junto com a ata para escopo/notificação.
    const payloadUser =
      typeof data.bot?.metadata?.user_id === "string"
        ? (data.bot.metadata.user_id as string)
        : null;
    const row = await findBotByBotId(botId);
    const userId = payloadUser ?? botOwnerUserId(row);

    // ENFILEIRA a ata (idempotente) em vez de gerá-la síncrono aqui. A geração
    // vive no worker durável (enrichMeeting) — com retry via cron de reconcile
    // se falhar. Persistimos em meeting_records para não re-buscar do Recall
    // (que expira) nem re-pagar o LLM a cada leitura.
    await withSystemScope(() =>
      enqueueMeetingRecord({
        botId,
        userId,
        meetingUrl: row?.meetingUrl ?? null,
      }),
    );

    // Dispara o enrichment best-effort no caminho feliz (baixa latência). Se
    // falhar/estiver processando, NÃO retornamos 5xx: a linha fica pending e o
    // cron de reconciliação a reprocessa — o webhook não precisa reentregar.
    const result = await enrichMeeting(botId).catch((err) => ({
      state: "processing" as const,
      error: err instanceof Error ? err.message : "unknown",
    }));

    return NextResponse.json({ ok: true, botId, enrich: result.state });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // 5xx faz o Svix reentregar (útil se o enqueue falhar transitoriamente).
    return NextResponse.json(
      { error: "bot webhook processing failed", detail: message },
      { status: 500 },
    );
  }
}
