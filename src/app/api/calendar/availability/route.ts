import { NextResponse } from "next/server";
import { getDayAvailability } from "@/server/recall/availability";
import { getSession } from "@/features/auth/model/session";

/**
 * Availability for a single DAY for the authenticated user — the business-hours
 * grid already classified (free/busy) against the real calendar.
 *
 * Consumed by PickDateToolUI (client): the UI can't import `server/`, so it
 * fetches here. Query: `date` (yyyy-mm-dd, required) and `tz` (IANA, optional —
 * defaults to America/Sao_Paulo).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dateIso = url.searchParams.get("date");
  const timeZone = url.searchParams.get("tz") || "America/Sao_Paulo";

  if (!dateIso || !DATE_RE.test(dateIso)) {
    return NextResponse.json(
      { error: "bad date", detail: "expected ?date=yyyy-mm-dd" },
      { status: 400 },
    );
  }
  // Validate the IANA tz early — an invalid tz would blow up inside Intl.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return NextResponse.json({ error: "bad timezone" }, { status: 400 });
  }

  try {
    const day = await getDayAvailability({
      userId: session.user.id,
      dateIso,
      timeZone,
    });
    return NextResponse.json(day);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "availability failed", detail: message },
      { status: 502 },
    );
  }
}
