import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import {
  getSignatureRequest,
  cancelSignatureRequest,
} from "@/server/casper/signature-request";
import { assertSameOrigin } from "@/shared/lib/http";

/**
 * Cancels a request. Only the CREATOR can do this, and only while pending|ready
 * (the lib enforces the status guard). Idempotent.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const { id } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const request = await getSignatureRequest(id);
  if (!request) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (request.createdByUserId !== session.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await cancelSignatureRequest(id);
  return NextResponse.json({ ok: true });
}
