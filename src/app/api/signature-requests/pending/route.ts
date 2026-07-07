import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { listWalletsByUser } from "@/server/casper/user-wallets";
import { listPendingForSigner } from "@/server/casper/signature-request";

/**
 * Requests "awaiting my signature": matches the user's linked wallets against
 * open requests where they are a required signer and haven't signed yet.
 * Feeds the /multisig dashboard tab.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const wallets = await listWalletsByUser(session.user.id);
  const states = await listPendingForSigner(
    wallets.map((w) => w.publicKeyHex),
  );

  return NextResponse.json({
    pending: states.map((s) => ({
      id: s.request.id,
      kind: s.request.kind,
      description: s.request.description,
      status: s.request.status,
      threshold: s.request.threshold,
      signedCount: s.signed.length,
      requiredCount: s.request.requiredSigners.length,
      link: `/sign/${s.request.id}`,
      createdAt: s.request.createdAt,
      expiresAt: s.request.expiresAt,
    })),
  });
}
