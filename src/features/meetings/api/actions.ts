"use server";

import { requireUserId } from "@/features/auth/model/session";
import { assertBotOwner } from "@/server/recall/ownership";
import {
  requeueMeetingRecord,
  enableMeetingShare,
  disableMeetingShare,
} from "@/server/recall/meeting-repository";
import { enrichMeeting } from "@/server/recall/enrich";
import {
  findBotByBotId,
  deleteBotMapping,
} from "@/server/recall/bot-repository";
import { recallFetch } from "@/server/recall/client";
import {
  generateBehaviorInsight,
  type BehaviorInsight,
  type BehaviorMomentInput,
  type BehaviorMetricsInput,
} from "@/server/recall/behavior-insight";
import {
  generateScreenInsight,
  type ScreenInsight,
  type ScreenFrameInput,
} from "@/server/recall/screen-insight";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { withUserScope } from "@/shared/db/rls";

/**
 * Recovery actions for the meetings list — the domain's write bridge (Server
 * Actions per the architecture: client UI calls these, they touch server/*).
 * Both re-derive the userId from the session and assert bot ownership before
 * acting, so a client can never recover/cancel another tenant's meeting.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Re-runs enrichment for a FAILED meeting: requeues the record (pending) and
 * kicks the durable worker again. Ownership-checked. Used by the "reprocess"
 * button on a failed row.
 */
export async function reprocessMeeting(botId: string): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  // Requeue under the caller's scope (meeting_records is RLS-scoped), then let
  // the worker regenerate the minutes (it opens its own system scope per step).
  await withUserScope(userId, () =>
    requeueMeetingRecord(botId, "manual reprocess"),
  );
  const res = await enrichMeeting(botId);
  if (res.state === "failed") return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * Cancels a SCHEDULED bot before it joins: DELETEs it on Recall and clears the
 * local dedup mapping. Ownership-checked. Used by the "cancel" button on a
 * scheduled row.
 */
export async function cancelScheduledMeeting(
  botId: string,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  const bot = await findBotByBotId(botId);
  try {
    await recallFetch({ method: "DELETE", path: `v1/bot/${botId}/` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, error: `could not cancel: ${message}` };
  }
  // Clear the mapping so it stops showing as scheduled (best-effort).
  if (bot?.dedupKey) await deleteBotMapping(bot.dedupKey);
  return { ok: true };
}

/** Result of a share toggle: the token (null once revoked) so the UI builds the link. */
export type ShareResult =
  | { ok: true; shareToken: string | null }
  | { ok: false; error: string };

/**
 * Enables or revokes the meeting's public share link. Ownership-checked and
 * RLS-scoped, so a client can never share/unshare another tenant's meeting.
 * Used by the Share control in the notebook header.
 */
export async function setMeetingShare(
  botId: string,
  enabled: boolean,
): Promise<ShareResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  if (!enabled) {
    await withUserScope(userId, () => disableMeetingShare(botId));
    return { ok: true, shareToken: null };
  }
  const state = await withUserScope(userId, () => enableMeetingShare(botId));
  if (!state) return { ok: false, error: "not found or not accessible" };
  return { ok: true, shareToken: state.shareToken };
}

/** Result of a behavioral-insight run: the LLM read (null when nothing tense). */
export type BehaviorResult =
  | { ok: true; insight: BehaviorInsight | null }
  | { ok: false; error: string };

/**
 * Reads the human behavior behind the client-computed acoustic tension moments.
 * The client passes the already-fused per-moment scores + dynamics metrics (no
 * audio/video bytes) and the LLM interprets them. Ownership-checked so a client
 * can never run analysis against another tenant's meeting. Best-effort: a null
 * insight (flat meeting or LLM failure) is still `ok`. Used by the notebook's
 * "analyze tension" flow.
 */
export async function analyzeMeetingBehavior(
  botId: string,
  moments: BehaviorMomentInput[],
  metrics: BehaviorMetricsInput,
): Promise<BehaviorResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }

  try {
    const insight = await generateBehaviorInsight(moments, metrics);
    return { ok: true, insight };
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return { ok: false, error: message };
  }
}

/** One captured frame the client uploaded, ready for vision analysis. */
export type ScreenFrameArg = {
  url: string;
  atSeconds: number;
  trigger: ScreenFrameInput["trigger"];
};

/** Result of a screen-analysis run: the vision insight (null when unreadable). */
export type ScreenResult =
  | { ok: true; insight: ScreenInsight | null }
  | { ok: false; error: string };

/** Seconds of transcript on each side of a frame to give the vision model. */
const SCREEN_EXCERPT_WINDOW = 15;

/**
 * Reads the content of shared-screen frames with the vision model. The client
 * captures + uploads frames in-browser (mediabunny → /api/upload) and passes
 * their URLs here; this fetches the meeting's transcript under the caller's scope
 * to build a grounding excerpt per frame, then runs vision. Ownership-checked so
 * a client can never analyze another tenant's meeting. Best-effort: a null
 * insight (unreadable frames / model failure) is still `ok`. Used by the
 * notebook's "analyze screens" flow.
 */
export async function analyzeMeetingScreens(
  botId: string,
  frames: ScreenFrameArg[],
): Promise<ScreenResult> {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return { ok: false, error: "unauthenticated" };
  }
  if (!(await isOwner(botId, userId))) {
    return { ok: false, error: "not found or not accessible" };
  }
  if (frames.length === 0) return { ok: true, insight: null };

  try {
    // Transcript read under the caller's scope (meeting_records is RLS-scoped),
    // to build a grounding excerpt around each frame's moment.
    const detail = await withUserScope(userId, () => getMeetingDetail(botId));
    const lines = detail.transcript
      .map((u) => ({
        start: u.words.find((w) => w.start != null)?.start ?? null,
        text: `${u.speaker}: ${u.words.map((w) => w.text).join(" ")}`.trim(),
      }))
      .filter((l): l is { start: number; text: string } => l.start != null);

    const excerptAround = (at: number): string =>
      lines
        .filter(
          (l) => l.start >= at - SCREEN_EXCERPT_WINDOW && l.start <= at + SCREEN_EXCERPT_WINDOW,
        )
        .map((l) => l.text)
        .join("\n");

    const frameInputs: ScreenFrameInput[] = frames.map((f) => ({
      url: f.url,
      atSeconds: f.atSeconds,
      trigger: f.trigger,
      excerpt: excerptAround(f.atSeconds),
    }));

    const insight = await generateScreenInsight(frameInputs);
    return { ok: true, insight };
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    return { ok: false, error: message };
  }
}

/** Ownership check that never throws (returns false on any denial). */
async function isOwner(botId: string, userId: string): Promise<boolean> {
  try {
    await assertBotOwner(botId, userId);
    return true;
  } catch {
    return false;
  }
}
