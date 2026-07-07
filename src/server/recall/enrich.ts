import "server-only";
import { summarizeMeeting } from "@/server/recall/summarize";
import {
  claimMeetingRecord,
  completeMeetingRecord,
  failMeetingRecord,
  findMeetingRecord,
  listStuckMeetingRecords,
  requeueMeetingRecord,
} from "@/server/recall/meeting-repository";
import { botOwnerUserId, findBotByBotId } from "@/server/recall/bot-repository";
import { createNotification } from "@/server/casper/notifications";
import { recordUsage } from "@/server/casper/billing";
import { emailMeetingSummaryReady } from "@/server/email";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Worker de enrichment de ata — lógica durável compartilhada entre:
 *  - o webhook de bot (dispara best-effort imediato no caminho feliz);
 *  - o cron de reconciliação (reprocessa pending/stuck se o webhook falhar).
 *
 * Idempotente: uma ata já "done" não é reprocessada; a transcrição/ata ficam
 * persistidas em meeting_records (o Recall limpa os artefatos dias depois).
 */

/** Nº máximo de tentativas antes de marcar a ata como failed. */
const MAX_ATTEMPTS = 5;

export type EnrichResult =
  | { state: "done"; notified: boolean }
  | { state: "processing" } // transcrição ainda não pronta — reagendar
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string };

/**
 * Processa (ou reprocessa) a ata de um bot: gera o resumo estruturado, persiste
 * em meeting_records e — na primeira vez que fica "done" — notifica o dono.
 */
export async function enrichMeeting(botId: string): Promise<EnrichResult> {
  // Cada operação de banco roda no seu PRÓPRIO system scope (transação curta).
  // As etapas lentas — summarizeMeeting (LLM/rede) e notifyOwner (e-mail) —
  // ficam FORA de qualquer transação Postgres, para não prender conexão do pool.
  const existing = await withSystemScope(() => findMeetingRecord(botId));
  if (existing?.status === "done") {
    return { state: "skipped", reason: "already done" };
  }

  const claimed = await withSystemScope(() => claimMeetingRecord(botId));
  // Sem linha (webhook ainda não enfileirou) ou já done: nada a fazer aqui.
  if (!claimed) return { state: "skipped", reason: "no pending record" };

  try {
    const summary = await summarizeMeeting(botId);

    if (summary.state === "processing") {
      // Transcrição ainda não ficou pronta: volta para pending (o cron retenta).
      await withSystemScope(() =>
        requeueMeetingRecord(botId, "transcript still processing"),
      );
      return { state: "processing" };
    }
    if (summary.state !== "ready" || !summary.summary) {
      await withSystemScope(() =>
        failMeetingRecord(botId, "empty or unavailable transcript"),
      );
      return { state: "failed", error: "empty transcript" };
    }

    await withSystemScope(async () => {
      await completeMeetingRecord(botId, {
        userId: claimed.userId,
        meetingUrl: claimed.meetingUrl,
        transcript: summary.transcriptText ?? null,
        summary: summary.summary,
        overview: summary.overview ?? null,
        decisions: summary.decisions ?? [],
        actionItems: summary.actionItems ?? [],
        topics: summary.topics ?? [],
        sections: summary.sections ?? [],
        moments: summary.moments ?? [],
        talkShares: summary.talkShares ?? [],
      });

      // Metering: debita o uso (idempotente por botId). Só há a quem cobrar se o
      // dono for conhecido; sem dono, a ata é gerada mas não faturada. Na mesma
      // transação que o complete: ata persistida ⇔ uso debitado, atomicamente.
      if (claimed.userId && typeof summary.durationMinutes === "number") {
        await recordUsage({
          botId,
          userId: claimed.userId,
          minutes: summary.durationMinutes,
        });
      }
    });

    const notified = await notifyOwner(botId, claimed.userId, summary);
    return { state: "done", notified };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Esgotou as tentativas → failed definitivo; senão deixa como failed
    // transitório (o cron de reconcile vai retentar via claim).
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await withSystemScope(() =>
        failMeetingRecord(botId, `max attempts: ${message}`),
      );
      return { state: "failed", error: message };
    }
    await withSystemScope(() => requeueMeetingRecord(botId, message));
    return { state: "processing" };
  }
}

/** Notifica o dono da ata (in-app + e-mail best-effort). */
async function notifyOwner(
  botId: string,
  recordUserId: string | null,
  summary: Awaited<ReturnType<typeof summarizeMeeting>>,
): Promise<boolean> {
  const userId =
    recordUserId ?? botOwnerUserId(await findBotByBotId(botId));
  if (!userId) return false;

  const decisions = summary.decisions?.length ?? 0;
  const tasks = summary.actionItems?.length ?? 0;
  const parts: string[] = [];
  if (decisions) parts.push(`${decisions} decisão${decisions > 1 ? "ões" : ""}`);
  if (tasks) parts.push(`${tasks} tarefa${tasks > 1 ? "s" : ""}`);
  const detail = parts.length ? ` — ${parts.join(", ")}` : "";

  // notifications tem RLS: cria sob system scope (a notificação é do userId).
  await withSystemScope(() =>
    createNotification({
      userId,
      type: "meeting_summary_ready",
      message: `Ata da reunião pronta${detail}. Abra para revisar e agir on-chain.`,
    }),
  );
  await emailMeetingSummaryReady({ userId, detail });
  return true;
}

/**
 * Varre atas presas (pending/processing além do prazo) e reprocessa cada uma.
 * Chamado pelo cron de reconciliação. Retorna contagem por resultado.
 */
export async function reconcileStuckMeetings(
  staleMs = 5 * 60_000,
): Promise<{ processed: number; done: number; stillPending: number }> {
  // Leitura de sistema (o scan cruza usuários). enrichMeeting abre o próprio
  // system scope por bot.
  const botIds = await withSystemScope(() => listStuckMeetingRecords(staleMs));
  let done = 0;
  let stillPending = 0;
  for (const botId of botIds) {
    const res = await enrichMeeting(botId);
    if (res.state === "done") done++;
    else if (res.state === "processing") stillPending++;
  }
  return { processed: botIds.length, done, stillPending };
}
