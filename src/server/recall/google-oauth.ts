import "server-only";
import { requireEnv } from "@/mastra/env";

/**
 * OAuth 2.0 do Google (authorization code flow, server-side).
 *
 * Fluxo: buildConsentUrl() → usuário autoriza → callback com `code` →
 * exchangeCode() devolve refresh_token + e-mail. O refresh_token é então
 * entregue ao Recall (createCalendar), que gerencia a renovação do access token.
 *
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Scopes do OAuth de calendar.
 *
 * `calendar.events` (read+write) permite tanto a integração do Recall (que lê
 * eventos) quanto criar eventos com link do Meet pela Google Calendar API.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleClientId(): string {
  return requireEnv("GOOGLE_CLIENT_ID");
}
export function googleClientSecret(): string {
  return requireEnv("GOOGLE_CLIENT_SECRET");
}
export function googleRedirectUri(): string {
  return requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
}

/**
 * URL do consent screen do Google.
 *
 * `access_type=offline` + `prompt=consent` garantem que sempre venha um
 * refresh_token (sem isso o Google só o devolve na primeira autorização).
 * `state` carrega o user_id (assinado/opaco do lado do app) para amarrar o
 * callback ao usuário logado.
 */
export function buildConsentUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", googleClientId());
  url.searchParams.set("redirect_uri", googleRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

/** Troca o authorization code por access_token + refresh_token. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google token exchange failed: ${data.error ?? res.status} ${
        data.error_description ?? ""
      }`.trim(),
    );
  }
  if (!data.refresh_token) {
    // Sem offline/consent, ou re-autorização sem prompt — não dá pra criar o
    // calendar no Recall (refresh_token é obrigatório).
    throw new Error(
      "Google did not return a refresh_token. Ensure access_type=offline & prompt=consent.",
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 0,
  };
}

/** Busca o e-mail da conta autorizada (chave de dedup do calendar). */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as { email?: string };
  if (!res.ok || !data.email) {
    throw new Error(`Google userinfo failed: ${res.status}`);
  }
  return data.email;
}
