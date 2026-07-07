import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { withUserScope } from "@/shared/db/rls";

/**
 * Meeting detail (minutes + transcript with timestamps + video) for the
 * player/karaoke UI. Scoped to the user: meeting_records is tenant (RLS), so
 * the read runs under withUserScope — only returns the minutes if they belong to the user.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ botId: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { botId } = await params;
  const detail = await withUserScope(session.user.id, () =>
    getMeetingDetail(botId),
  );

  // No persisted minutes for the user: 404 (doesn't leak another user's meeting).
  if (!detail.record) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const r = detail.record;
  return NextResponse.json({
    botId: detail.botId,
    status: r.status,
    meetingUrl: r.meetingUrl,
    summary: r.summary,
    overview: r.overview,
    decisions: r.decisions ?? [],
    actionItems: r.actionItems ?? [],
    topics: r.topics ?? [],
    sections: r.sections ?? [],
    moments: r.moments ?? [],
    talkShares: r.talkShares ?? [],
    videoUrl: detail.videoUrl,
    transcript: detail.transcript,
    transcriptState: detail.transcriptState,
    createdAt: r.createdAt,
  });
}
