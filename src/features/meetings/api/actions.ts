"use server";

import { requireUserId } from "@/features/auth/model/session";
import { assertBotOwner } from "@/server/recall/ownership";
import { requeueMeetingRecord } from "@/server/recall/meeting-repository";
import { enrichMeeting } from "@/server/recall/enrich";
import {
  findBotByBotId,
  deleteBotMapping,
} from "@/server/recall/bot-repository";
import { recallFetch } from "@/server/recall/client";
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

/** Ownership check that never throws (returns false on any denial). */
async function isOwner(botId: string, userId: string): Promise<boolean> {
  try {
    await assertBotOwner(botId, userId);
    return true;
  } catch {
    return false;
  }
}
