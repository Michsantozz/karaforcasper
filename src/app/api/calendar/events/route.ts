import { NextResponse } from "next/server";
import { listCalendarEvents } from "@/server/recall/calendars";
import {
  findCalendarById,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";

/**
 * Lista eventos das agendas conectadas do usuário autenticado.
 *
 * Query opcional `calendar_id` restringe a um calendar específico (que deve
 * pertencer ao usuário). Sem ele, agrega todos os calendars do usuário.
 *
 * Filtra `is_deleted=false` (Recall mantém eventos deletados como histórico;
 * pra exibir ao usuário, só os vivos). Retorna campos enxutos pra UI.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const url = new URL(req.url);
  const calendarId = url.searchParams.get("calendar_id");

  try {
    // Resolve os calendars a consultar — sempre escopados ao usuário da sessão.
    let calendarIds: string[];
    if (calendarId) {
      const mapping = await findCalendarById(calendarId);
      if (!mapping || mapping.userId !== userId) {
        return NextResponse.json({ error: "unknown calendar" }, { status: 404 });
      }
      calendarIds = [calendarId];
    } else {
      const mappings = await listCalendarsByUser(userId);
      calendarIds = mappings.map((m) => m.recallCalendarId);
    }

    // Lista eventos de cada calendar (1ª página). Pagina via `next` se precisar.
    const events = (
      await Promise.all(
        calendarIds.map(async (cid) => {
          const { results } = await listCalendarEvents({
            calendarId: cid,
            isDeleted: false,
            startTimeGte: new Date().toISOString(), // só futuros
          });
          return results;
        }),
      )
    ).flat();

    // Projeta o necessário pra UI.
    const projected = events
      .map((e) => ({
        id: e.id,
        calendarId: e.calendar_id,
        startTime: e.start_time,
        endTime: e.end_time,
        meetingUrl: e.meeting_url,
        platform: e.meeting_platform,
        scheduledBots: e.bots?.length ?? 0,
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return NextResponse.json({ count: projected.length, events: projected });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "list events failed", detail: message },
      { status: 502 },
    );
  }
}
