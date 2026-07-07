import { NextResponse } from "next/server";
import { getSession } from "@/features/auth/model/session";
import { createWalletLinkNonce } from "@/server/casper/user-wallets";
import { assertSameOrigin } from "@/shared/lib/http";

/**
 * Emite um nonce para o usuário PROVAR posse de uma carteira antes de vinculá-la.
 * O client assina este nonce (signMessage) e envia a assinatura ao POST
 * /api/user-wallets, que verifica criptograficamente antes de gravar.
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
