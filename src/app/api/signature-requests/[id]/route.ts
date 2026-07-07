import { NextResponse } from "next/server";
import {
  getSignatureRequestState,
  decodeTransfer,
} from "@/server/casper/signature-request";

/**
 * Detalhe público de uma solicitação, para a página do link /sign/:id.
 *
 * Acessível sem login (o signatário remoto pode não ter conta) — o próprio id
 * (uuid v4 opaco) é o token de acesso. Expõe o transactionJson (o signatário
 * precisa do JSON íntegro para a carteira assinar) E o `decoded` (valor/destino
 * REAIS extraídos da tx no servidor) — para a UI mostrar o que está sendo
 * assinado sem depender só da `description` (que o criador pode falsear).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = await getSignatureRequestState(id);
  if (!state) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { request } = state;
  return NextResponse.json({
    id: request.id,
    kind: request.kind,
    description: request.description,
    status: request.status,
    chainName: request.chainName,
    threshold: request.threshold,
    requiredSigners: request.requiredSigners,
    transactionJson: request.transactionJson,
    decoded: decodeTransfer(request.transactionJson),
    transactionHash: request.transactionHash,
    expiresAt: request.expiresAt,
    signed: state.signed,
    pending: state.pending,
    ready: state.ready,
  });
}
