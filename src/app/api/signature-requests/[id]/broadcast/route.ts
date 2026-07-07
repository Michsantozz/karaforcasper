import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import {
  getSignatureRequest,
  broadcastSignatureRequest,
} from "@/server/casper/signature-request";
import { createNotification } from "@/server/casper/notifications";
import { assertSameOrigin } from "@/shared/lib/http";

/**
 * Submete on-chain a tx com as approvals acumuladas. Só o CRIADOR da request
 * pode broadcast, e só quando "ready". Grava o hash e notifica o criador.
 */

const ERROR_STATUS: Record<string, number> = {
  request_not_found: 404,
  request_not_ready: 409,
  quorum_not_met: 409,
};

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

  try {
    const result = await broadcastSignatureRequest(id);
    await createNotification({
      userId: session.user.id,
      type: "request_broadcast",
      message: `Transação submetida: ${result.transactionHash}`,
      requestId: id,
    });
    return NextResponse.json({
      status: result.request.status,
      transactionHash: result.transactionHash,
      explorerUrl: result.explorerUrl,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: code },
      { status: ERROR_STATUS[code] ?? 500 },
    );
  }
}
