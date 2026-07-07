import { NextResponse } from "next/server";
import {
  getSignatureRequestState,
  decodeTransfer,
} from "@/server/casper/signature-request";

/**
 * Public detail of a request, for the /sign/:id link page.
 *
 * Accessible without login (the remote signer may not have an account) — the id
 * itself (opaque uuid v4) is the access token. Exposes the transactionJson (the
 * signer needs the full JSON for the wallet to sign) AND the `decoded` (actual
 * values extracted from the tx server-side) — so the UI can show what is being
 * signed without relying only on the `description` (which the creator could
 * falsify).
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
