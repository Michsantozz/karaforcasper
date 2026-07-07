import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { getMeetingDetail } from "@/server/recall/meeting-detail";
import { withUserScope } from "@/shared/db/rls";

/**
 * Detalhe de uma reunião (ata + transcrição com timestamps + vídeo) para a UI
 * de player/karaoke. Escopado ao usuário: o meeting_records é tenant (RLS), então
 * a leitura roda sob withUserScope — só retorna a ata se for do usuário.
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

  // Sem ata persistida do usuário: 404 (não vaza reunião de outro).
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
