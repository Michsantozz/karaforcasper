import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { markNotificationRead } from "@/server/casper/notifications";

/** Marca uma notificação como lida (restrito ao dono). */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  await markNotificationRead(id, session.user.id);
  return NextResponse.json({ ok: true });
}
