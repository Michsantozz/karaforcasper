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

/** Ownership check that never throws (returns false on any denial). */
async function isOwner(botId: string, userId: string): Promise<boolean> {
  try {
    await assertBotOwner(botId, userId);
    return true;
  } catch {
    return false;
  }
}
