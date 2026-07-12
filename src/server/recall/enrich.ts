import "server-only";
import { summarizeMeeting } from "@/server/recall/summarize";
import {
  claimMeetingRecord,
  completeMeetingRecord,
  enqueueMeetingRecord,
  failMeetingRecord,
  findMeetingRecord,
  listStuckMeetingRecords,
  requeueMeetingRecord,
} from "@/server/recall/meeting-repository";
import { captureMeetingMedia } from "@/server/recall/media";
import { fetchScreenshareSpans } from "@/server/recall/screenshare";
import { computeMeetingDynamics } from "@/server/recall/dynamics";
import { generateMeetingHealthInsight } from "@/server/recall/dynamics-insight";
import { botOwnerUserId, findBotByBotId } from "@/server/recall/bot-repository";
import { createNotification } from "@/server/notifications";
import { emailMeetingSummaryReady } from "@/server/email";
import { withSystemScope } from "@/shared/db/rls";
import { createLogger } from "@/shared/lib/logger";

const log = createLogger("enrich");

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

  // Resolve the effective owner: the row's userId, or — if the row was enqueued
  // ownerless (webhook had no metadata.user_id and no recall_bots row yet) — the
  // owner recorded on the bot mapping. Persisting this on the `done` write
  // BACKFILLS orphan rows: without it, an ownerless meeting is enriched (LLM
  // paid) and then hidden from every user by RLS forever. Falls back to
  // claimed.userId (may still be null → row stays orphan, warned by notifyOwner).
  const ownerUserId =
    claimed.userId ?? botOwnerUserId(await findBotByBotId(botId));

  try {
    const summary = await summarizeMeeting(botId);

    if (summary.state === "processing") {
      // Transcript still not ready. `claimMeetingRecord` already bumped attempts
      // for THIS pass, so claimed.attempts reflects the current try. If we've hit
      // the ceiling, stop retrying: a transcript that never became ready after
      // MAX_ATTEMPTS is a terminal failure — otherwise the reconcile cron would
      // re-claim it forever (pending→processing→pending), bumping attempts
      // unbounded and never surfacing to the owner. Below the ceiling, requeue
      // so the cron retries.
      if (claimed.attempts >= MAX_ATTEMPTS) {
        await withSystemScope(() =>
          failMeetingRecord(botId, "transcript never became ready (max attempts)"),
        );
        await notifyMeetingFailed(
          botId,
          ownerUserId,
          "transcript never became ready",
        );
        return { state: "failed", error: "transcript never became ready" };
      }
      await withSystemScope(() =>
        requeueMeetingRecord(botId, "transcript still processing"),
      );
      return { state: "processing" };
    }
    if (summary.state !== "ready" || !summary.summary) {
      await withSystemScope(() =>
        failMeetingRecord(botId, "empty or unavailable transcript"),
      );
      // Terminal: no transcript to work with. Tell the owner instead of leaving
      // a silent failed row no one is told about.
      await notifyMeetingFailed(botId, ownerUserId, "empty transcript");
      return { state: "failed", error: "empty transcript" };
    }

    // Durable capture (word-level transcript + video → our storage) so the
    // notebook survives Recall's artifact expiry. Best-effort and OUTSIDE the
    // db transaction (network/upload); nulls if not ready or storage is off.
    const media = await captureMeetingMedia(botId, ownerUserId);

    // Screen-share timeline (when the shared screen was on) — drives Screen
    // Intelligence's frame capture. Best-effort ([] if no share / not ready).
    const screenshareSpans = await fetchScreenshareSpans(botId);

    // Team-dynamics / meeting-health metrics from the word-level transcript
    // (pure timestamp math, no LLM/audio). Null when timestamps are missing.
    const dynamics = computeMeetingDynamics(media.transcriptStruct);
    // One Fireworks call turns the metrics into a manager-facing insight +
    // semantic moment labels. Best-effort — null on failure, never blocks.
    const dynamicsInsight = await generateMeetingHealthInsight(
      dynamics,
      media.transcriptStruct,
    );

    await withSystemScope(async () => {
      await completeMeetingRecord(botId, {
        userId: ownerUserId,
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
        screenshareSpans: screenshareSpans.length ? screenshareSpans : null,
        dynamics,
        dynamicsInsight,
      });
    });

    const notified = await notifyOwner(botId, ownerUserId, summary);
    return { state: "done", notified };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Ran out of attempts → permanent failed; otherwise leaves it as
    // transient failed (the reconcile cron will retry via claim).
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await withSystemScope(() =>
        failMeetingRecord(botId, `max attempts: ${message}`),
      );
      // Dead-letter: retries exhausted. Notify the owner so a meeting that
      // failed 5× doesn't just vanish from their radar.
      await notifyMeetingFailed(botId, ownerUserId, `max attempts: ${message}`);
      return { state: "failed", error: message };
    }
    await withSystemScope(() => requeueMeetingRecord(botId, message));
    return { state: "processing" };
  }
}

