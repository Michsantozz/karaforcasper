import { NextResponse } from "next/server";
import {
  exchangeCode,
  fetchUserEmail,
  googleClientId,
  googleClientSecret,
} from "@/server/recall/google-oauth";
import {
  createCalendar,
  reconnectCalendar,
} from "@/server/recall/calendars";
import {
  findCalendarByEmail,
  saveCalendarMapping,
} from "@/server/recall/calendar-repository";
import { verifyOAuthState } from "@/server/recall/oauth-state";

const PLATFORM = "google_calendar" as const;

/**
 * Callback do OAuth do Google.
 *
 * Passos:
 * 1. Verifica o `state` HMAC-assinado (verifyOAuthState) e extrai o userId dele
 *    — NUNCA confia no query param cru. Bloqueia account-linking forjado.
 * 2. Troca o `code` por refresh_token + e-mail da conta.
 * 3. Dedup por (platform, e-mail): se já existe calendar desconectado,
 *    reconecta (PATCH); senão cria um novo no Recall.
 * 4. Persiste o mapa user↔calendar no nosso DB.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.json({ error: oauthError }, { status: 400 });
  }
  if (!code || !state) {
    return NextResponse.json(
      { error: "missing code or state" },
      { status: 400 },
    );
  }

  // O userId vem do state assinado e verificado — não do query param cru.
  let userId: string;
  try {
    userId = verifyOAuthState(state);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid_state";
    return NextResponse.json({ error: reason }, { status: 403 });
  }

  // webhook_url absoluto a partir da request (ou APP_URL se definido).
  // O Recall BLOQUEIA (403 request_blocked) URLs localhost/privadas. Em dev,
  // omitimos o webhook_url (o connect funciona; updates só via túnel público).
  // Pra receber webhooks, aponte APP_URL pra uma URL https pública (ex: ngrok).
  const appUrl = process.env.APP_URL ?? url.origin;
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(appUrl);
  const webhookUrl = isLocal ? undefined : `${appUrl}/api/webhooks/recall`;

  try {
    // 1. Google: code → tokens → e-mail
    const tokens = await exchangeCode(code);
    const email = await fetchUserEmail(tokens.accessToken);

    const oauth = {
      oauthClientId: googleClientId(),
      oauthClientSecret: googleClientSecret(),
      oauthRefreshToken: tokens.refreshToken,
      oauthEmail: email,
    };

    // 2. Dedup por (platform, e-mail): reconecta se já existe (refresh do token),
    // senão cria um novo. O Recall não deduplica calendars na criação.
    const existing = await findCalendarByEmail(PLATFORM, email);
    const calendar = existing
      ? await reconnectCalendar(existing.recallCalendarId, oauth)
      : await createCalendar({ platform: PLATFORM, webhookUrl, ...oauth });

    // 3. Persiste o vínculo
    await saveCalendarMapping({
      recallCalendarId: calendar.id,
      userId,
      platform: PLATFORM,
      platformEmail: calendar.platform_email ?? email,
      status: calendar.status,
    });

    // Volta pra UI do agente de reuniões, sinalizando conexão.
    return NextResponse.redirect(`${appUrl}/meetings?connected=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json(
      { error: "calendar connect failed", detail: message },
      { status: 502 },
    );
  }
}
