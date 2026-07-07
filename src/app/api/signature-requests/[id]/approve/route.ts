import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/features/auth/model/session";
import {
  addApproval,
  getSignatureRequest,
} from "@/server/casper/signature-request";
import { createNotification } from "@/server/casper/notifications";
import {
  assertSameOrigin,
  parseBody,
  publicKeyHexSchema,
  signatureHexSchema,
} from "@/shared/lib/http";

/**
 * Attaches ONE signature to a request. Open endpoint (the signer can sign via
 * link without an account); if there's a session, records signedByUserId. The lib
 * validates that the signer is required, that it hasn't expired, that the signature
 * is cryptographically valid, and idempotency. When the quorum is reached, notifies
 * the creator.
 */

// Stable lib errors → HTTP status.
const ERROR_STATUS: Record<string, number> = {
  request_not_found: 404,
  request_not_collectable: 409,
  request_expired: 410,
  signer_not_required: 403,
  invalid_signature: 422,
};

const approveSchema = z.object({
  signerPublicKeyHex: publicKeyHexSchema,
  signatureHex: signatureHexSchema,
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const { id } = await params;

  const { data: body, response } = await parseBody(req, approveSchema);
  if (response) return response;

  // Session is optional (signing via link). If logged in, links the user.
  const session = await getSession();

  try {
    const state = await addApproval({
      requestId: id,
      signerPublicKeyHex: body.signerPublicKeyHex,
      signatureHex: body.signatureHex,
      signedByUserId: session?.user?.id ?? null,
    });

    // Quorum reached now → notifies the creator that it's ready for broadcast.
    if (state.ready && state.request.status === "ready") {
      const request = await getSignatureRequest(id);
      if (request) {
        await createNotification({
          userId: request.createdByUserId,
          type: "request_ready",
          message: "Quorum reached — the transaction is ready for broadcast.",
          requestId: request.id,
        });
      }
    }

    return NextResponse.json({
      status: state.request.status,
      signed: state.signed,
      pending: state.pending,
      ready: state.ready,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: code },
      { status: ERROR_STATUS[code] ?? 400 },
    );
  }
}