/**
 * Records a meeting whose TRANSCRIPT failed on Recall's side (bad audio, ASR
 * error) as a terminal `failed` row, and notifies the owner. Called by the bot
 * webhook on `transcript.failed`. Without this, a failed transcription produces
 * no `transcript.done` and thus no row at all — the meeting is invisible forever
 * (a ghost). Idempotent: enqueue is a no-op if a row already exists; we then
 * fail it. Never enriches (there is no transcript to enrich).
 */
export async function markMeetingTranscriptFailed(input: {
  botId: string;
  userId: string | null;
  meetingUrl?: string | null;
  reason: string;
}): Promise<void> {
  const { botId, userId, meetingUrl, reason } = input;
  await withSystemScope(() =>
    enqueueMeetingRecord({ botId, userId, meetingUrl }),
  );
  await withSystemScope(() => failMeetingRecord(botId, reason));
  await notifyMeetingFailed(botId, userId, reason);
}

/**
 * Notifies the owner that a meeting's minutes could NOT be produced — the
 * transcript failed on Recall, or enrichment exhausted its retries. Shared by
 * the webhook (transcript.failed) and the enrichment worker (terminal failure),
 * so a failed meeting is never a silent dead-end. Best-effort like notifyOwner.
 */
async function notifyMeetingFailed(
  botId: string,
  recordUserId: string | null,
  reason: string,
): Promise<boolean> {
  const userId = recordUserId ?? botOwnerUserId(await findBotByBotId(botId));
  if (!userId) {
    log.warn(
      { botId, reason },
      "failed meeting has no owner to notify",
    );
    return false;
  }
  await withSystemScope(() =>
    createNotification({
      userId,
      type: "meeting_failed",
      message: "We couldn't generate minutes for a meeting. Open to review.",
      link: `/meetings/${botId}`,
    }),
  );
  return true;
}

/** Notifies the minutes owner (in-app + best-effort email). */
async function notifyOwner(
  botId: string,
  recordUserId: string | null,
  summary: Awaited<ReturnType<typeof summarizeMeeting>>,
): Promise<boolean> {
  const userId =
    recordUserId ?? botOwnerUserId(await findBotByBotId(botId));
  if (!userId) {
    // Orphan minutes: enriched but ownerless → no one to notify, hidden by RLS.
    // Surface it (matching the webhook's orphan guard) so it's diagnosable
    // instead of a silent no-op after we've already paid the LLM.
    log.warn(
      { botId },
      "orphan minutes: enriched but no owner to notify",
    );
    return false;
  }

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
  // 15 min ≈ 3× the reconcile cron. MUST be ≥ claimMeetingRecord's
  // staleProcessingMs, so we never LIST a `processing` row as stuck before the
  // claim itself would consider it stealable — otherwise reconcile calls
  // enrichMeeting on a live run, which then no-ops at the claim (wasted work,
  // but not a double-enrich). Keeping the two windows aligned avoids even that.
  staleMs = 15 * 60_000,
): Promise<{ processed: number; done: number; stillPending: number }> {
  // System read (the scan crosses users). enrichMeeting opens its own
  // system scope per bot. Pass MAX_ATTEMPTS so failed rows with retry budget
  // left are rescued too (a transient failure is not a permanent dead-end).
  const botIds = await withSystemScope(() =>
    listStuckMeetingRecords(staleMs, MAX_ATTEMPTS),
  );
  let done = 0;
  let stillPending = 0;
  for (const botId of botIds) {
    const res = await enrichMeeting(botId);
    if (res.state === "done") done++;
    else if (res.state === "processing") stillPending++;
  }
  return { processed: botIds.length, done, stillPending };
}
