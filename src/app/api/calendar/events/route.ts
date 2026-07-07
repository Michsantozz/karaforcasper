import { NextResponse } from "next/server";
import { listCalendarEvents } from "@/server/recall/calendars";
import {
  findCalendarById,
  listCalendarsByUser,
} from "@/server/recall/calendar-repository";
import { getSession } from "@/features/auth/model/session";

/**
 * Lists events from the authenticated user's connected calendars.
 *
 * Optional `calendar_id` query restricts to a specific calendar (which must
 * belong to the user). Without it, aggregates across all of the user's calendars.
 *
 * Filters `is_deleted=false` (Recall keeps deleted events as history; for
 * display to the user, only the live ones). Returns lean fields for the UI.
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
    // Resolve which calendars to query — always scoped to the session user.
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

    // Lists events for each calendar (1st page). Paginate via `next` if needed.
    const events = (
      await Promise.all(
        calendarIds.map(async (cid) => {
          const { results } = await listCalendarEvents({
            calendarId: cid,
            isDeleted: false,
            startTimeGte: new Date().toISOString(), // only future events
          });
          return results;
        }),
      )
    ).flat();

    // Projects only what the UI needs.
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
