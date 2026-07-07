import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { createWalletLinkNonce } from "@/server/casper/user-wallets";
import { assertSameOrigin } from "@/shared/lib/http";

/**
 * Issues a nonce for the user to PROVE possession of a wallet before linking it.
 * The client signs this nonce (signMessage) and sends the signature to POST
 * /api/user-wallets, which verifies it cryptographically before recording it.
 */
export async function POST() {
  const csrf = await assertSameOrigin();
  if (csrf) return csrf;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const nonce = await createWalletLinkNonce(session.user.id);
  return NextResponse.json({ nonce });
}
