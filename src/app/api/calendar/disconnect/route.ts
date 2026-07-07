import { NextResponse } from "next/server";
import { recallFetch } from "@/server/recall/client";
import {
  findCalendarById,
  deleteCalendarMapping,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";

/**
 * Desconecta a(s) agenda(s) do usuário autenticado.
 *
 * Body opcional `{ calendarId }` desconecta um calendar específico (que deve
 * pertencer ao usuário). Sem ele, desconecta todos os calendars do usuário.
 * Deleta no Recall (DELETE /v2/calendars/{id}) e remove o vínculo no DB.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}) as { calendarId?: string });
  const calendarId = (body as { calendarId?: string }).calendarId;

  // Resolve quais calendars desconectar — sempre escopado ao usuário.
  let targets: string[];
  if (calendarId) {
    const mapping = await findCalendarById(calendarId);
    if (!mapping || mapping.userId !== userId) {
      return NextResponse.json({ error: "unknown calendar" }, { status: 404 });
    }
    targets = [calendarId];
  } else {
    const mappings = await listCalendarsByUser(userId);
    targets = mappings.map((m) => m.recallCalendarId);
  }

  let removed = 0;
  for (const id of targets) {
    try {
      await recallFetch({ method: "DELETE", path: `v2/calendars/${id}/` });
    } catch {
      // Mesmo que o Recall já tenha removido, limpamos o vínculo local.
    }
    await deleteCalendarMapping(id);
    removed += 1;
  }

  return NextResponse.json({ ok: true, removed });
}
