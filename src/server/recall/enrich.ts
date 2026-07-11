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
import { captureMeetingMedia } from "@/server/recall/media";
import { botOwnerUserId, findBotByBotId } from "@/server/recall/bot-repository";
import { createNotification } from "@/server/notifications";
import { emailMeetingSummaryReady } from "@/server/email";
import { withSystemScope } from "@/shared/db/rls";

/**
 * Meeting-minutes enrichment worker — durable logic shared between:
 *  - the bot webhook (fires an immediate best-effort attempt on the happy path);
 *  - the reconciliation cron (reprocesses pending/stuck records if the webhook fails).
 *
 * Idempotent: minutes already "done" are not reprocessed; the transcript/minutes
 * are persisted in meeting_records (Recall cleans up the artifacts days later).
 */

/** Max number of attempts before marking the minutes as failed. */
const MAX_ATTEMPTS = 5;

export type EnrichResult =
  | { state: "done"; notified: boolean }
  | { state: "processing" } // transcript not ready yet — reschedule
  | { state: "skipped"; reason: string }
  | { state: "failed"; error: string };

/**
 * Processes (or reprocesses) a bot's meeting minutes: generates the structured
 * summary, persists it in meeting_records, and — the first time it becomes
 * "done" — notifies the owner.
 */
export async function enrichMeeting(botId: string): Promise<EnrichResult> {
  // Each db operation runs in its OWN system scope (short transaction).
  // The slow steps — summarizeMeeting (LLM/network) and notifyOwner (email) —
  // stay OUTSIDE any Postgres transaction, so they don't hold a pool connection.
  const existing = await withSystemScope(() => findMeetingRecord(botId));
  if (existing?.status === "done") {
    return { state: "skipped", reason: "already done" };
  }

  const claimed = await withSystemScope(() => claimMeetingRecord(botId));
  // No row (webhook hasn't enqueued yet) or already done: nothing to do here.
  if (!claimed) return { state: "skipped", reason: "no pending record" };

  try {
    const summary = await summarizeMeeting(botId);

    if (summary.state === "processing") {
      // Transcript still not ready: goes back to pending (the cron retries).
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

    // Durable capture (word-level transcript + video → our storage) so the
    // notebook survives Recall's artifact expiry. Best-effort and OUTSIDE the
    // db transaction (network/upload); nulls if not ready or storage is off.
    const media = await captureMeetingMedia(botId, claimed.userId);

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
        soundbites: summary.soundbites ?? [],
        talkShares: summary.talkShares ?? [],
        transcriptStruct: media.transcriptStruct,
        videoUrl: media.videoUrl,
      });
    });

    const notified = await notifyOwner(botId, claimed.userId, summary);
    return { state: "done", notified };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Ran out of attempts → permanent failed; otherwise leaves it as
    // transient failed (the reconcile cron will retry via claim).
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

/** Notifies the minutes owner (in-app + best-effort email). */
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
  if (decisions) parts.push(`${decisions} decision${decisions > 1 ? "s" : ""}`);
  if (tasks) parts.push(`${tasks} task${tasks > 1 ? "s" : ""}`);
  const detail = parts.length ? ` — ${parts.join(", ")}` : "";

  // notifications has RLS: create under system scope (the notification belongs to userId).
  await withSystemScope(() =>
    createNotification({
      userId,
      type: "meeting_summary_ready",
      message: `Meeting minutes ready${detail}. Open to review.`,
      // Deep link straight to this meeting's notebook.
      link: `/meetings/${botId}`,
    }),
  );
  await emailMeetingSummaryReady({ userId, detail, botId });
  return true;
}

/**
 * Sweeps stuck minutes (pending/processing past the deadline) and reprocesses
 * each one. Called by the reconciliation cron. Returns counts per outcome.
 */
export async function reconcileStuckMeetings(
  staleMs = 5 * 60_000,
): Promise<{ processed: number; done: number; stillPending: number }> {
  // System read (the scan crosses users). enrichMeeting opens its own
  // system scope per bot.
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
