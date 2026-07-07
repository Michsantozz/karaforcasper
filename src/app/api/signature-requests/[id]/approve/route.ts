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
 * Anexa UMA assinatura a uma solicitação. Aberto (o signatário pode assinar via
 * link sem conta); se houver sessão, registra signedByUserId. A lib valida que o
 * signatário é exigido, que não expirou, que a assinatura é criptograficamente
 * válida, e idempotência. Quando o quórum é atingido, notifica o criador.
 */

// Erros estáveis da lib → status HTTP.
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

  // Sessão é opcional (assinatura via link). Se logado, vincula o user.
  const session = await getSession();

  try {
    const state = await addApproval({
      requestId: id,
      signerPublicKeyHex: body.signerPublicKeyHex,
      signatureHex: body.signatureHex,
      signedByUserId: session?.user?.id ?? null,
    });

    // Atingiu o quórum agora → avisa o criador que está pronta para broadcast.
    if (state.ready && state.request.status === "ready") {
      const request = await getSignatureRequest(id);
      if (request) {
        await createNotification({
          userId: request.createdByUserId,
          type: "request_ready",
          message: "Quórum atingido — a transação está pronta para broadcast.",
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
