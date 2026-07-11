import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import {
  listMeetingRecordsPage,
  isMeetingStatus,
} from "@/server/recall/meeting-repository";
import { listUpcomingBotsForUser } from "@/server/recall/bot-repository";
import { withUserScope } from "@/shared/db/rls";

/**
 * Meetings index (list) for the /meetings page. Server-side searched + paginated,
 * scoped to the caller. Merges two sources:
 *  - RECORDED meetings from meeting_records (RLS tenant table) — searched,
 *    status-filtered, keyset-paginated by createdAt;
 *  - UPCOMING scheduled bots from recall_bots (joinAt in the future).
 *
 * Scheduled rows are only merged on the FIRST page of an unfiltered listing
 * (no cursor, no search, no status filter) — they sort to the top there. Once
 * the user searches, filters, or pages, the response is pure recorded rows so
 * pagination stays consistent. Dedupe by botId (a scheduled bot that already
 * recorded shows once, as recorded).
 *
 * Query params: q (keyword), status (done|processing|pending|failed),
 * cursor (ISO createdAt), limit (1..100).
 *
 * Thin shell: delegates to the repositories. Detail lives at /api/meetings/[botId].
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const cursor = url.searchParams.get("cursor") || undefined;
  const rawStatus = url.searchParams.get("status") || undefined;
  const status = rawStatus && isMeetingStatus(rawStatus) ? rawStatus : undefined;
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

  // Scheduled bots belong only at the top of the first, unfiltered page.
  const isFirstUnfilteredPage = !cursor && !q && !status;

  const [page, upcoming] = await Promise.all([
    withUserScope(userId, () =>
      listMeetingRecordsPage({ query: q, status, cursor, limit }),
    ),
    isFirstUnfilteredPage
      ? listUpcomingBotsForUser(userId)
      : Promise.resolve([]),
  ]);

  const recordedIds = new Set(page.items.map((m) => m.botId));
  const scheduled = upcoming
    .filter((b) => !recordedIds.has(b.botId))
    .map((b) => ({
      botId: b.botId,
      status: "scheduled" as const,
      meetingUrl: b.meetingUrl,
      summary: null,
      participantCount: 0,
      durationSeconds: null,
      createdAt: b.joinAt.toISOString(),
      updatedAt: b.joinAt.toISOString(),
      joinAt: b.joinAt.toISOString(),
    }));

  const recordedItems = page.items.map((m) => ({ ...m, joinAt: null }));
  const meetings = [...scheduled, ...recordedItems];

  return NextResponse.json({ meetings, nextCursor: page.nextCursor });
}
