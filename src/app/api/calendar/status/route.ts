import { NextResponse } from "next/server";
import { listCalendarsByUser } from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";

/**
 * Status of the authenticated user's connected calendars.
 *
 * Used by the /meetings UI to show whether a calendar is connected and which ones.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const calendars = await listCalendarsByUser(session.user.id);
  return NextResponse.json({
    connected: calendars.length > 0,
    count: calendars.length,
    calendars: calendars.map((c) => ({
      id: c.recallCalendarId,
      platform: c.platform,
      email: c.platformEmail,
      status: c.status,
    })),
  });
}
