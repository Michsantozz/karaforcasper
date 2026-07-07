import { NextResponse } from "next/server";
import { buildConsentUrl } from "@/server/recall/google-oauth";
import { signOAuthState } from "@/server/recall/oauth-state";
import { getSession } from "@/features/auth/model/session";

/**
 * Inicia o OAuth do Google (conexão de agenda): redireciona ao consent screen.
 *
 * O dono da agenda é o usuário autenticado (sessão better-auth), não um query
 * param. O user_id vai no `state` HMAC-assinado (signOAuthState) e é verificado
 * no callback antes de qualquer gravação — bloqueia account-linking forjado.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.redirect(buildConsentUrl(signOAuthState(session.user.id)));
}
