import { NextResponse } from "next/server";
import { Webhook, WebhookVerificationError } from "svix";
import { findBotByBotId, botOwnerUserId } from "@/server/recall/bot-repository";
import { enqueueMeetingRecord } from "@/server/recall/meeting-repository";
import { enrichMeeting } from "@/server/recall/enrich";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Recall BOT webhook (status/artifact change, delivered via Svix) — channel
 * SEPARATE from the calendar webhook (../route.ts). Configured in the Recall
 * dashboard pointing to /api/webhooks/recall/bot.
 *
 * Goal: close the loop after the meeting. When the transcript is ready
 * (transcript.done), we auto-generate the MINUTES (summarizeMeeting) and create
 * an in-app notification for the bot owner — which shows up in the global bell
 * and leads to the actionable minutes (Notarize / Multisig). It's the
 * equivalent of Fireflies' "push": the user doesn't need to come back and ask
 * for the summary.
 *
 * Security: same Svix verification as the calendar webhook (HMAC-SHA256 +
 * timing-safe + anti-replay window). Requires the RAW body (req.text()).
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
    // Fail-closed: without a secret there's no way to authenticate the origin.
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
    // Only react to the end of the transcript — the moment the minutes can be generated.
    if (payload.event !== "transcript.done") {
      return NextResponse.json({ ok: true, ignored: payload.event });
    }

    const data = payload.data as BotBase["data"];
    const botId = data.bot?.id;
    if (!botId) {
      return NextResponse.json({ ok: true, note: "no bot id" });
    }

    // Resolve the owner: payload metadata first, then the repo (persisted
    // at bot creation). We store it alongside the minutes for scope/notification.
    const payloadUser =
      typeof data.bot?.metadata?.user_id === "string"
        ? (data.bot.metadata.user_id as string)
        : null;
    const row = await findBotByBotId(botId);
    const userId = payloadUser ?? botOwnerUserId(row);

    // ENQUEUES the minutes (idempotent) instead of generating them synchronously
    // here. Generation lives in the durable worker (enrichMeeting) — with retry
    // via the reconcile cron if it fails. We persist to meeting_records so we
    // don't re-fetch from Recall (which expires) or re-pay the LLM on every read.
    await withSystemScope(() =>
      enqueueMeetingRecord({
        botId,
        userId,
        meetingUrl: row?.meetingUrl ?? null,
      }),
    );

    // Fires the enrichment best-effort on the happy path (low latency). If it
    // fails/is still processing, we do NOT return 5xx: the row stays pending and
    // the reconciliation cron reprocesses it — the webhook doesn't need to redeliver.
    const result = await enrichMeeting(botId).catch((err) => ({
      state: "processing" as const,
      error: err instanceof Error ? err.message : "unknown",
    }));

    return NextResponse.json({ ok: true, botId, enrich: result.state });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // 5xx makes Svix redeliver (useful if the enqueue fails transiently).
    return NextResponse.json(
      { error: "bot webhook processing failed", detail: message },
      { status: 500 },
    );
  }
}
