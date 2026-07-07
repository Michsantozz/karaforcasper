import { NextResponse } from "next/server";
import { recallFetch } from "@/server/recall/client";
import {
  findCalendarById,
  deleteCalendarMapping,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";

/**
 * Disconnects the authenticated user's calendar(s).
 *
 * Optional body `{ calendarId }` disconnects a specific calendar (which must
 * belong to the user). Without it, disconnects all of the user's calendars.
 * Deletes in Recall (DELETE /v2/calendars/{id}) and removes the mapping in the DB.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}) as { calendarId?: string });
  const calendarId = (body as { calendarId?: string }).calendarId;

  // Resolve which calendars to disconnect — always scoped to the user.
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
      // Even if Recall already removed it, we clean up the local mapping.
    }
    await deleteCalendarMapping(id);
    removed += 1;
  }

  return NextResponse.json({ ok: true, removed });
}
